// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBrokerDeals} from "./IBrokerDeals.sol";
import {GrantVault} from "./GrantVault.sol";
import {TokenMoves} from "./TokenMoves.sol";

interface IERC1271 {
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);
}

/// @notice Version 3 private OTC deals. Only the signed seller can fund or refund and only the signed
/// buyer can settle. The broker can propose terms offchain and receives a share only after settlement.
contract BrokerDeals is IBrokerDeals {
    error BadTreasury();
    error BadParties();
    error BadBroker();
    error BadTokens();
    error BadAmounts();
    error BadSchedule();
    error DealExpired();
    error StartPassed();
    error NonceUsed();
    error NotFunded();
    error NotSeller();
    error NotBuyer();
    error InvalidAuthorization();
    error NotBeneficiary(uint256 grantId);
    error NothingToClaim(uint256 grantId);
    error Reentered();

    uint256 public constant FEE_BPS = 50;
    uint256 private constant BPS = 10_000;
    uint256 private constant HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant DOMAIN_TYPE = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant TERMS_TYPE = keccak256(
        "BrokerTerms(address seller,address buyer,address baseToken,address quoteToken,uint256 allocation,uint256 quote,uint64 expiry,uint256 nonce,uint8 delivery,uint64 fixedStart,uint64 cliffSeconds,uint64 durationSeconds,address broker,uint16 brokerBps)"
    );

    enum Status { Unfunded, Funded, Settled, Refunded }

    struct Deal {
        BrokerTerms terms;
        Status status;
        uint256 grantId;
    }

    address public immutable treasury;
    mapping(bytes32 => Deal) private deals;
    mapping(address => mapping(uint256 => bool)) public nonces;
    mapping(uint256 => Grant) private grants;
    uint256 private lastGrantId;
    bool private transient locked;

    // Secondary discovery index for the buyer. Funded already indexes seller and broker.
    event BrokerDealBuyer(bytes32 indexed dealId, address indexed buyer);
    event BrokerGrantClaimed(uint256 indexed grantId, address indexed beneficiary, uint256 amount);

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

    /// @notice The deal ID is also the digest signed by both parties.
    function hashTerms(BrokerTerms calldata terms) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPE, keccak256("OTC.fam Broker Deals"), keccak256("3"), block.chainid, address(this)
        ));
        // BrokerTerms has only static members, so the tuple encodes as its concatenated ABI words.
        return keccak256(abi.encodePacked(hex"1901", domain, keccak256(abi.encode(TERMS_TYPE, terms))));
    }

    function fund(BrokerTerms calldata terms, bytes calldata sellerSignature) external oneAtATime {
        if (msg.sender != terms.seller) revert NotSeller();
        _validate(terms);
        if (nonces[terms.seller][terms.nonce]) revert NonceUsed();

        bytes32 dealId = hashTerms(terms);
        _authorize(terms.seller, dealId, sellerSignature);
        nonces[terms.seller][terms.nonce] = true;
        deals[dealId] = Deal(terms, Status.Funded, 0);

        TokenMoves.take(terms.baseToken, terms.seller, terms.allocation);
        emit BrokerDealFunded(dealId, terms.seller, terms.broker);
        emit BrokerDealBuyer(dealId, terms.buyer);
    }

    function settle(bytes32 dealId, bytes calldata buyerSignature) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotFunded();
        BrokerTerms storage terms = deal.terms;
        if (msg.sender != terms.buyer) revert NotBuyer();
        if (block.timestamp >= terms.expiry) revert DealExpired();
        if (terms.fixedStart != 0 && terms.fixedStart < block.timestamp) revert StartPassed();
        _authorize(terms.buyer, dealId, buyerSignature);

        deal.status = Status.Settled;
        address recipient = terms.buyer;
        if (terms.delivery == 1) {
            deal.grantId = ++lastGrantId;
            uint64 start = terms.fixedStart == 0 ? uint64(block.timestamp) : terms.fixedStart;
            recipient = address(new GrantVault(terms.baseToken, terms.buyer));
            grants[deal.grantId] = Grant(
                terms.baseToken, terms.buyer, recipient, terms.allocation,
                start, start + terms.cliffSeconds, start + terms.durationSeconds, 0
            );
        }

        uint256 fee = terms.quote / (BPS / FEE_BPS);
        uint256 brokerFee = _mulDiv(2 * fee, terms.brokerBps, BPS);
        uint256 treasuryFee = 2 * fee - brokerFee;
        TokenMoves.take(terms.quoteToken, terms.buyer, terms.quote + fee);
        TokenMoves.give(terms.quoteToken, terms.seller, terms.quote - fee);
        if (brokerFee != 0) TokenMoves.give(terms.quoteToken, terms.broker, brokerFee);
        if (treasuryFee != 0) TokenMoves.give(terms.quoteToken, treasury, treasuryFee);
        TokenMoves.give(terms.baseToken, recipient, terms.allocation);

        emit BrokerDealSettled(dealId, terms.buyer, fee, fee, brokerFee, treasuryFee, deal.grantId);
    }

    /// @notice The seller may withdraw escrow while funded, including after expiry or a passed fixed start.
    function refund(bytes32 dealId) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotFunded();
        if (msg.sender != deal.terms.seller) revert NotSeller();
        deal.status = Status.Refunded;
        TokenMoves.send(deal.terms.baseToken, deal.terms.seller, deal.terms.allocation);
        emit BrokerDealRefunded(dealId);
    }

    function getDeal(bytes32 dealId) external view returns (BrokerTerms memory terms, uint8 status, uint256 grantId) {
        Deal storage deal = deals[dealId];
        return (deal.terms, uint8(deal.status), deal.grantId);
    }

    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return grants[grantId];
    }

    function claimable(uint256 grantId) public view returns (uint256) {
        Grant storage grant = grants[grantId];
        if (block.timestamp < grant.cliff) return 0;
        uint256 vested = block.timestamp >= grant.end
            ? grant.allocation
            : _mulDiv(grant.allocation, block.timestamp - grant.start, grant.end - grant.start);
        return vested - grant.claimed;
    }

    function claim(uint256 grantId) external oneAtATime {
        Grant storage grant = grants[grantId];
        if (msg.sender != grant.beneficiary) revert NotBeneficiary(grantId);
        uint256 amount = claimable(grantId);
        if (amount == 0) revert NothingToClaim(grantId);
        grant.claimed += amount;
        GrantVault(grant.custodian).pay(amount);
        emit BrokerGrantClaimed(grantId, grant.beneficiary, amount);
    }

    function _validate(BrokerTerms calldata terms) private view {
        if (terms.buyer == address(0) || terms.buyer == terms.seller
            || terms.buyer == address(this) || terms.seller == address(this)) revert BadParties();
        if (terms.broker == address(0) || terms.broker == terms.seller || terms.broker == terms.buyer
            || terms.broker == address(this) || terms.brokerBps > BPS) revert BadBroker();
        if (terms.baseToken == terms.quoteToken
            || terms.baseToken.code.length == 0 || terms.quoteToken.code.length == 0) revert BadTokens();
        if (terms.allocation == 0 || terms.quote == 0
            || terms.quote > type(uint256).max - terms.quote / (BPS / FEE_BPS)) revert BadAmounts();
        if (terms.expiry <= block.timestamp) revert DealExpired();

        if (terms.delivery == 0) {
            if (terms.fixedStart != 0 || terms.cliffSeconds != 0 || terms.durationSeconds != 0) revert BadSchedule();
            return;
        }
        if (terms.delivery != 1 || terms.cliffSeconds >= terms.durationSeconds) revert BadSchedule();
        if (terms.fixedStart != 0 && terms.fixedStart <= block.timestamp) revert StartPassed();
        uint256 latestStart = terms.fixedStart == 0 ? terms.expiry : terms.fixedStart;
        if (latestStart + terms.durationSeconds > type(uint64).max) revert BadSchedule();
    }

    function _authorize(address signer, bytes32 digest, bytes calldata signature) private view {
        if (signer.code.length != 0) {
            (bool ok, bytes memory result) = signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            if (ok && result.length >= 32 && bytes4(result) == IERC1271.isValidSignature.selector) return;
        } else if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly ("memory-safe") {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 32))
                v := byte(0, calldataload(add(signature.offset, 64)))
            }
            if (uint256(s) <= HALF_CURVE_ORDER && (v == 27 || v == 28) && ecrecover(digest, v, r, s) == signer) return;
        }
        revert InvalidAuthorization();
    }

    /// floor(a * b / d) with b <= d and d <= uint64.max, without overflowing for a uint256 allocation.
    function _mulDiv(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        return (a / d) * b + (a % d) * b / d;
    }
}
