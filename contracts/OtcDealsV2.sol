// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Minimal} from "./OtcDeals.sol";
import {IOtcDealsV2} from "./IOtcDealsV2.sol";

/// @notice Seller-funded swaps with an immutable treasury and optional nontransferable vesting.
/// @dev The escrow is also the vesting vault. Setting a grant's terms assigns its backing in place.
contract OtcDealsV2 is IOtcDealsV2 {
    error InvalidTreasury();
    error InvalidBuyer();
    error InvalidSchedule();
    error FixedStartReached();
    error QuoteTooLarge();
    error InsufficientBacking(address token);
    error NothingToClaim();
    error ZeroAmount();
    error SameToken();
    error ExpiryNotInFuture();
    error NotAToken(address token);
    error NotOpen(uint256 id);
    error DealExpired(uint256 id);
    error NotYourDeal(uint256 id, address buyer);
    error NotMaker(uint256 id);
    error TransferFailed(address token);
    error InexactTransfer(address token);
    error Reentered();

    struct Deal {
        address seller;
        Terms terms;
        Status status;
        uint256 grantId;
    }

    uint256 private lastId;
    address public immutable treasury;
    mapping(uint256 => Deal) private deals;
    mapping(uint256 => Grant) private grants;
    // Funded deals plus the unpaid portion of settled grants, tracked separately for each token.
    mapping(address => uint256) private reserved;
    bool private transient locked;

    constructor(address treasury_) {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        treasury = treasury_;
    }

    modifier oneAtATime() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    function createDeal(Terms calldata terms) external oneAtATime returns (uint256 dealId) {
        if (terms.buyer == address(0) || terms.buyer == msg.sender || terms.buyer == address(this)) {
            revert InvalidBuyer();
        }
        if (terms.allocation == 0 || terms.quote == 0) revert ZeroAmount();
        if (terms.quote > type(uint256).max - _fee(terms.quote)) revert QuoteTooLarge();
        if (terms.expiry <= block.timestamp) revert ExpiryNotInFuture();
        if (terms.baseToken == terms.quoteToken) revert SameToken();
        if (terms.baseToken.code.length == 0) revert NotAToken(terms.baseToken);
        if (terms.quoteToken.code.length == 0) revert NotAToken(terms.quoteToken);
        _validateSchedule(terms);

        dealId = ++lastId;
        deals[dealId] = Deal(msg.sender, terms, Status.Funded, 0);
        _requireBacking(terms.baseToken);
        _move(terms.baseToken, msg.sender, address(this), terms.allocation);
        reserved[terms.baseToken] += terms.allocation;
        emit DealFunded(dealId, msg.sender, terms.buyer);
    }

    function fill(uint256 dealId) external oneAtATime {
        Deal storage deal = deals[dealId];
        Terms memory terms = deal.terms;
        if (deal.status != Status.Funded) revert NotOpen(dealId);
        if (block.timestamp >= terms.expiry) revert DealExpired(dealId);
        if (msg.sender != terms.buyer) revert NotYourDeal(dealId, terms.buyer);
        _requireBacking(terms.baseToken);

        deal.status = Status.Settled;
        if (terms.delivery == Delivery.NewVesting) {
            if (terms.fixedStart != 0 && terms.fixedStart <= block.timestamp) revert FixedStartReached();
            uint64 start = terms.fixedStart == 0 ? uint64(block.timestamp) : terms.fixedStart;
            deal.grantId = dealId;
            grants[dealId] = Grant({
                dealId: dealId, token: terms.baseToken, beneficiary: terms.buyer,
                custodian: address(this), allocation: terms.allocation, start: start,
                cliff: start + terms.cliffSeconds, end: start + terms.durationSeconds, claimed: 0
            });
            emit GrantCreated(dealId, dealId, terms.buyer);
        }

        uint256 fee = _fee(terms.quote);
        _move(terms.quoteToken, terms.buyer, address(this), terms.quote + fee);
        _move(terms.quoteToken, address(this), deal.seller, terms.quote - fee);
        if (fee != 0) _move(terms.quoteToken, address(this), treasury, fee * 2);
        if (terms.delivery == Delivery.Immediate) {
            _release(terms.baseToken, terms.buyer, terms.allocation);
        } else {
            _requireBacking(terms.baseToken);
        }
        emit DealSettled(dealId, deal.grantId, fee, fee);
    }

    function cancel(uint256 dealId) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotOpen(dealId);
        if (deal.seller != msg.sender) revert NotMaker(dealId);

        deal.status = Status.Cancelled;
        _release(deal.terms.baseToken, deal.seller, deal.terms.allocation);
        emit DealCancelled(dealId);
    }

    function getDeal(uint256 dealId) external view returns (address, Terms memory, Status, uint256) {
        Deal storage deal = deals[dealId];
        return (deal.seller, deal.terms, deal.status, deal.grantId);
    }

    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return grants[grantId];
    }

    function vested(uint256 grantId) external view returns (uint256) {
        return _vested(grants[grantId]);
    }

    function claimable(uint256 grantId) external view returns (uint256) {
        Grant storage grant = grants[grantId];
        return _vested(grant) - grant.claimed;
    }

    /// @notice Anyone may trigger a positive claim. Only the recorded beneficiary receives the tokens.
    function claim(uint256 grantId) external oneAtATime {
        Grant storage grant = grants[grantId];
        uint256 totalVested = _vested(grant);
        uint256 payout = totalVested - grant.claimed;
        if (payout == 0) revert NothingToClaim();

        grant.claimed = totalVested;
        _release(grant.token, grant.beneficiary, payout);
        emit GrantClaimed(grantId, grant.beneficiary, payout);
    }

    function _fee(uint256 quote) private pure returns (uint256) {
        return quote / 200; // floor(quote * 50 / 10_000), without an overflowing product
    }

    function _validateSchedule(Terms calldata terms) private view {
        if (terms.delivery == Delivery.Immediate) {
            if (terms.fixedStart != 0 || terms.cliffSeconds != 0 || terms.durationSeconds != 0) {
                revert InvalidSchedule();
            }
            return;
        }
        if (terms.cliffSeconds >= terms.durationSeconds) revert InvalidSchedule();
        if (terms.fixedStart != 0 && terms.fixedStart <= block.timestamp) revert FixedStartReached();
        // Ensure the end fits for every legal fill, even in the last second before expiry.
        uint256 latestStart = terms.fixedStart == 0 ? terms.expiry - 1 : terms.fixedStart;
        if (latestStart + terms.durationSeconds > type(uint64).max) revert InvalidSchedule();
    }

    function _vested(Grant storage grant) private view returns (uint256) {
        uint256 timestamp = block.timestamp;
        if (timestamp < grant.cliff) return 0;
        uint256 allocation = grant.allocation;
        if (timestamp >= grant.end) return allocation;

        uint256 duration = grant.end - grant.start;
        uint256 elapsed = timestamp - grant.start;
        // Split the product by quotient and remainder. The first term is at most allocation;
        // both factors in the remainder product fit in 64 bits.
        return (allocation / duration) * elapsed + (allocation % duration) * elapsed / duration;
    }

    function _requireBacking(address token) private view {
        if (IERC20Minimal(token).balanceOf(address(this)) < reserved[token]) revert InsufficientBacking(token);
    }

    function _release(address token, address to, uint256 units) private {
        _requireBacking(token);
        reserved[token] -= units;
        _move(token, address(this), to, units);
    }

    function _move(address token, address from, address to, uint256 units) private {
        uint256 beforeFrom = IERC20Minimal(token).balanceOf(from);
        uint256 beforeTo = IERC20Minimal(token).balanceOf(to);
        bytes memory data = from == address(this)
            ? abi.encodeCall(IERC20Minimal.transfer, (to, units))
            : abi.encodeCall(IERC20Minimal.transferFrom, (from, to, units));
        (bool ok, bytes memory result) = token.call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || abi.decode(result, (uint256)) != 1))) {
            revert TransferFailed(token);
        }
        uint256 afterFrom = IERC20Minimal(token).balanceOf(from);
        uint256 afterTo = IERC20Minimal(token).balanceOf(to);
        if (afterFrom > beforeFrom || beforeFrom - afterFrom != units ||
            afterTo < beforeTo || afterTo - beforeTo != units) revert InexactTransfer(token);
    }
}
