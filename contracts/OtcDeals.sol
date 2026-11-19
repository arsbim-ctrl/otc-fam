// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOtcDeals} from "./IOtcDeals.sol";

/// The three calls of an ERC-20 this contract makes.
interface IERC20Minimal {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title OtcDeals: the deals of otc.fam, each one an offer to swap two tokens.
/// @notice createDeal moves the maker's sellAmount into this contract, where it stays until the deal ends:
/// fill gives it to the taker in the same transaction as the taker's buyAmount goes to the maker, and cancel
/// gives it back to the maker. Nothing else moves tokens. There is no owner, no fee, no upgrade, no pause.
/// @dev Every transfer happens after the deal's new status is written, and a lock refuses any call back
/// into createDeal, fill or cancel while one of them runs (a token's transfer can call this contract).
contract OtcDeals is IOtcDeals {
    error ZeroAmount();
    error SameToken();
    error ExpiryNotInFuture();
    error NotAToken(address token);
    error TokenTookAFee(address token);
    error NotOpen(uint256 id);
    error DealExpired(uint256 id);
    error NotYourDeal(uint256 id, address taker);
    error NotMaker(uint256 id);
    error TransferFailed(address token);
    error Reentered();

    /// The id of the last deal created; the first deal is 1.
    uint256 private lastId;
    mapping(uint256 => Deal) private deals;
    /// Set while createDeal, fill or cancel runs: a call back into any of them fails.
    bool private transient locked;

    modifier oneAtATime() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    /// @notice Offers `sellAmount` of `sellToken` for `buyAmount` of `buyToken`, to `taker` only, or to anyone
    /// if `taker` is address(0), until `expiry` (unix seconds). The caller must have approved this contract for
    /// `sellAmount` of `sellToken`: it is taken now and held until the deal is filled or cancelled.
    function createDeal(address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, address taker, uint64 expiry)
        external
        oneAtATime
        returns (uint256 id)
    {
        if (sellAmount == 0 || buyAmount == 0) revert ZeroAmount();
        if (sellToken == buyToken) revert SameToken();
        if (expiry <= block.timestamp) revert ExpiryNotInFuture();
        if (sellToken.code.length == 0) revert NotAToken(sellToken);
        if (buyToken.code.length == 0) revert NotAToken(buyToken);

        id = ++lastId;
        deals[id] = Deal(msg.sender, taker, sellToken, sellAmount, buyToken, buyAmount, expiry, Status.Open);
        emit DealCreated(id, msg.sender, taker);

        // The deal must hold exactly sellAmount: a token that keeps part of a transfer would leave it short,
        // and its fill or cancel would then be paid with the tokens of another maker's deal.
        uint256 held = IERC20Minimal(sellToken).balanceOf(address(this));
        _transferFrom(sellToken, msg.sender, address(this), sellAmount);
        if (IERC20Minimal(sellToken).balanceOf(address(this)) != held + sellAmount) revert TokenTookAFee(sellToken);
    }

    /// @notice Swaps deal `id`: the caller pays `buyAmount` of `buyToken` to the maker and receives the deal's
    /// `sellAmount` of `sellToken`, both in this transaction or neither. The caller must have approved this
    /// contract for `buyAmount`.
    function fill(uint256 id) external oneAtATime {
        Deal storage deal = deals[id];
        if (deal.status != Status.Open) revert NotOpen(id);
        if (block.timestamp >= deal.expiry) revert DealExpired(id);
        if (deal.taker != address(0) && deal.taker != msg.sender) revert NotYourDeal(id, deal.taker);

        deal.status = Status.Filled;
        emit DealFilled(id, msg.sender);

        _transferFrom(deal.buyToken, msg.sender, deal.maker, deal.buyAmount);
        _transfer(deal.sellToken, msg.sender, deal.sellAmount);
    }

    /// @notice Withdraws deal `id`, open or expired, and gives its `sellAmount` back to the maker, its only caller.
    function cancel(uint256 id) external oneAtATime {
        Deal storage deal = deals[id];
        if (deal.status != Status.Open) revert NotOpen(id);
        if (msg.sender != deal.maker) revert NotMaker(id);

        deal.status = Status.Cancelled;
        emit DealCancelled(id);

        _transfer(deal.sellToken, deal.maker, deal.sellAmount);
    }

    /// @notice Deal `id` as it stands; for an id no deal has, a deal of zeros with status None.
    function getDeal(uint256 id) external view returns (Deal memory) {
        return deals[id];
    }

    function _transfer(address token, address to, uint256 amount) private {
        _callToken(token, abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
    }

    function _transferFrom(address token, address from, address to, uint256 amount) private {
        _callToken(token, abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
    }

    /// Calls `token` and fails unless it answers as an ERC-20 that did the transfer: `true`, or nothing at all
    /// (as USDT does). A revert, `false`, or an address with no code behind it fails the whole transaction.
    function _callToken(address token, bytes memory call) private {
        (bool ok, bytes memory answer) = token.call(call);
        if (!ok || (answer.length == 0 ? token.code.length == 0 : !abi.decode(answer, (bool)))) revert TransferFailed(token);
    }
}
