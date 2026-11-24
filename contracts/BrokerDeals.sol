// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBrokerDeals} from "./IBrokerDeals.sol";
import {GrantVault} from "./GrantVault.sol";

interface IBrokerToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Version 3 escrow for one seller and one buyer who authorize the same typed terms.
contract BrokerDeals is IBrokerDeals {
    error BadTreasury();
    error InvalidTerms(string field);
    error WrongActor(address expected);
    error InvalidSignature(address expected);
    error NonceUsed(uint256 nonce);
    error WrongStatus(uint8 status);
    error DeliveryWindowClosed();
    error NothingToClaim(uint256 grantId);
    error TransferFailed(address token);
    error InexactTransfer(address token);
    error Reentered();

    bytes32 private constant DOMAIN_TYPE = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant TERMS_TYPE = keccak256(
        "BrokerTerms(address seller,address buyer,address baseToken,address quoteToken,uint256 allocation,uint256 quote,uint64 expiry,uint256 nonce,uint8 delivery,uint64 fixedStart,uint64 cliffSeconds,uint64 durationSeconds,address broker,uint16 brokerBps)"
    );
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    enum Status { Unfunded, Funded, Settled, Refunded }

    struct Deal {
        BrokerTerms terms;
        Status status;
        uint256 grantId;
    }

    address private immutable treasury;
    mapping(bytes32 => Deal) private deals;
    mapping(address => mapping(uint256 => bool)) private usedNonces;
    mapping(uint256 => Grant) private grants;
    uint256 private lastGrantId;
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

    function fund(BrokerTerms calldata terms, bytes calldata sellerSignature) external oneAtATime {
        if (msg.sender != terms.seller) revert WrongActor(terms.seller);
        _validate(terms);
        bytes32 dealId = _digest(terms);
        _authorize(dealId, terms.seller, sellerSignature);
        if (usedNonces[terms.seller][terms.nonce]) revert NonceUsed(terms.nonce);

        usedNonces[terms.seller][terms.nonce] = true;
        deals[dealId] = Deal(terms, Status.Funded, 0);
        _move(terms.baseToken, terms.seller, address(this), terms.allocation);
        emit BrokerDealFunded(dealId, terms.seller, terms.broker);
    }

    function settle(bytes32 dealId, bytes calldata buyerSignature) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert WrongStatus(uint8(deal.status));
        BrokerTerms storage terms = deal.terms;
        if (msg.sender != terms.buyer) revert WrongActor(terms.buyer);
        if (block.timestamp >= terms.expiry || (terms.fixedStart != 0 && block.timestamp > terms.fixedStart)) {
            revert DeliveryWindowClosed();
        }
        if (_digest(terms) != dealId) revert InvalidSignature(terms.buyer);
        _authorize(dealId, terms.buyer, buyerSignature);

        deal.status = Status.Settled;
        address recipient = terms.buyer;
        if (terms.delivery == 1) {
            uint64 start = terms.fixedStart == 0 ? uint64(block.timestamp) : terms.fixedStart;
            recipient = address(new GrantVault(terms.baseToken, terms.buyer));
            deal.grantId = ++lastGrantId;
            grants[deal.grantId] = Grant(terms.baseToken, terms.buyer, recipient, terms.allocation,
                start, start + terms.cliffSeconds, start + terms.durationSeconds, 0);
        }

        uint256 fee = terms.quote / 200; // floor(quote * 50 / 10,000) for each side
        uint256 brokerFee = _mulDiv(fee * 2, terms.brokerBps, 10_000);
        uint256 treasuryFee = fee * 2 - brokerFee;
        _move(terms.quoteToken, terms.buyer, address(this), terms.quote + fee);
        _move(terms.quoteToken, address(this), terms.seller, terms.quote - fee);
        if (brokerFee != 0) _move(terms.quoteToken, address(this), terms.broker, brokerFee);
        if (treasuryFee != 0) _move(terms.quoteToken, address(this), treasury, treasuryFee);
        _move(terms.baseToken, address(this), recipient, terms.allocation);

        emit BrokerDealSettled(dealId, terms.buyer, fee, fee, brokerFee, treasuryFee, deal.grantId);
    }

    function refund(bytes32 dealId) external oneAtATime {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert WrongStatus(uint8(deal.status));
        if (msg.sender != deal.terms.seller) revert WrongActor(deal.terms.seller);

        deal.status = Status.Refunded;
        _move(deal.terms.baseToken, address(this), deal.terms.seller, deal.terms.allocation);
        emit BrokerDealRefunded(dealId);
    }

    function getDeal(bytes32 dealId) external view returns (BrokerTerms memory terms, uint8 status, uint256 grantId) {
        Deal storage deal = deals[dealId];
        return (deal.terms, uint8(deal.status), deal.grantId);
    }

    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return grants[grantId];
    }

    function claim(uint256 grantId) external oneAtATime {
        Grant storage grant = grants[grantId];
        if (msg.sender != grant.beneficiary) revert WrongActor(grant.beneficiary);
        if (block.timestamp < grant.cliff) revert NothingToClaim(grantId);
        uint256 vested = block.timestamp >= grant.end ? grant.allocation
            : _mulDiv(grant.allocation, block.timestamp - grant.start, grant.end - grant.start);
        uint256 amount = vested - grant.claimed;
        if (amount == 0) revert NothingToClaim(grantId);

        grant.claimed = vested;
        uint256 had = IBrokerToken(grant.token).balanceOf(grant.beneficiary);
        GrantVault(grant.custodian).pay(amount);
        if (IBrokerToken(grant.token).balanceOf(grant.beneficiary) != had + amount) revert InexactTransfer(grant.token);
    }

    function _validate(BrokerTerms calldata terms) private view {
        if (terms.seller == address(0) || terms.seller == address(this)) revert InvalidTerms("seller");
        if (terms.buyer == address(0) || terms.buyer == address(this) || terms.buyer == terms.seller) {
            revert InvalidTerms("buyer");
        }
        if (terms.broker == address(0) || terms.broker == address(this)
            || terms.broker == terms.seller || terms.broker == terms.buyer) revert InvalidTerms("broker");
        if (terms.baseToken.code.length == 0) revert InvalidTerms("baseToken");
        if (terms.quoteToken.code.length == 0 || terms.quoteToken == terms.baseToken) revert InvalidTerms("quoteToken");
        if (terms.allocation == 0) revert InvalidTerms("allocation");
        if (terms.quote == 0 || terms.quote > type(uint256).max - terms.quote / 200) revert InvalidTerms("quote");
        if (terms.expiry <= block.timestamp) revert InvalidTerms("expiry");
        if (terms.brokerBps > 10_000) revert InvalidTerms("brokerBps");
        if (terms.delivery > 1) revert InvalidTerms("delivery");
        if (terms.delivery == 0) {
            if (terms.fixedStart != 0 || terms.cliffSeconds != 0 || terms.durationSeconds != 0) {
                revert InvalidTerms("schedule");
            }
        } else {
            if (terms.cliffSeconds >= terms.durationSeconds) revert InvalidTerms("cliffSeconds");
            if (terms.fixedStart != 0 && terms.fixedStart <= block.timestamp) revert InvalidTerms("fixedStart");
            uint256 latestStart = terms.fixedStart == 0 ? terms.expiry : terms.fixedStart;
            if (latestStart + terms.durationSeconds > type(uint64).max) revert InvalidTerms("durationSeconds");
        }
    }

    function _digest(BrokerTerms memory terms) private view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPE, keccak256("OTC.fam Broker Deals"),
            keccak256("3"), block.chainid, address(this)));
        return keccak256(abi.encodePacked(hex"1901", domain, keccak256(abi.encode(TERMS_TYPE, terms))));
    }

    function _authorize(bytes32 digest, address signer, bytes calldata signature) private pure {
        if (signature.length != 65) revert InvalidSignature(signer);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28) || ecrecover(digest, v, r, s) != signer) {
            revert InvalidSignature(signer);
        }
    }

    function _move(address token, address from, address to, uint256 amount) private {
        IBrokerToken asset = IBrokerToken(token);
        uint256 debit = asset.balanceOf(from);
        uint256 credit = asset.balanceOf(to);
        bytes memory data = from == address(this) ? abi.encodeCall(asset.transfer, (to, amount))
            : abi.encodeCall(asset.transferFrom, (from, to, amount));
        (bool ok, bytes memory answer) = token.call(data);
        if (!ok || (answer.length != 0 && (answer.length != 32 || bytes32(answer) != bytes32(uint256(1))))) {
            revert TransferFailed(token);
        }
        if (debit < amount || asset.balanceOf(from) != debit - amount || asset.balanceOf(to) != credit + amount) {
            revert InexactTransfer(token);
        }
    }

    // floor(a * b / d) without overflowing an allocation, for b <= d and d <= uint64.max.
    function _mulDiv(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        return (a / d) * b + (a % d) * b / d;
    }
}
