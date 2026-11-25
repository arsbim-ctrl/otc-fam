// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBrokerDeals} from "./IBrokerDeals.sol";
import {GrantVault} from "./GrantVault.sol";
import {TokenMoves} from "./TokenMoves.sol";

/// @notice A private, signed V3 swap with an immutable treasury and no privileged broker actions.
contract BrokerDeals is IBrokerDeals {
    error InvalidTerms();
    error InvalidSignature();
    error WrongActor();
    error NonceUsed();
    error NotFunded();
    error DealExpired();
    error StartPassed();
    error NothingToClaim();
    error Reentered();

    event BrokerGrantClaimed(uint256 indexed grantId, address indexed beneficiary, uint256 amount);

    bytes32 private constant DOMAIN_TYPE = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant TERMS_TYPE = keccak256(
        "BrokerTerms(address seller,address buyer,address baseToken,address quoteToken,uint256 allocation,uint256 quote,uint64 expiry,uint256 nonce,uint8 delivery,uint64 fixedStart,uint64 cliffSeconds,uint64 durationSeconds,address broker,uint16 brokerBps)"
    );
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Deal {
        BrokerTerms terms;
        uint8 status;
        uint256 grantId;
    }

    address public immutable treasury;
    mapping(address => mapping(uint256 => bool)) public usedNonce;
    mapping(bytes32 => Deal) private deals;
    mapping(uint256 => Grant) private grants;
    uint256 private lastGrantId;
    bool private transient locked;

    constructor(address treasury_) {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTerms();
        treasury = treasury_;
    }

    modifier nonReentrant() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    function dealId(BrokerTerms calldata terms) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPE, keccak256("OTC.fam Broker Deals"), keccak256("3"), block.chainid, address(this)
        ));
        return keccak256(abi.encodePacked(hex"1901", domain, keccak256(abi.encode(TERMS_TYPE, terms))));
    }

    function fund(BrokerTerms calldata terms, bytes calldata signature) external nonReentrant {
        if (msg.sender != terms.seller) revert WrongActor();
        if (usedNonce[terms.seller][terms.nonce]) revert NonceUsed();
        _validate(terms);
        bytes32 id = dealId(terms);
        _authorize(id, terms.seller, signature);

        usedNonce[terms.seller][terms.nonce] = true;
        deals[id] = Deal(terms, 1, 0);
        TokenMoves.take(terms.baseToken, terms.seller, terms.allocation);
        emit BrokerDealFunded(id, terms.seller, terms.broker);
    }

    function settle(bytes32 id, bytes calldata signature) external nonReentrant {
        Deal storage deal = deals[id];
        BrokerTerms memory t = deal.terms;
        if (deal.status != 1) revert NotFunded();
        if (msg.sender != t.buyer) revert WrongActor();
        if (block.timestamp >= t.expiry) revert DealExpired();
        _authorize(id, t.buyer, signature);

        deal.status = 2;
        address recipient = t.buyer;
        if (t.delivery == 1) {
            uint64 start = t.fixedStart == 0 ? uint64(block.timestamp) : t.fixedStart;
            if (start < block.timestamp) revert StartPassed();
            deal.grantId = ++lastGrantId;
            recipient = address(new GrantVault(t.baseToken, t.buyer));
            grants[deal.grantId] = Grant(
                t.baseToken, t.buyer, recipient, t.allocation, start, start + t.cliffSeconds, start + t.durationSeconds, 0
            );
        }

        uint256 fee = t.quote / 200;
        uint256 brokerFee = _fraction(2 * fee, t.brokerBps, 10_000);
        uint256 treasuryFee = 2 * fee - brokerFee;

        TokenMoves.take(t.quoteToken, t.buyer, t.quote + fee);
        TokenMoves.give(t.quoteToken, t.seller, t.quote - fee);
        if (brokerFee != 0) TokenMoves.give(t.quoteToken, t.broker, brokerFee);
        if (treasuryFee != 0) TokenMoves.give(t.quoteToken, treasury, treasuryFee);
        TokenMoves.give(t.baseToken, recipient, t.allocation);
        emit BrokerDealSettled(id, t.buyer, fee, fee, brokerFee, treasuryFee, deal.grantId);
    }

    function refund(bytes32 id) external nonReentrant {
        Deal storage deal = deals[id];
        if (deal.status != 1) revert NotFunded();
        if (msg.sender != deal.terms.seller) revert WrongActor();
        deal.status = 3;
        TokenMoves.send(deal.terms.baseToken, deal.terms.seller, deal.terms.allocation);
        emit BrokerDealRefunded(id);
    }

    function getDeal(bytes32 id) external view returns (BrokerTerms memory terms, uint8 status, uint256 grantId) {
        Deal storage deal = deals[id];
        return (deal.terms, deal.status, deal.grantId);
    }

    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return grants[grantId];
    }

    function vested(uint256 grantId) public view returns (uint256) {
        Grant storage grant = grants[grantId];
        if (block.timestamp < grant.cliff) return 0;
        if (block.timestamp >= grant.end) return grant.allocation;
        return _fraction(grant.allocation, block.timestamp - grant.start, grant.end - grant.start);
    }

    function claim(uint256 grantId) external nonReentrant {
        Grant storage grant = grants[grantId];
        if (msg.sender != grant.beneficiary) revert WrongActor();
        uint256 amount = vested(grantId) - grant.claimed;
        if (amount == 0) revert NothingToClaim();
        grant.claimed += amount;
        GrantVault(grant.custodian).pay(amount);
        emit BrokerGrantClaimed(grantId, grant.beneficiary, amount);
    }

    function _validate(BrokerTerms calldata t) private view {
        if (
            t.buyer == address(0) || t.broker == address(0) ||
            t.buyer == t.seller || t.broker == t.seller || t.broker == t.buyer ||
            t.buyer == address(this) || t.broker == address(this) ||
            t.baseToken == t.quoteToken || t.baseToken.code.length == 0 || t.quoteToken.code.length == 0 ||
            t.allocation == 0 || t.quote == 0 || t.quote > type(uint256).max - t.quote / 200 ||
            t.brokerBps > 10_000 || t.delivery > 1
        ) revert InvalidTerms();
        if (t.expiry <= block.timestamp) revert DealExpired();
        if (t.delivery == 0) {
            if (t.fixedStart != 0 || t.cliffSeconds != 0 || t.durationSeconds != 0) revert InvalidTerms();
        } else {
            if (t.cliffSeconds >= t.durationSeconds) revert InvalidTerms();
            if (t.fixedStart != 0 && t.fixedStart <= block.timestamp) revert StartPassed();
            uint256 latestStart = t.fixedStart == 0 ? t.expiry - 1 : t.fixedStart;
            if (latestStart + t.durationSeconds > type(uint64).max) revert InvalidTerms();
        }
    }

    // Canonical EOA ECDSA signatures, with low s and a valid recovery id.
    function _authorize(bytes32 hash, address actor, bytes calldata signature) private pure {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (
            (v != 27 && v != 28) || uint256(s) > SECP256K1_HALF_ORDER ||
            actor == address(0) || ecrecover(hash, v, r, s) != actor
        ) revert InvalidSignature();
    }

    // b <= d, and d fits in uint64. Splitting a by d avoids overflow in both products.
    function _fraction(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        return (a / d) * b + (a % d) * b / d;
    }
}
