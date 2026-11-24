// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOtcDealsV2} from "./IOtcDealsV2.sol";
import {GrantVault} from "./GrantVault.sol";
import {TokenMoves} from "./TokenMoves.sol";

/// @title OtcDealsV2: private OTC deals of otc.fam that deliver tokens at once or as a new vesting grant.
/// @notice The seller's `createDeal` moves the whole allocation into this contract, for one named buyer. The
/// buyer's `fill` settles the deal in one transaction: the buyer pays the quote plus the buyer fee, the seller
/// receives the quote minus the seller fee, the treasury receives both fees, and the allocation goes to the
/// buyer (immediate delivery) or into a new GrantVault that pays the buyer as the schedule vests (vesting
/// delivery). Either all of it happens or none. `cancel` gives a funded deal's allocation back to its seller,
/// and `claim` pays the buyer what has vested. Nothing else moves tokens.
/// @dev This is a new contract next to the round 1 OtcDeals, which keeps its own deals, has no fee, and is not
/// read or written from here. There is no owner, no upgrade and no pause; the treasury and the fee are fixed at
/// deployment. Every state change is written before a token moves, and a lock refuses any call back into
/// `createDeal`, `fill`, `cancel` or `claim` while one of them runs.
/// Not covered: a token whose balances change without a transfer (rebasing), or that can freeze an address,
/// can leave deals and grants in that same token unpaid or stuck. It cannot move any other token.
contract OtcDealsV2 is IOtcDealsV2 {
    error BadTreasury();
    error ZeroAmount();
    error QuoteTooLarge();
    error SameToken();
    error NotAToken(address token);
    error NoBuyer();
    error BuyerIsSeller();
    error ExpiryNotInFuture();
    error ScheduleOnImmediate();
    error BadSchedule();
    error StartNotInFuture();
    error ScheduleTooLong();
    error NotFunded(uint256 dealId);
    error DealExpired(uint256 dealId);
    error StartPassed(uint256 dealId);
    error NotBuyer(uint256 dealId, address buyer);
    error NotSeller(uint256 dealId);
    error NotBeneficiary(uint256 grantId);
    error NothingToClaim(uint256 grantId);
    error Reentered();

    /// Each side's fee, in hundredths of a percent of the quote: 50 is 0.5%.
    uint256 public constant FEE_BPS = 50;
    uint256 private constant BPS = 10_000;

    /// Where both fees of every settlement go. Fixed at deployment.
    address public immutable treasury;

    struct Deal {
        address seller;
        Status status;
        Terms terms;
    }

    /// The id of the last deal created; the first deal is 1.
    uint256 private lastId;
    mapping(uint256 => Deal) private deals;
    /// A deal's grant has the deal's own id, so a deal can never have two.
    mapping(uint256 => Grant) private grants;
    /// Set while createDeal, fill, cancel or claim runs: a call back into any of them fails.
    bool private transient locked;

    modifier oneAtATime() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    constructor(address treasury_) {
        if (treasury_ == address(0) || treasury_ == address(this)) revert BadTreasury();
        treasury = treasury_;
    }

    /// @notice Funds a deal: the caller, its seller, offers `terms.allocation` of `terms.baseToken` to
    /// `terms.buyer` for `terms.quote` of `terms.quoteToken` (plus fees), until `terms.expiry`. The caller must
    /// have approved this contract for the allocation: it is taken now and held until the deal is settled or
    /// cancelled. The terms never change afterwards.
    /// @dev Immediate delivery takes no schedule. Vesting delivery needs `0 <= cliffSeconds < durationSeconds`
    /// and a `fixedStart` that is zero (the grant starts when the deal is settled) or still in the future.
    function createDeal(Terms calldata terms) external oneAtATime returns (uint256 dealId) {
        if (terms.allocation == 0 || terms.quote == 0) revert ZeroAmount();
        (uint256 buyerFee,) = fees(terms.quote);
        if (terms.quote > type(uint256).max - buyerFee) revert QuoteTooLarge();
        if (terms.baseToken == terms.quoteToken) revert SameToken();
        if (terms.baseToken.code.length == 0) revert NotAToken(terms.baseToken);
        if (terms.quoteToken.code.length == 0) revert NotAToken(terms.quoteToken);
        if (terms.buyer == address(0)) revert NoBuyer();
        if (terms.buyer == msg.sender) revert BuyerIsSeller();
        if (terms.expiry <= block.timestamp) revert ExpiryNotInFuture();
        if (terms.delivery == Delivery.Immediate) {
            if (terms.fixedStart != 0 || terms.cliffSeconds != 0 || terms.durationSeconds != 0) revert ScheduleOnImmediate();
        } else {
            if (terms.cliffSeconds >= terms.durationSeconds) revert BadSchedule();
            if (terms.fixedStart != 0 && terms.fixedStart <= block.timestamp) revert StartNotInFuture();
            // The latest the grant can start: its fixed start, or a settlement in the last second before the expiry.
            uint256 latestStart = terms.fixedStart != 0 ? terms.fixedStart : terms.expiry;
            if (latestStart + terms.durationSeconds > type(uint64).max) revert ScheduleTooLong();
        }

        dealId = ++lastId;
        deals[dealId] = Deal(msg.sender, Status.Funded, terms);
        emit DealFunded(dealId, msg.sender, terms.buyer);

        TokenMoves.take(terms.baseToken, msg.sender, terms.allocation);
    }

    /// @notice Settles deal `dealId`, called by its buyer, who must have approved this contract for the quote
    /// plus the buyer fee. In this one transaction the buyer pays, the seller and the treasury are paid, and the
    /// allocation is delivered: to the buyer, or into a new vault that holds all of it for the buyer's grant.
    /// If any part fails, nothing moves and the deal is still funded: it can be settled later, or cancelled.
    /// @dev A grant never starts before it is funded: a deal whose fixed start has passed can no longer be
    /// settled, only cancelled.
    function fill(uint256 dealId) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotFunded(dealId);
        Terms memory terms = deal.terms;
        if (block.timestamp >= terms.expiry) revert DealExpired(dealId);
        if (msg.sender != terms.buyer) revert NotBuyer(dealId, terms.buyer);

        (uint256 buyerFee, uint256 sellerFee) = fees(terms.quote);
        address recipient = terms.buyer;
        uint256 grantId;
        deal.status = Status.Settled;
        if (terms.delivery == Delivery.NewVesting) {
            uint64 start = terms.fixedStart == 0 ? uint64(block.timestamp) : terms.fixedStart;
            if (start < block.timestamp) revert StartPassed(dealId);
            grantId = dealId;
            recipient = address(new GrantVault(terms.baseToken, terms.buyer));
            grants[grantId] = Grant(dealId, terms.baseToken, terms.buyer, recipient, terms.allocation, start, start + terms.cliffSeconds, start + terms.durationSeconds, 0);
            emit GrantCreated(grantId, dealId, terms.buyer);
        }
        emit DealSettled(dealId, grantId, buyerFee, sellerFee);

        TokenMoves.take(terms.quoteToken, terms.buyer, terms.quote + buyerFee);
        TokenMoves.give(terms.quoteToken, deal.seller, terms.quote - sellerFee);
        if (buyerFee + sellerFee != 0) TokenMoves.give(terms.quoteToken, treasury, buyerFee + sellerFee);
        TokenMoves.give(terms.baseToken, recipient, terms.allocation);
    }

    /// @notice Withdraws deal `dealId`, funded or expired, and returns its allocation to the seller, its only
    /// caller. A settled deal cannot be cancelled. No fee is taken.
    function cancel(uint256 dealId) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotFunded(dealId);
        if (msg.sender != deal.seller) revert NotSeller(dealId);

        deal.status = Status.Cancelled;
        emit DealCancelled(dealId);

        TokenMoves.send(deal.terms.baseToken, deal.seller, deal.terms.allocation);
    }

    /// @notice Pays grant `grantId`'s beneficiary everything that has vested and was not claimed yet. Only the
    /// beneficiary calls it, and the tokens only ever go to the beneficiary. No fee is taken.
    function claim(uint256 grantId) external oneAtATime {
        Grant storage grant = grants[grantId];
        if (msg.sender != grant.beneficiary) revert NotBeneficiary(grantId);
        uint256 amount = vested(grantId) - grant.claimed;
        if (amount == 0) revert NothingToClaim(grantId);

        grant.claimed += amount;
        emit GrantClaimed(grantId, grant.beneficiary, amount);

        GrantVault(grant.custodian).pay(amount);
    }

    /// @notice Deal `dealId` as it stands; for an id no deal has, zeros with status None. `grantId` is zero
    /// unless the deal was settled into a vesting grant.
    function getDeal(uint256 dealId) external view returns (address seller, Terms memory terms, Status status, uint256 grantId) {
        Deal storage deal = deals[dealId];
        (seller, terms, status) = (deal.seller, deal.terms, deal.status);
        if (grants[dealId].custodian != address(0)) grantId = dealId;
    }

    /// @notice Grant `grantId` as it stands; for an id no grant has, zeros. `custodian` is the grant's vault.
    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return grants[grantId];
    }

    /// @notice How much of grant `grantId` has vested at the current block's time: nothing before the cliff,
    /// then floor(allocation * (time - start) / (end - start)), and the whole allocation from the end on.
    /// Accrual counts from the start, so the cliff releases what accrued until then.
    function vested(uint256 grantId) public view returns (uint256) {
        Grant storage grant = grants[grantId];
        if (block.timestamp < grant.cliff) return 0;
        if (block.timestamp >= grant.end) return grant.allocation;
        return _mulDiv(grant.allocation, block.timestamp - grant.start, grant.end - grant.start);
    }

    /// @notice What grant `grantId`'s beneficiary can claim now: vested minus already claimed.
    function claimable(uint256 grantId) external view returns (uint256) {
        return vested(grantId) - grants[grantId].claimed;
    }

    /// @notice The two fees of a settlement at `quote`, in the quote token's smallest unit, each rounded down:
    /// the buyer pays `quote + buyerFee`, the seller receives `quote - sellerFee`, the treasury receives both.
    function fees(uint256 quote) public pure returns (uint256 buyerFee, uint256 sellerFee) {
        buyerFee = _mulDiv(quote, FEE_BPS, BPS);
        sellerFee = buyerFee;
    }

    /// floor(a * b / d) for b <= d < 2^128, without overflow whatever `a` is: with a = q * d + r, it is
    /// q * b + floor(r * b / d), where q * b <= a and r * b < d * d.
    function _mulDiv(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        return (a / d) * b + (a % d) * b / d;
    }
}
