// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBrokerDeals} from "./IBrokerDeals.sol";
import {GrantVault} from "./GrantVault.sol";
import {TokenMoves} from "./TokenMoves.sol";

/// @title BrokerDeals: private OTC deals of otc.fam that a broker prepares and the two parties sign (version 3).
/// @notice A broker writes the terms of a deal down and passes them on; that gives nobody any authority. The
/// terms name the seller, the buyer, both tokens and raw amounts, the expiry, a nonce, the delivery and its
/// schedule, and the broker with its share of the fees. The deal's id is the EIP-712 digest of those terms for
/// this contract on this chain, so an id stands for exactly one set of terms in exactly one place.
/// `fund`: the seller sends its signature of the terms, and the whole allocation moves into this contract.
/// `settle`: the named buyer sends its signature of the same terms. In that one transaction the buyer pays the
/// quote plus the buyer fee, the seller receives the quote minus the seller fee, the broker receives its share
/// of both fees and the treasury the rest, and the allocation goes to the buyer (immediate delivery) or into a
/// new GrantVault that pays the buyer as the schedule vests (vesting delivery). Either all of it happens or none.
/// `refund` gives a funded deal's allocation back to its seller, and `claim` pays a grant's beneficiary what has
/// vested. Nothing else moves tokens, and the broker is paid by a settlement only.
/// @dev A third contract next to OtcDeals (round 1) and OtcDealsV2 (round 2): it reads and writes neither, and
/// shares only the TokenMoves library and the GrantVault contract with version 2. There is no owner, no upgrade
/// and no pause; the treasury and the fee are fixed at deployment. Each call needs both the right sender and that
/// sender's signature: a signature alone cannot be sent by anyone else, and a transaction alone commits to no
/// terms. Every state change is written before a token moves, and a lock refuses any call back into `fund`,
/// `settle`, `refund` or `claim` while one of them runs.
/// Not covered: signatures of contract wallets (ERC-1271) are not accepted, only those of a key. A token whose
/// balances change without a transfer (rebasing), or that can freeze an address, can leave deals and grants in
/// that same token unpaid or stuck. It cannot move any other token.
contract BrokerDeals is IBrokerDeals {
    error BadTreasury();
    error ZeroAmount();
    error QuoteTooLarge();
    error SameToken();
    error NotAToken(address token);
    error NoBuyer();
    error BuyerIsSeller();
    error BadBroker();
    error BrokerShareTooLarge();
    error ExpiryNotInFuture();
    error BadDelivery();
    error ScheduleOnImmediate();
    error BadSchedule();
    error StartNotInFuture();
    error ScheduleTooLong();
    error NonceUsed(address seller, uint256 nonce);
    error BadSignature(address signer);
    error NotFunded(bytes32 dealId);
    error DealExpired(bytes32 dealId);
    error StartPassed(bytes32 dealId);
    error NotSeller(address seller);
    error NotBuyer(address buyer);
    error NotBeneficiary(uint256 grantId);
    error NothingToClaim(uint256 grantId);
    error Reentered();

    /// Not part of IBrokerDeals: emitted with BrokerDealFunded, which names the seller and the broker, so that the
    /// buyer too can find the deals that wait for it.
    event BrokerDealOffered(bytes32 indexed dealId, address indexed buyer);
    /// Not part of IBrokerDeals: a claim's own record, for receipts.
    event GrantClaimed(uint256 indexed grantId, address indexed beneficiary, uint256 amount);

    /// Each side's fee, in hundredths of a percent of the quote: 50 is 0.5%.
    uint256 public constant FEE_BPS = 50;
    uint256 private constant BPS = 10_000;

    uint8 private constant UNFUNDED = 0;
    uint8 private constant FUNDED = 1;
    uint8 private constant SETTLED = 2;
    uint8 private constant REFUNDED = 3;
    uint8 private constant IMMEDIATE = 0;
    uint8 private constant NEW_VESTING = 1;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// The fields of IBrokerDeals.BrokerTerms, with their names, types and order.
    bytes32 private constant TERMS_TYPEHASH = keccak256(
        "BrokerTerms(address seller,address buyer,address baseToken,address quoteToken,uint256 allocation,uint256 quote,uint64 expiry,uint256 nonce,uint8 delivery,uint64 fixedStart,uint64 cliffSeconds,uint64 durationSeconds,address broker,uint16 brokerBps)"
    );
    /// The largest `s` of a signature: the other half of the curve's order signs the same message again.
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// Where the fees the broker does not receive go. Fixed at deployment.
    address public immutable treasury;

    struct Deal {
        BrokerTerms terms;
        uint8 status;
        uint256 grantId;
    }

    mapping(bytes32 => Deal) private deals;
    /// Whether `seller` has funded a deal with `nonce`: a seller uses a nonce once, whatever became of the deal.
    mapping(address seller => mapping(uint256 nonce => bool)) public nonceUsed;
    /// The id of the last grant made; the first grant is 1, and 0 means "no grant".
    uint256 private lastGrantId;
    mapping(uint256 => Grant) private grants;
    /// Set while fund, settle, refund or claim runs: a call back into any of them fails.
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

    /// @notice Funds the deal of `terms`, called by its seller with the seller's EIP-712 signature of them. The
    /// seller must have approved this contract for the allocation: it is taken now and held until the deal is
    /// settled or refunded. The terms never change afterwards, and the seller's nonce is spent.
    /// @dev The buyer, the seller and the broker are three different addresses. Immediate delivery takes no
    /// schedule. Vesting delivery needs `0 <= cliffSeconds < durationSeconds` and a `fixedStart` that is zero
    /// (the grant starts when the deal is settled) or still in the future.
    function fund(BrokerTerms calldata terms, bytes calldata sellerSignature) external oneAtATime {
        if (msg.sender != terms.seller) revert NotSeller(terms.seller);
        _check(terms);
        if (nonceUsed[terms.seller][terms.nonce]) revert NonceUsed(terms.seller, terms.nonce);
        bytes32 dealId = dealIdOf(terms);
        if (!_signed(terms.seller, dealId, sellerSignature)) revert BadSignature(terms.seller);

        nonceUsed[terms.seller][terms.nonce] = true;
        Deal storage deal = deals[dealId];
        deal.terms = terms;
        deal.status = FUNDED;
        emit BrokerDealFunded(dealId, terms.seller, terms.broker);
        emit BrokerDealOffered(dealId, terms.buyer);

        TokenMoves.take(terms.baseToken, terms.seller, terms.allocation);
    }

    /// @notice Settles deal `dealId`, called by its buyer with the buyer's EIP-712 signature of the deal's terms.
    /// The buyer must have approved this contract for the quote plus the buyer fee. In this one transaction the
    /// buyer pays, the seller, the broker and the treasury are paid, and the allocation is delivered: to the
    /// buyer, or into a new vault that holds all of it for the buyer's grant. If any part fails, nothing moves,
    /// no fee is paid and the deal is still funded: it can be settled later, or refunded.
    /// @dev A grant never starts before it is funded: a deal whose fixed start has passed can no longer be
    /// settled, only refunded.
    function settle(bytes32 dealId, bytes calldata buyerSignature) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != FUNDED) revert NotFunded(dealId);
        BrokerTerms memory terms = deal.terms;
        if (block.timestamp >= terms.expiry) revert DealExpired(dealId);
        if (msg.sender != terms.buyer) revert NotBuyer(terms.buyer);
        if (!_signed(terms.buyer, dealId, buyerSignature)) revert BadSignature(terms.buyer);

        deal.status = SETTLED;
        address recipient = terms.buyer;
        uint256 grantId;
        if (terms.delivery == NEW_VESTING) {
            (grantId, recipient) = _openGrant(dealId, terms);
            deal.grantId = grantId;
        }
        _exchange(dealId, terms, recipient, grantId);
    }

    /// @notice Withdraws deal `dealId`, funded or expired, and returns its allocation to the seller, its only
    /// caller. A settled deal cannot be refunded. No fee is taken and the broker receives nothing.
    function refund(bytes32 dealId) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != FUNDED) revert NotFunded(dealId);
        address seller = deal.terms.seller;
        if (msg.sender != seller) revert NotSeller(seller);

        deal.status = REFUNDED;
        emit BrokerDealRefunded(dealId);

        TokenMoves.send(deal.terms.baseToken, seller, deal.terms.allocation);
    }

    /// @notice Pays grant `grantId`'s beneficiary everything that has vested and was not claimed yet. Only the
    /// beneficiary calls it, and the tokens only ever go to the beneficiary. No fee is taken and the broker
    /// receives nothing.
    function claim(uint256 grantId) external oneAtATime {
        Grant storage grant = grants[grantId];
        if (msg.sender != grant.beneficiary) revert NotBeneficiary(grantId);
        uint256 amount = vested(grantId) - grant.claimed;
        if (amount == 0) revert NothingToClaim(grantId);

        grant.claimed += amount;
        emit GrantClaimed(grantId, grant.beneficiary, amount);

        GrantVault(grant.custodian).pay(amount);
    }

    /// @notice Deal `dealId` as it stands: its terms once funded, its status (0 unfunded, 1 funded, 2 settled,
    /// 3 refunded) and its grant, zero unless it was settled into one. For an id no deal has: zeros.
    function getDeal(bytes32 dealId) external view returns (BrokerTerms memory terms, uint8 status, uint256 grantId) {
        Deal storage deal = deals[dealId];
        return (deal.terms, deal.status, deal.grantId);
    }

    /// @notice Grant `grantId` as it stands; for an id no grant has, zeros. `custodian` is the grant's vault.
    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return grants[grantId];
    }

    /// @notice The id of the deal of `terms` here: the EIP-712 digest that both the seller and the buyer sign,
    /// under the domain "OTC.fam Broker Deals", version "3", this chain and this contract.
    function dealIdOf(BrokerTerms calldata terms) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(TERMS_TYPEHASH, terms))));
    }

    /// @notice The EIP-712 domain separator of this contract on the chain it runs on now.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OTC.fam Broker Deals"), keccak256("3"), block.chainid, address(this)));
    }

    /// @notice The fees of a settlement at `quote` with a broker share of `brokerBps`, in the quote token's
    /// smallest unit. Each side's fee is 0.5% of the quote, rounded down on its own: the buyer pays
    /// `quote + buyerFee` and the seller receives `quote - sellerFee`. Of the two fees together the broker
    /// receives `brokerBps` hundredths of a percent, rounded down, and the treasury the rest.
    function feesOf(uint256 quote, uint16 brokerBps) public pure returns (uint256 buyerFee, uint256 sellerFee, uint256 brokerFee, uint256 treasuryFee) {
        if (brokerBps > BPS) revert BrokerShareTooLarge();
        buyerFee = _mulDiv(quote, FEE_BPS, BPS);
        sellerFee = buyerFee;
        brokerFee = _mulDiv(buyerFee + sellerFee, brokerBps, BPS);
        treasuryFee = buyerFee + sellerFee - brokerFee;
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

    /// Refuses terms that could not be settled as written.
    function _check(BrokerTerms calldata terms) private view {
        if (terms.allocation == 0 || terms.quote == 0) revert ZeroAmount();
        if (terms.quote > type(uint256).max - _mulDiv(terms.quote, FEE_BPS, BPS)) revert QuoteTooLarge();
        if (terms.baseToken == terms.quoteToken) revert SameToken();
        if (terms.baseToken.code.length == 0) revert NotAToken(terms.baseToken);
        if (terms.quoteToken.code.length == 0) revert NotAToken(terms.quoteToken);
        if (terms.buyer == address(0)) revert NoBuyer();
        if (terms.buyer == terms.seller) revert BuyerIsSeller();
        // A broker stands between the two parties: it is neither of them, and never this contract, which could not pass its share on.
        if (terms.broker == address(0) || terms.broker == terms.seller || terms.broker == terms.buyer || terms.broker == address(this)) revert BadBroker();
        if (terms.brokerBps > BPS) revert BrokerShareTooLarge();
        if (terms.expiry <= block.timestamp) revert ExpiryNotInFuture();
        if (terms.delivery == IMMEDIATE) {
            if (terms.fixedStart != 0 || terms.cliffSeconds != 0 || terms.durationSeconds != 0) revert ScheduleOnImmediate();
        } else if (terms.delivery == NEW_VESTING) {
            if (terms.cliffSeconds >= terms.durationSeconds) revert BadSchedule();
            if (terms.fixedStart != 0 && terms.fixedStart <= block.timestamp) revert StartNotInFuture();
            // The latest the grant can start: its fixed start, or a settlement in the last second before the expiry.
            uint256 latestStart = terms.fixedStart != 0 ? terms.fixedStart : terms.expiry;
            if (latestStart + terms.durationSeconds > type(uint64).max) revert ScheduleTooLong();
        } else {
            revert BadDelivery();
        }
    }

    /// Makes the grant of deal `dealId` and its vault, which `_exchange` then funds with the whole allocation.
    function _openGrant(bytes32 dealId, BrokerTerms memory terms) private returns (uint256 grantId, address vault) {
        uint64 start = terms.fixedStart == 0 ? uint64(block.timestamp) : terms.fixedStart;
        if (start < block.timestamp) revert StartPassed(dealId);
        grantId = ++lastGrantId;
        vault = address(new GrantVault(terms.baseToken, terms.buyer));
        grants[grantId] = Grant(terms.baseToken, terms.buyer, vault, terms.allocation, start, start + terms.cliffSeconds, start + terms.durationSeconds, 0);
    }

    /// The payment, both fees and the delivery of a settlement, each exact on both sides or the whole call reverts.
    function _exchange(bytes32 dealId, BrokerTerms memory terms, address recipient, uint256 grantId) private {
        (uint256 buyerFee, uint256 sellerFee, uint256 brokerFee, uint256 treasuryFee) = feesOf(terms.quote, terms.brokerBps);
        emit BrokerDealSettled(dealId, terms.buyer, buyerFee, sellerFee, brokerFee, treasuryFee, grantId);

        TokenMoves.take(terms.quoteToken, terms.buyer, terms.quote + buyerFee);
        TokenMoves.give(terms.quoteToken, terms.seller, terms.quote - sellerFee);
        if (brokerFee != 0) TokenMoves.give(terms.quoteToken, terms.broker, brokerFee);
        if (treasuryFee != 0) TokenMoves.give(terms.quoteToken, treasury, treasuryFee);
        TokenMoves.give(terms.baseToken, recipient, terms.allocation);
    }

    /// Whether `signature` is `signer`'s signature of `digest`: 65 bytes (r, s, v), with `s` in the lower half
    /// of the curve's order: its mirror in the upper half, which signs the same digest, is refused.
    function _signed(address signer, bytes32 digest, bytes calldata signature) private pure returns (bool) {
        if (signature.length != 65) return false;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27; // some signers answer 0 or 1
        if (uint256(s) > HALF_ORDER) return false;
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == signer;
    }

    /// floor(a * b / d) for b <= d < 2^128, without overflow whatever `a` is: with a = q * d + r, it is
    /// q * b + floor(r * b / d), where q * b <= a and r * b < d * d.
    function _mulDiv(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        return (a / d) * b + (a % d) * b / d;
    }
}
