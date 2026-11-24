// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBrokerDeals} from "./IBrokerDeals.sol";
import {GrantVault} from "./GrantVault.sol";
import {TokenMoves} from "./TokenMoves.sol";

/// @notice Signed, buyer-specific OTC swaps funded by the seller. The broker has no spending authority.
contract BrokerDeals is IBrokerDeals {
    enum Status { Unfunded, Funded, Settled, Refunded }

    struct Deal {
        BrokerTerms terms;
        Status status;
        uint256 grantId;
    }

    error BadRecipient();
    error SameParty();
    error ZeroAmount();
    error QuoteTooLarge();
    error SameToken();
    error NotAToken(address token);
    error BadBrokerShare();
    error DealExpired();
    error BadSchedule();
    error StartPassed();
    error NotSeller();
    error NotBuyer();
    error InvalidSignature();
    error NonceUsed();
    error NotFunded();
    error NotBeneficiary();
    error NothingToClaim();
    error Reentered();

    uint256 public constant FEE_BPS = 50;
    uint256 private constant BPS = 10_000;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant TERMS_TYPEHASH = keccak256(
        "BrokerTerms(address seller,address buyer,address baseToken,address quoteToken,uint256 allocation,uint256 quote,uint64 expiry,uint256 nonce,uint8 delivery,uint64 fixedStart,uint64 cliffSeconds,uint64 durationSeconds,address broker,uint16 brokerBps)"
    );
    bytes32 private constant NAME_HASH = keccak256("OTC.fam Broker Deals");
    bytes32 private constant VERSION_HASH = keccak256("3");
    uint256 private constant MAX_SIGNATURE_S =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable treasury;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(bytes32 => Deal) private deals;
    mapping(uint256 => Grant) private grants;
    uint256 private lastGrantId;
    bool private transient locked;

    event BrokerDealForBuyer(bytes32 indexed dealId, address indexed buyer);
    event BrokerGrantClaimed(uint256 indexed grantId, address indexed beneficiary, uint256 amount);

    modifier oneAtATime() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    constructor(address treasury_) {
        _checkRecipient(treasury_);
        treasury = treasury_;
    }

    /// @notice Identifies these exact terms on this deployment and chain.
    function hashTerms(BrokerTerms memory terms) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        // BrokerTerms is entirely static. Its tuple encoding is the ordered 32-byte fields.
        bytes32 message = keccak256(abi.encode(TERMS_TYPEHASH, terms));
        return keccak256(abi.encodePacked(hex"1901", domain, message));
    }

    function fund(BrokerTerms calldata terms, bytes calldata sellerSignature) external oneAtATime {
        if (msg.sender != terms.seller) revert NotSeller();
        _validate(terms);
        if (nonceUsed[terms.seller][terms.nonce]) revert NonceUsed();
        bytes32 dealId = hashTerms(terms);
        _requireSignature(terms.seller, dealId, sellerSignature);

        nonceUsed[terms.seller][terms.nonce] = true;
        deals[dealId] = Deal(terms, Status.Funded, 0);
        TokenMoves.take(terms.baseToken, terms.seller, terms.allocation);
        emit BrokerDealFunded(dealId, terms.seller, terms.broker);
        emit BrokerDealForBuyer(dealId, terms.buyer);
    }

    function settle(bytes32 dealId, bytes calldata buyerSignature) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotFunded();
        BrokerTerms memory terms = deal.terms;
        if (msg.sender != terms.buyer) revert NotBuyer();
        if (block.timestamp >= terms.expiry) revert DealExpired();
        if (terms.fixedStart != 0 && terms.fixedStart < block.timestamp) revert StartPassed();
        if (hashTerms(terms) != dealId) revert InvalidSignature();
        _requireSignature(terms.buyer, dealId, buyerSignature);

        deal.status = Status.Settled;
        address recipient = terms.buyer;
        if (terms.delivery == 1) {
            uint256 grantId = ++lastGrantId;
            deal.grantId = grantId;
            recipient = address(new GrantVault(terms.baseToken, terms.buyer));
            uint64 start = terms.fixedStart == 0 ? uint64(block.timestamp) : terms.fixedStart;
            grants[grantId] = Grant(terms.baseToken, terms.buyer, recipient, terms.allocation,
                start, start + terms.cliffSeconds, start + terms.durationSeconds, 0);
        }

        uint256 fee = _sideFee(terms.quote);
        uint256 brokerFee = _mulDiv(2 * fee, terms.brokerBps, BPS);
        uint256 treasuryFee = 2 * fee - brokerFee;
        TokenMoves.take(terms.quoteToken, terms.buyer, terms.quote + fee);
        TokenMoves.give(terms.quoteToken, terms.seller, terms.quote - fee);
        if (brokerFee != 0) TokenMoves.give(terms.quoteToken, terms.broker, brokerFee);
        if (treasuryFee != 0) TokenMoves.give(terms.quoteToken, treasury, treasuryFee);
        TokenMoves.give(terms.baseToken, recipient, terms.allocation);
        emit BrokerDealSettled(dealId, terms.buyer, fee, fee, brokerFee, treasuryFee, deal.grantId);
    }

    function refund(bytes32 dealId) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotFunded();
        if (msg.sender != deal.terms.seller) revert NotSeller();
        deal.status = Status.Refunded;
        TokenMoves.send(deal.terms.baseToken, msg.sender, deal.terms.allocation);
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
        if (block.timestamp >= grant.end) return grant.allocation - grant.claimed;
        return _mulDiv(grant.allocation, block.timestamp - grant.start, grant.end - grant.start) - grant.claimed;
    }

    function claim(uint256 grantId) external oneAtATime {
        Grant storage grant = grants[grantId];
        if (msg.sender != grant.beneficiary) revert NotBeneficiary();
        uint256 amount = claimable(grantId);
        if (amount == 0) revert NothingToClaim();
        grant.claimed += amount;
        GrantVault(grant.custodian).pay(amount);
        emit BrokerGrantClaimed(grantId, msg.sender, amount);
    }

    function _validate(BrokerTerms calldata terms) private view {
        _checkRecipient(terms.buyer);
        _checkRecipient(terms.broker);
        if (terms.buyer == terms.seller || terms.broker == terms.seller || terms.broker == terms.buyer) revert SameParty();
        if (terms.allocation == 0 || terms.quote == 0) revert ZeroAmount();
        if (terms.quote > type(uint256).max - _sideFee(terms.quote)) revert QuoteTooLarge();
        if (terms.baseToken == terms.quoteToken) revert SameToken();
        if (terms.baseToken.code.length == 0) revert NotAToken(terms.baseToken);
        if (terms.quoteToken.code.length == 0) revert NotAToken(terms.quoteToken);
        if (terms.brokerBps > BPS) revert BadBrokerShare();
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

    function _checkRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this)) revert BadRecipient();
    }

    function _requireSignature(address signer, bytes32 digest, bytes calldata signature) private pure {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > MAX_SIGNATURE_S || (v != 27 && v != 28)) revert InvalidSignature();
        if (ecrecover(digest, v, r, s) != signer) revert InvalidSignature();
    }

    function _sideFee(uint256 quote) private pure returns (uint256) {
        return _mulDiv(quote, FEE_BPS, BPS);
    }

    /// All callers have b <= d and d <= uint64.max, so neither product overflows.
    function _mulDiv(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        return (a / d) * b + (a % d) * b / d;
    }
}
