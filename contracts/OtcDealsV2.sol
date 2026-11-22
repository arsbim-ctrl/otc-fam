// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOtcDealsV2} from "./IOtcDealsV2.sol";

interface IERC20V2 {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Fully escrowed private deals; immutable fees and nontransferable buyer grants.
contract OtcDealsV2 is IOtcDealsV2 {
    error ZeroAddress();
    error ZeroAmount();
    error SameToken();
    error ExpiryNotInFuture();
    error InvalidSchedule();
    error NotAToken(address token);
    error InexactTransfer(address token);
    error TransferFailed(address token);
    error NotFunded(uint256 id);
    error DealExpired(uint256 id);
    error NotBuyer(uint256 id);
    error NotSeller(uint256 id);
    error NothingToClaim(uint256 id);
    error Reentered();

    address public immutable treasury;
    uint256 private lastDeal;
    uint256 private lastGrant;
    mapping(uint256 => Deal) private deals;
    mapping(uint256 => Grant) private grants;
    bool private transient locked;

    constructor(address treasury_) {
        // Self-recipient transfers cannot have exact sender and recipient deltas.
        if (treasury_ == address(0) || treasury_ == address(this)) revert ZeroAddress();
        treasury = treasury_;
    }
    modifier oneAtATime() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    function createDeal(Terms calldata t) external oneAtATime returns (uint256 id) {
        if (t.buyer == address(0) || t.buyer == address(this)) revert ZeroAddress();
        if (t.allocation == 0 || t.quote == 0) revert ZeroAmount();
        if (t.baseToken == t.quoteToken) revert SameToken();
        if (t.baseToken.code.length == 0) revert NotAToken(t.baseToken);
        if (t.quoteToken.code.length == 0) revert NotAToken(t.quoteToken);
        if (t.expiry <= block.timestamp) revert ExpiryNotInFuture();
        // Reject an unrepresentable total before escrow, not only at settlement.
        if (t.quote > type(uint256).max - t.quote / 200) revert ZeroAmount();
        if (t.delivery == Delivery.Immediate) {
            if (t.fixedStart != 0 || t.cliffSeconds != 0 || t.durationSeconds != 0) revert InvalidSchedule();
        } else {
            if (t.durationSeconds == 0 || t.cliffSeconds >= t.durationSeconds) revert InvalidSchedule();
            if (t.fixedStart != 0 && t.fixedStart <= block.timestamp) revert InvalidSchedule();
            _end(t.fixedStart == 0 ? block.timestamp : t.fixedStart, t.durationSeconds);
        }
        id = ++lastDeal;
        deals[id] = Deal(msg.sender, t, Status.Funded, 0);
        emit DealFunded(id, msg.sender, t.buyer);
        _pull(t.baseToken, msg.sender, t.allocation);
    }

    function fill(uint256 id) external oneAtATime {
        Deal storage d = deals[id];
        Terms memory t = d.terms;
        if (d.status != Status.Funded) revert NotFunded(id);
        if (block.timestamp >= t.expiry) revert DealExpired(id);
        if (msg.sender != t.buyer) revert NotBuyer(id);
        d.status = Status.Settled;
        uint256 fee = t.quote / 200;
        if (t.delivery == Delivery.NewVesting) {
            uint256 start = t.fixedStart == 0 ? block.timestamp : t.fixedStart;
            if (t.fixedStart != 0 && start <= block.timestamp) revert InvalidSchedule();
            uint64 end = _end(start, t.durationSeconds);
            uint256 gid = ++lastGrant;
            d.grantId = gid;
            // The complete allocation is already in this vault. No approval, external
            // factory or unfunded intermediate position exists.
            grants[gid] = Grant(id, t.baseToken, t.buyer, address(this), t.allocation,
                uint64(start), uint64(start + t.cliffSeconds), end, 0);
            emit GrantCreated(gid, id, t.buyer);
        }
        emit DealSettled(id, d.grantId, fee, fee);
        _pull(t.quoteToken, msg.sender, t.quote + fee);
        _push(t.quoteToken, d.seller, t.quote - fee);
        if (fee != 0) _push(t.quoteToken, treasury, fee * 2);
        if (t.delivery == Delivery.Immediate) _push(t.baseToken, t.buyer, t.allocation);
    }

    function cancel(uint256 id) external oneAtATime {
        Deal storage d = deals[id];
        if (d.status != Status.Funded) revert NotFunded(id);
        if (msg.sender != d.seller) revert NotSeller(id);
        d.status = Status.Cancelled;
        emit DealCancelled(id);
        _push(d.terms.baseToken, d.seller, d.terms.allocation);
    }

    function claim(uint256 id) external oneAtATime {
        Grant storage g = grants[id];
        uint256 due = vested(id) - g.claimed;
        if (due == 0) revert NothingToClaim(id);
        g.claimed += due;
        emit GrantClaimed(id, g.beneficiary, due);
        _push(g.token, g.beneficiary, due);
    }
    function getDeal(uint256 id) external view returns (Deal memory) { return deals[id]; }
    function getGrant(uint256 id) external view returns (Grant memory) { return grants[id]; }
    function claimable(uint256 id) external view returns (uint256) { return vested(id) - grants[id].claimed; }
    function vested(uint256 id) public view returns (uint256) {
        Grant storage g = grants[id];
        if (g.allocation == 0 || block.timestamp < g.cliff) return 0;
        if (block.timestamp >= g.end) return g.allocation;
        return _mulDivTime(g.allocation, block.timestamp - g.start, g.end - g.start);
    }
    /// Exact floor(a*n/d), specialized to 0<=n<d<=uint64.max. Splitting a
    /// into quotient and remainder avoids a 256-bit product of a and n.
    /// (a/d)*n <= a, and (a%d)*n < 2^128; the sum is <= a.
    function _mulDivTime(uint256 a, uint256 n, uint256 d) private pure returns (uint256) {
        return (a / d) * n + ((a % d) * n) / d;
    }
    function _end(uint256 start, uint256 duration) private pure returns (uint64) {
        if (start > type(uint64).max || duration > type(uint64).max - start) revert InvalidSchedule();
        return uint64(start + duration);
    }
    function _pull(address token, address from, uint256 amount) private {
        uint256 held = IERC20V2(token).balanceOf(address(this));
        uint256 had = IERC20V2(token).balanceOf(from);
        _call(token, abi.encodeCall(IERC20V2.transferFrom, (from, address(this), amount)));
        if (IERC20V2(token).balanceOf(address(this)) != held + amount || IERC20V2(token).balanceOf(from) + amount != had) revert InexactTransfer(token);
    }
    function _push(address token, address to, uint256 amount) private {
        uint256 held = IERC20V2(token).balanceOf(address(this));
        uint256 had = IERC20V2(token).balanceOf(to);
        _call(token, abi.encodeCall(IERC20V2.transfer, (to, amount)));
        if (IERC20V2(token).balanceOf(address(this)) + amount != held || IERC20V2(token).balanceOf(to) != had + amount) revert InexactTransfer(token);
    }
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory answer) = token.call(data);
        if (!ok || (answer.length == 0 ? token.code.length == 0 : !abi.decode(answer, (bool)))) revert TransferFailed(token);
    }
}
