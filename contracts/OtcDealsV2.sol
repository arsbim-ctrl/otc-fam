// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOtcDealsV2} from "./IOtcDealsV2.sol";
import {IERC20Minimal} from "./OtcDeals.sol";

/// Funded allocations and settled grants share a custodian. Each allocation can
/// leave only through cancellation, immediate settlement, or beneficiary claims.
contract OtcDealsV2 is IOtcDealsV2 {
    struct Deal {
        address seller;
        Terms terms;
        Status status;
        uint256 grantId;
    }

    address public immutable treasury;
    uint256 private nextId;
    mapping(uint256 => Deal) private deals;
    mapping(uint256 => Grant) private grants;
    bool private transient locked;

    error InvalidTerms();
    error InvalidSchedule();
    error UnsupportedPosition();
    error NotFunded();
    error WrongAccount();
    error Expired();
    error NothingToClaim();
    error Reentered();
    error TransferFailed(address token);
    error InexactTransfer(address token);

    constructor(address recipient) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidTerms();
        treasury = recipient;
    }

    modifier guarded() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    function createDeal(Terms calldata t) external guarded returns (uint256 id) {
        if (t.buyer == address(0) || t.buyer == address(this) || t.buyer == msg.sender ||
            t.baseToken == t.quoteToken || t.baseToken.code.length == 0 || t.quoteToken.code.length == 0 ||
            t.allocation == 0 || t.quote == 0 || t.quote > type(uint256).max - t.quote / 200 ||
            t.expiry <= block.timestamp) revert InvalidTerms();

        if (isPosition(t.baseToken) || isPosition(t.quoteToken)) revert UnsupportedPosition();

        if (t.delivery == Delivery.Immediate) {
            if (t.fixedStart != 0 || t.cliffSeconds != 0 || t.durationSeconds != 0) revert InvalidSchedule();
        } else {
            if (t.durationSeconds <= t.cliffSeconds ||
                (t.fixedStart != 0 && t.fixedStart <= block.timestamp)) revert InvalidSchedule();
            // Even the latest possible settlement must fit the grant's uint64 dates.
            uint64 latestStart = t.fixedStart == 0 ? t.expiry - 1 : t.fixedStart;
            if (t.durationSeconds > type(uint64).max - latestStart) revert InvalidSchedule();
        }
        id = ++nextId;
        deals[id] = Deal(msg.sender, t, Status.Funded, 0);
        move(t.baseToken, msg.sender, address(this), t.allocation);
        emit DealFunded(id, msg.sender, t.buyer);
    }

    function fill(uint256 id) external guarded {
        Deal storage d = deals[id];
        Terms storage t = d.terms;
        if (d.status != Status.Funded) revert NotFunded();
        if (msg.sender != t.buyer) revert WrongAccount();
        if (block.timestamp >= t.expiry) revert Expired();
        d.status = Status.Settled;

        // Round each side independently, in quote-token base units.
        uint256 fee = t.quote / 200;
        move(t.quoteToken, msg.sender, address(this), t.quote + fee);
        move(t.quoteToken, address(this), d.seller, t.quote - fee);
        if (fee != 0) move(t.quoteToken, address(this), treasury, fee * 2);

        if (t.delivery == Delivery.Immediate) {
            move(t.baseToken, address(this), t.buyer, t.allocation);
        } else {
            // A deal has at most one grant, so its id is also a unique grant id.
            uint64 start = t.fixedStart == 0 ? uint64(block.timestamp) : t.fixedStart;
            d.grantId = id;
            grants[id] = Grant(id, t.baseToken, t.buyer, address(this), t.allocation,
                start, start + t.cliffSeconds, start + t.durationSeconds, 0);
            emit GrantCreated(id, id, t.buyer);
        }
        emit DealSettled(id, d.grantId, fee, fee);
    }

    function cancel(uint256 id) external guarded {
        Deal storage d = deals[id];
        if (d.status != Status.Funded) revert NotFunded();
        if (msg.sender != d.seller) revert WrongAccount();
        d.status = Status.Cancelled;
        move(d.terms.baseToken, address(this), d.seller, d.terms.allocation);
        emit DealCancelled(id);
    }

    function getDeal(uint256 id) external view returns (address, Terms memory, Status, uint256) {
        Deal storage d = deals[id];
        return (d.seller, d.terms, d.status, d.grantId);
    }

    function getGrant(uint256 id) external view returns (Grant memory) {
        return grants[id];
    }

    function vested(uint256 id) public view returns (uint256) {
        Grant storage g = grants[id];
        if (block.timestamp < g.cliff) return 0;
        if (block.timestamp >= g.end) return g.allocation;
        uint256 elapsed = block.timestamp - g.start;
        uint256 duration = g.end - g.start;
        // floor(allocation * elapsed / duration), including for uint256-sized allocations.
        // Both elapsed and the remainder are bounded by the uint64 duration.
        return (g.allocation / duration) * elapsed + (g.allocation % duration) * elapsed / duration;
    }

    function claimable(uint256 id) public view returns (uint256) {
        return vested(id) - grants[id].claimed;
    }

    function claim(uint256 id) external guarded {
        Grant storage g = grants[id];
        if (msg.sender != g.beneficiary) revert WrongAccount();
        uint256 due = claimable(id);
        if (due == 0) revert NothingToClaim();
        g.claimed += due;
        move(g.token, address(this), g.beneficiary, due);
        emit GrantClaimed(id, g.beneficiary, due);
    }

    // ERC-721 shares transferFrom with ERC-20. Refuse standard position NFTs
    // before taking custody. Tokens without ERC-165 remain eligible.
    function isPosition(address token) private view returns (bool) {
        return supportsInterfaceId(token, 0x80ac58cd) || supportsInterfaceId(token, 0xd9b67a26);
    }

    function supportsInterfaceId(address token, bytes4 id) private view returns (bool) {
        (bool ok, bytes memory answer) = token.staticcall{gas: 30000}(abi.encodeWithSelector(0x01ffc9a7, id));
        return ok && answer.length == 32 && abi.decode(answer, (uint256)) == 1;
    }

    function move(address token, address from, address to, uint256 value) private {
        IERC20Minimal asset = IERC20Minimal(token);
        uint256 beforeFrom = asset.balanceOf(from);
        uint256 beforeTo = asset.balanceOf(to);
        bytes memory data = from == address(this)
            ? abi.encodeCall(asset.transfer, (to, value))
            : abi.encodeCall(asset.transferFrom, (from, to, value));
        (bool ok, bytes memory result) = token.call(data);
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed(token);
        if (asset.balanceOf(from) + value != beforeFrom || asset.balanceOf(to) != beforeTo + value)
            revert InexactTransfer(token);
    }
}
