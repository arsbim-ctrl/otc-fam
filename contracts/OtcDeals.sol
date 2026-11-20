// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IOtcDeals.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

/// One offer to swap two ERC-20 amounts between a maker and a taker. The contract holds the maker's
/// tokens from createDeal until the fill or the cancel, and nothing else: no owner, no fee, no upgrade.
contract OtcDeals is IOtcDeals {
    uint256 public dealCount;
    mapping(uint256 => Deal) private deals;

    function createDeal(address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, address taker, uint64 expiry) external returns (uint256 id) {
        require(sellAmount > 0 && buyAmount > 0, "zero amount");
        require(sellToken != buyToken, "same token");
        require(expiry > block.timestamp, "expiry not in the future");
        id = ++dealCount;
        deals[id] = Deal(msg.sender, taker, sellToken, sellAmount, buyToken, buyAmount, expiry, Status.Open);
        emit DealCreated(id, msg.sender, taker);
        uint256 held = IERC20(sellToken).balanceOf(address(this));
        _transfer(sellToken, msg.sender, address(this), sellAmount);
        // a token that takes a fee on the way in would leave a deal that can neither fill nor cancel
        require(IERC20(sellToken).balanceOf(address(this)) - held == sellAmount, "token took a fee");
    }

    function fill(uint256 id) external {
        Deal storage d = deals[id];
        require(d.status == Status.Open, "not open");
        require(block.timestamp < d.expiry, "expired");
        require(d.taker == address(0) || d.taker == msg.sender, "not your deal");
        d.status = Status.Filled; // written before any token runs: a re-entering fill or cancel finds it closed
        emit DealFilled(id, msg.sender);
        _transfer(d.buyToken, msg.sender, d.maker, d.buyAmount);
        _transfer(d.sellToken, address(this), msg.sender, d.sellAmount);
    }

    function cancel(uint256 id) external {
        Deal storage d = deals[id];
        require(d.status == Status.Open, "not open");
        require(d.maker == msg.sender, "not the maker");
        d.status = Status.Cancelled;
        emit DealCancelled(id);
        _transfer(d.sellToken, address(this), msg.sender, d.sellAmount);
    }

    function getDeal(uint256 id) external view returns (Deal memory) {
        return deals[id];
    }

    /// transfer (from this contract) or transferFrom, accepting a token that returns nothing (USDT) and
    /// refusing one that returns false, reverts, or is no contract at all.
    function _transfer(address token, address from, address to, uint256 amount) private {
        bytes memory call = from == address(this)
            ? abi.encodeWithSignature("transfer(address,uint256)", to, amount)
            : abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount);
        (bool ok, bytes memory data) = token.call(call);
        require(ok && (data.length == 0 ? token.code.length > 0 : abi.decode(data, (bool))), "transfer failed");
    }
}
