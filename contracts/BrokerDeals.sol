// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GrantVault} from "./GrantVault.sol";
import {TokenMoves} from "./TokenMoves.sol";

/// @notice Escrows a seller's allocation and settles signed broker terms for one designated buyer.
contract BrokerDeals {
    struct BrokerTerms {
        address seller;
        address buyer;
        address baseToken;
        address quoteToken;
        uint256 allocation;
        uint256 quote;
        uint64 expiry;
        uint256 nonce;
        uint8 delivery;
        uint64 fixedStart;
        uint64 cliffSeconds;
        uint64 durationSeconds;
        address broker;
        uint16 brokerBps;
    }

    struct Grant {
        address token;
        address beneficiary;
        address custodian;
        uint256 allocation;
        uint64 start;
        uint64 cliff;
        uint64 end;
        uint256 claimed;
    }

    enum Status { Unfunded, Funded, Settled, Refunded }

    struct Deal {
        BrokerTerms terms;
        Status status;
        uint256 grantId;
    }

    event BrokerDealFunded(bytes32 indexed dealId, address indexed seller, address indexed broker);
    event BrokerDealSettled(
        bytes32 indexed dealId,
        address indexed buyer,
        uint256 buyerFee,
        uint256 sellerFee,
        uint256 brokerFee,
        uint256 treasuryFee,
        uint256 grantId
    );
    event BrokerDealBuyer(bytes32 indexed dealId, address indexed buyer);
    event BrokerDealRefunded(bytes32 indexed dealId);
    event BrokerGrantClaimed(uint256 indexed grantId, address indexed beneficiary, uint256 amount);

    error InvalidTreasury();
    error InvalidParties();
    error InvalidTokens();
    error InvalidAmounts();
    error InvalidBrokerShare();
    error InvalidSchedule();
    error Expired();
    error FixedStartPassed();
    error WrongCaller(address expected);
    error InvalidSignature();
    error NonceUsed(address seller, uint256 nonce);
    error DealNotFunded(bytes32 dealId);
    error NothingToClaim(uint256 grantId);
    error Reentered();

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("OTC.fam Broker Deals");
    bytes32 private constant VERSION_HASH = keccak256("3");
    bytes32 private constant TERMS_TYPEHASH = keccak256(
        "BrokerTerms(address seller,address buyer,address baseToken,address quoteToken,uint256 allocation,uint256 quote,uint64 expiry,uint256 nonce,uint8 delivery,uint64 fixedStart,uint64 cliffSeconds,uint64 durationSeconds,address broker,uint16 brokerBps)"
    );
    uint256 private constant HALF_CURVE_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 private constant BPS = 10_000;
    uint8 private constant IMMEDIATE = 0;
    uint8 private constant NEW_VESTING = 1;

    address public immutable treasury;
    mapping(address seller => mapping(uint256 nonce => bool used)) public usedNonce;
    mapping(bytes32 dealId => Deal) private deals;
    mapping(uint256 grantId => Grant) private grants;
    uint256 private lastGrantId;
    bool private transient locked;

    modifier nonReentrant() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    constructor(address treasury_) {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        treasury = treasury_;
    }

    function fund(BrokerTerms calldata terms, bytes calldata sellerSignature) external nonReentrant {
        if (msg.sender != terms.seller) revert WrongCaller(terms.seller);
        _validate(terms);
        if (usedNonce[terms.seller][terms.nonce]) revert NonceUsed(terms.seller, terms.nonce);
        bytes32 dealId = hashTerms(terms);
        _requireSignature(dealId, terms.seller, sellerSignature);

        usedNonce[terms.seller][terms.nonce] = true;
        deals[dealId] = Deal(terms, Status.Funded, 0);
        TokenMoves.take(terms.baseToken, terms.seller, terms.allocation);
        emit BrokerDealFunded(dealId, terms.seller, terms.broker);
        emit BrokerDealBuyer(dealId, terms.buyer);
    }

    function settle(bytes32 dealId, bytes calldata buyerSignature) external nonReentrant {
        Deal storage deal = _fundedDeal(dealId);
        BrokerTerms storage terms = deal.terms;
        if (msg.sender != terms.buyer) revert WrongCaller(terms.buyer);
        if (block.timestamp >= terms.expiry) revert Expired();
        _requireSignature(dealId, terms.buyer, buyerSignature);

        deal.status = Status.Settled;
        address recipient = terms.buyer;
        if (terms.delivery == NEW_VESTING) {
            (deal.grantId, recipient) = _createGrant(terms);
        }
        (uint256 fee, uint256 brokerFee, uint256 treasuryFee) = _fees(terms.quote, terms.brokerBps);
        TokenMoves.take(terms.quoteToken, terms.buyer, terms.quote + fee);
        TokenMoves.give(terms.quoteToken, terms.seller, terms.quote - fee);
        if (brokerFee != 0) TokenMoves.give(terms.quoteToken, terms.broker, brokerFee);
        if (treasuryFee != 0) TokenMoves.give(terms.quoteToken, treasury, treasuryFee);
        TokenMoves.give(terms.baseToken, recipient, terms.allocation);

        emit BrokerDealSettled(dealId, terms.buyer, fee, fee, brokerFee, treasuryFee, deal.grantId);
    }

    function refund(bytes32 dealId) external nonReentrant {
        Deal storage deal = _fundedDeal(dealId);
        BrokerTerms storage terms = deal.terms;
        if (msg.sender != terms.seller) revert WrongCaller(terms.seller);

        deal.status = Status.Refunded;
        TokenMoves.send(terms.baseToken, terms.seller, terms.allocation);
        emit BrokerDealRefunded(dealId);
    }

    function claim(uint256 grantId) external nonReentrant {
        Grant storage grant = grants[grantId];
        if (msg.sender != grant.beneficiary) revert WrongCaller(grant.beneficiary);
        uint256 amount = _vested(grant) - grant.claimed;
        if (amount == 0) revert NothingToClaim(grantId);

        grant.claimed += amount;
        GrantVault(grant.custodian).pay(amount);
        emit BrokerGrantClaimed(grantId, grant.beneficiary, amount);
    }

    function getDeal(bytes32 dealId) external view returns (BrokerTerms memory terms, uint8 status, uint256 grantId) {
        Deal storage deal = deals[dealId];
        return (deal.terms, uint8(deal.status), deal.grantId);
    }

    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return grants[grantId];
    }

    function claimable(uint256 grantId) external view returns (uint256) {
        Grant storage grant = grants[grantId];
        return _vested(grant) - grant.claimed;
    }

    function hashTerms(BrokerTerms calldata terms) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        bytes32 structHash = keccak256(abi.encode(TERMS_TYPEHASH, terms));
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }

    function _fundedDeal(bytes32 dealId) private view returns (Deal storage deal) {
        deal = deals[dealId];
        if (deal.status != Status.Funded) revert DealNotFunded(dealId);
    }

    function _validate(BrokerTerms calldata terms) private view {
        if (
            terms.buyer == address(0) || terms.buyer == terms.seller ||
            terms.broker == address(0) || terms.broker == address(this) ||
            terms.broker == terms.seller || terms.broker == terms.buyer
        ) revert InvalidParties();
        if (
            terms.baseToken == terms.quoteToken ||
            terms.baseToken.code.length == 0 || terms.quoteToken.code.length == 0
        ) revert InvalidTokens();
        if (
            terms.allocation == 0 || terms.quote == 0 ||
            terms.quote > type(uint256).max - _partyFee(terms.quote)
        ) revert InvalidAmounts();
        if (terms.brokerBps > BPS) revert InvalidBrokerShare();
        if (block.timestamp >= terms.expiry) revert Expired();

        if (terms.delivery == IMMEDIATE) {
            if (terms.fixedStart != 0 || terms.cliffSeconds != 0 || terms.durationSeconds != 0) {
                revert InvalidSchedule();
            }
            return;
        }
        if (terms.delivery != NEW_VESTING || terms.cliffSeconds >= terms.durationSeconds) revert InvalidSchedule();
        if (terms.fixedStart != 0 && terms.fixedStart <= block.timestamp) revert FixedStartPassed();
        uint256 latestStart = terms.fixedStart == 0 ? terms.expiry : terms.fixedStart;
        if (latestStart + terms.durationSeconds > type(uint64).max) revert InvalidSchedule();
    }

    function _createGrant(BrokerTerms storage terms) private returns (uint256 grantId, address vault) {
        uint64 start = terms.fixedStart == 0 ? uint64(block.timestamp) : terms.fixedStart;
        if (start < block.timestamp) revert FixedStartPassed();
        grantId = ++lastGrantId;
        vault = address(new GrantVault(terms.baseToken, terms.buyer));
        grants[grantId] = Grant({
            token: terms.baseToken,
            beneficiary: terms.buyer,
            custodian: vault,
            allocation: terms.allocation,
            start: start,
            cliff: start + terms.cliffSeconds,
            end: start + terms.durationSeconds,
            claimed: 0
        });
    }

    function _vested(Grant storage grant) private view returns (uint256) {
        if (block.timestamp < grant.cliff) return 0;
        if (block.timestamp >= grant.end) return grant.allocation;
        return _floorRatio(grant.allocation, block.timestamp - grant.start, grant.end - grant.start);
    }

    function _fees(uint256 quote, uint16 brokerBps) private pure returns (
        uint256 fee, uint256 brokerFee, uint256 treasuryFee
    ) {
        fee = _partyFee(quote);
        uint256 pool = fee + fee;
        brokerFee = _floorRatio(pool, brokerBps, BPS);
        treasuryFee = pool - brokerFee;
    }

    function _partyFee(uint256 quote) private pure returns (uint256) {
        return quote / 200; // 50 basis points, rounded down before the pool is split.
    }

    /// @dev Computes floor(value * numerator / denominator) with numerator <= denominator <= uint64.max.
    function _floorRatio(uint256 value, uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return (value / denominator) * numerator + (value % denominator) * numerator / denominator;
    }

    function _requireSignature(bytes32 dealId, address expected, bytes calldata signature) private pure {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_CURVE_ORDER || (v != 27 && v != 28)) revert InvalidSignature();
        address signer = ecrecover(dealId, v, r, s);
        if (signer == address(0) || signer != expected) revert InvalidSignature();
    }
}
