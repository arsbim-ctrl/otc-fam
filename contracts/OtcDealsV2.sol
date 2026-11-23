// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOtcDealsV2} from "./IOtcDealsV2.sol";
import {IERC20Minimal} from "./OtcDeals.sol";

/// @notice Private, fee-bearing swaps with immediate delivery or a new funded vesting grant.
contract OtcDealsV2 is IOtcDealsV2 {
    error InvalidTreasury();
    error InvalidTerms();
    error InvalidSchedule();
    error StaleStart();
    error NotFunded();
    error DealExpired();
    error NotBuyer();
    error NotSeller();
    error NothingToClaim();
    error NotAToken(address token);
    error TransferFailed(address token);
    error InexactTransfer(address token);
    error Reentered();

    struct Deal {
        address seller;
        Terms terms;
        Status status;
        uint256 grantId;
    }

    address public immutable treasury;
    uint256 private lastDealId;
    mapping(uint256 => Deal) private deals;
    mapping(uint256 => Grant) private grants;
    bool private transient locked;

    constructor(address treasury_) {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        treasury = treasury_;
    }

    modifier nonReentrant() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    function createDeal(Terms calldata terms) external nonReentrant returns (uint256 dealId) {
        if (
            terms.buyer == address(0) || terms.buyer == address(this) || terms.allocation == 0 ||
            terms.quote == 0 || terms.baseToken == terms.quoteToken || terms.expiry <= block.timestamp ||
            terms.quote > type(uint256).max - _fee(terms.quote)
        ) revert InvalidTerms();

        if (terms.baseToken.code.length == 0) revert NotAToken(terms.baseToken);
        if (terms.quoteToken.code.length == 0) revert NotAToken(terms.quoteToken);
        _validateSchedule(terms);

        dealId = ++lastDealId;
        deals[dealId] = Deal(msg.sender, terms, Status.Funded, 0);
        _moveExact(terms.baseToken, msg.sender, address(this), terms.allocation);
        emit DealFunded(dealId, msg.sender, terms.buyer);
    }

    function fill(uint256 dealId) external nonReentrant {
        Deal storage deal = deals[dealId];
        Terms storage terms = deal.terms;
        if (deal.status != Status.Funded) revert NotFunded();
        if (block.timestamp >= terms.expiry) revert DealExpired();
        if (msg.sender != terms.buyer) revert NotBuyer();

        deal.status = Status.Settled;
        if (terms.delivery == Delivery.NewVesting) {
            // The escrow already holds the full allocation. The same custody becomes
            // grant backing atomically, with no external factory or intermediate allowance.
            uint64 start = terms.fixedStart;
            if (start == 0) start = uint64(block.timestamp); // block timestamp < uint64 expiry
            else if (start <= block.timestamp) revert StaleStart();
            deal.grantId = dealId;
            grants[dealId] = Grant(
                dealId, terms.baseToken, terms.buyer, address(this), terms.allocation,
                start, start + terms.cliffSeconds, start + terms.durationSeconds, 0
            );
            emit GrantCreated(dealId, dealId, terms.buyer);
        }

        uint256 fee = _fee(terms.quote);
        _moveExact(terms.quoteToken, msg.sender, address(this), terms.quote + fee);
        _moveExact(terms.quoteToken, address(this), deal.seller, terms.quote - fee);
        if (fee != 0) _moveExact(terms.quoteToken, address(this), treasury, 2 * fee);
        if (deal.grantId == 0) _moveExact(terms.baseToken, address(this), msg.sender, terms.allocation);
        emit DealSettled(dealId, deal.grantId, fee, fee);
    }

    function cancel(uint256 dealId) external nonReentrant {
        Deal storage deal = deals[dealId];
        if (deal.status != Status.Funded) revert NotFunded();
        if (msg.sender != deal.seller) revert NotSeller();
        deal.status = Status.Cancelled;
        _moveExact(deal.terms.baseToken, address(this), deal.seller, deal.terms.allocation);
        emit DealCancelled(dealId);
    }

    function getDeal(uint256 dealId) external view returns (
        address seller, Terms memory terms, Status status, uint256 grantId
    ) {
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

    function claim(uint256 grantId) external nonReentrant {
        Grant storage grant = grants[grantId];
        uint256 amount = _vested(grant) - grant.claimed;
        if (amount == 0) revert NothingToClaim();
        grant.claimed += amount;
        _moveExact(grant.token, address(this), grant.beneficiary, amount);
        emit GrantClaimed(grantId, grant.beneficiary, amount);
    }

    function _fee(uint256 quote) private pure returns (uint256) {
        return quote / 200; // floor(quote * 50 / 10_000), without an intermediate overflow
    }

    function _validateSchedule(Terms calldata terms) private view {
        if (terms.delivery == Delivery.Immediate) {
            if (terms.fixedStart != 0 || terms.cliffSeconds != 0 || terms.durationSeconds != 0) {
                revert InvalidSchedule();
            }
            return;
        }
        if (terms.cliffSeconds >= terms.durationSeconds) revert InvalidSchedule();
        if (terms.fixedStart != 0 && terms.fixedStart <= block.timestamp) revert StaleStart();

        uint256 latestStart = terms.fixedStart == 0 ? terms.expiry - 1 : terms.fixedStart;
        if (latestStart + terms.durationSeconds > type(uint64).max) revert InvalidSchedule();
    }

    function _vested(Grant storage grant) private view returns (uint256) {
        if (grant.allocation == 0 || block.timestamp < grant.cliff) return 0;
        if (block.timestamp >= grant.end) return grant.allocation;
        uint256 duration = grant.end - grant.start;
        uint256 elapsed = block.timestamp - grant.start;
        // Splitting the allocation by the denominator preserves the exact floor.
        // The remainder and elapsed are each less than 2**64.
        return (grant.allocation / duration) * elapsed + (grant.allocation % duration) * elapsed / duration;
    }

    function _moveExact(address token, address from, address to, uint256 amount) private {
        IERC20Minimal asset = IERC20Minimal(token);
        uint256 beforeFrom = asset.balanceOf(from);
        uint256 beforeTo = asset.balanceOf(to);
        bytes memory data = from == address(this)
            ? abi.encodeCall(IERC20Minimal.transfer, (to, amount))
            : abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount));
        (bool success, bytes memory result) = token.call(data);
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed(token);

        uint256 afterFrom = asset.balanceOf(from);
        uint256 afterTo = asset.balanceOf(to);
        if (afterFrom > beforeFrom || beforeFrom - afterFrom != amount ||
            afterTo < beforeTo || afterTo - beforeTo != amount) revert InexactTransfer(token);
    }
}
