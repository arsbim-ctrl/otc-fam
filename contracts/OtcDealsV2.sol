// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOtcDealsV2} from "./IOtcDealsV2.sol";
import {ExactToken} from "./ExactToken.sol";
import {VestingVault} from "./VestingVault.sol";

/// Funded, buyer-specific OTC deals. All payments and deliveries share one settlement transaction.
contract OtcDealsV2 is IOtcDealsV2 {
    error InvalidTreasury();
    error InvalidBuyer();
    error ZeroAmount();
    error QuoteTooLarge();
    error SameToken();
    error NotAToken(address token);
    error ExpiryNotInFuture();
    error InvalidSchedule();
    error StaleStart();
    error NotFunded();
    error DealExpired(uint256 dealId);
    error NotBuyer();
    error NotSeller();
    error Reentered();

    struct Deal {
        address seller;
        Terms terms;
        Status status;
        uint256 grantId;
    }

    address public immutable treasury;
    VestingVault private immutable vault;
    uint256 private lastDealId;
    mapping(uint256 => Deal) private deals;
    bool private transient locked;

    modifier nonReentrant() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    constructor(address treasury_) {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        vault = new VestingVault();
        if (treasury_ == address(vault)) revert InvalidTreasury();
        treasury = treasury_;
    }

    function createDeal(Terms calldata terms) external nonReentrant returns (uint256 dealId) {
        if (terms.buyer == address(0) || terms.buyer == msg.sender
            || terms.buyer == address(this) || terms.buyer == address(vault)) revert InvalidBuyer();
        if (terms.allocation == 0 || terms.quote == 0) revert ZeroAmount();
        if (terms.quote > type(uint256).max - _fee(terms.quote)) revert QuoteTooLarge();
        if (terms.baseToken == terms.quoteToken) revert SameToken();
        if (terms.baseToken.code.length == 0) revert NotAToken(terms.baseToken);
        if (terms.quoteToken.code.length == 0) revert NotAToken(terms.quoteToken);
        if (terms.expiry <= block.timestamp) revert ExpiryNotInFuture();

        if (terms.delivery == Delivery.NewVesting) {
            _schedule(terms);
        } else if (terms.fixedStart != 0 || terms.cliffSeconds != 0 || terms.durationSeconds != 0) {
            revert InvalidSchedule();
        }

        dealId = ++lastDealId;
        ExactToken.pull(terms.baseToken, msg.sender, terms.allocation);
        deals[dealId] = Deal(msg.sender, terms, Status.Funded, 0);
        emit DealFunded(dealId, msg.sender, terms.buyer);
    }

    function fill(uint256 dealId) external nonReentrant {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotFunded();
        Terms memory terms = deal.terms;
        if (msg.sender != terms.buyer) revert NotBuyer();
        if (block.timestamp >= terms.expiry) revert DealExpired(dealId);

        Grant memory grant;
        if (terms.delivery == Delivery.NewVesting) {
            (uint64 start, uint64 cliff, uint64 end) = _schedule(terms);
            grant = Grant(dealId, terms.baseToken, terms.buyer, address(vault), terms.allocation, start, cliff, end, 0);
            deal.grantId = dealId;
        }
        deal.status = Status.Settled;

        uint256 fee = _fee(terms.quote);
        ExactToken.pull(terms.quoteToken, terms.buyer, terms.quote + fee);
        ExactToken.push(terms.quoteToken, deal.seller, terms.quote - fee);
        ExactToken.push(terms.quoteToken, treasury, fee * 2);

        if (deal.grantId == 0) {
            ExactToken.push(terms.baseToken, terms.buyer, terms.allocation);
        } else {
            ExactToken.push(terms.baseToken, address(vault), terms.allocation);
            vault.record(dealId, grant);
            emit GrantCreated(dealId, dealId, terms.buyer);
        }
        emit DealSettled(dealId, deal.grantId, fee, fee);
    }

    function cancel(uint256 dealId) external nonReentrant {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotFunded();
        if (msg.sender != deal.seller) revert NotSeller();

        deal.status = Status.Cancelled;
        ExactToken.push(deal.terms.baseToken, deal.seller, deal.terms.allocation);
        emit DealCancelled(dealId);
    }

    function getDeal(uint256 dealId) external view returns (address seller, Terms memory terms, Status status, uint256 grantId) {
        Deal storage deal = deals[dealId];
        return (deal.seller, deal.terms, deal.status, deal.grantId);
    }

    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return vault.getGrant(grantId);
    }

    function vested(uint256 grantId) external view returns (uint256) {
        return vault.vested(grantId);
    }

    function claimable(uint256 grantId) external view returns (uint256) {
        return vault.claimable(grantId);
    }

    /// Anyone can trigger payment to the immutable beneficiary.
    function claim(uint256 grantId) external nonReentrant {
        (address beneficiary, uint256 amount) = vault.release(grantId);
        emit GrantClaimed(grantId, beneficiary, amount);
    }

    function _fee(uint256 quote) private pure returns (uint256) {
        return quote / 200; // floor(quote * 50 / 10_000), without multiplying the quote
    }

    function _schedule(Terms memory terms) private view returns (uint64 start, uint64 cliff, uint64 end) {
        uint256 startsAt = terms.fixedStart == 0 ? block.timestamp : terms.fixedStart;
        if (terms.fixedStart != 0 && startsAt <= block.timestamp) revert StaleStart();
        if (terms.cliffSeconds >= terms.durationSeconds
            || startsAt > type(uint64).max - terms.durationSeconds) revert InvalidSchedule();

        start = uint64(startsAt);
        cliff = start + terms.cliffSeconds;
        end = start + terms.durationSeconds;
    }
}
