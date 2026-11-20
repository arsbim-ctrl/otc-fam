// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IOtcDeals} from "./IOtcDeals.sol";

interface IDealToken {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address account, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract OtcDeals is IOtcDeals {
    error ReentrantCall();
    error ZeroAmount();
    error SameToken();
    error TokenHasNoCode(address token);
    error DealExpired();
    error DealNotOpen();
    error WrongTaker();
    error OnlyMaker();
    error InvalidTokenAllowance(address token);
    error InsufficientAllowance(address token);
    error TokenTransferFailed(address token);
    error InexactTransfer(address token);
    error InsufficientEscrow(address token);

    mapping(uint256 => Deal) private _deals;
    mapping(address => uint256) private _reserved;
    uint256 private _lastId;
    bool private _entered;

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    function createDeal(
        address sellToken,
        uint256 sellAmount,
        address buyToken,
        uint256 buyAmount,
        address taker,
        uint64 expiry
    ) external override nonReentrant returns (uint256 id) {
        if (sellAmount == 0 || buyAmount == 0) revert ZeroAmount();
        if (sellToken == buyToken) revert SameToken();
        if (expiry <= block.timestamp) revert DealExpired();
        if (sellToken.code.length == 0) revert TokenHasNoCode(sellToken);
        if (buyToken.code.length == 0) revert TokenHasNoCode(buyToken);
        if (_allowance(sellToken, msg.sender) < sellAmount) revert InsufficientAllowance(sellToken);

        // ERC-721 shares balanceOf and transferFrom with ERC-20. Check both sides before taking escrow.
        _allowance(buyToken, msg.sender);

        (, uint256 collateral) = _moveExact(sellToken, msg.sender, address(this), sellAmount);
        uint256 required = _reserved[sellToken] + sellAmount;
        if (collateral < required) revert InsufficientEscrow(sellToken);
        _reserved[sellToken] = required;

        id = ++_lastId;
        _deals[id] = Deal(msg.sender, taker, sellToken, sellAmount, buyToken, buyAmount, expiry, Status.Open);
        emit DealCreated(id, msg.sender, taker);
    }

    function fill(uint256 id) external override nonReentrant {
        Deal storage deal = _deals[id];
        if (deal.status != Status.Open) revert DealNotOpen();
        if (block.timestamp >= deal.expiry) revert DealExpired();
        if (deal.taker != address(0) && msg.sender != deal.taker) revert WrongTaker();

        deal.status = Status.Filled;
        _moveExact(deal.buyToken, msg.sender, deal.maker, deal.buyAmount);
        _release(deal, msg.sender);
        emit DealFilled(id, msg.sender);
    }

    function cancel(uint256 id) external override nonReentrant {
        Deal storage deal = _deals[id];
        if (deal.status != Status.Open) revert DealNotOpen();
        if (msg.sender != deal.maker) revert OnlyMaker();

        deal.status = Status.Cancelled;
        _release(deal, deal.maker);
        emit DealCancelled(id);
    }

    function getDeal(uint256 id) external view override returns (Deal memory) {
        return _deals[id];
    }

    function _allowance(address token, address account) private view returns (uint256) {
        (bool success, bytes memory result) =
            token.staticcall(abi.encodeCall(IDealToken.allowance, (account, address(this))));
        if (!success || result.length != 32) revert InvalidTokenAllowance(token);
        return abi.decode(result, (uint256));
    }

    function _release(Deal storage deal, address recipient) private {
        address token = deal.sellToken;
        uint256 required = _reserved[token] - deal.sellAmount;
        _reserved[token] = required;
        (uint256 collateral,) = _moveExact(token, address(this), recipient, deal.sellAmount);

        // A deficit (for example after a negative rebase) cannot be left to the next maker.
        if (collateral < required) revert InsufficientEscrow(token);
    }

    function _moveExact(address token, address from, address to, uint256 amount)
        private
        returns (uint256 debitBalance, uint256 creditBalance)
    {
        IDealToken erc20 = IDealToken(token);
        uint256 previousDebit = erc20.balanceOf(from);
        if (previousDebit < amount) revert InexactTransfer(token);
        uint256 previousCredit = from == to ? previousDebit : erc20.balanceOf(to);

        bytes memory data = from == address(this)
            ? abi.encodeCall(IDealToken.transfer, (to, amount))
            : abi.encodeCall(IDealToken.transferFrom, (from, to, amount));
        (bool success, bytes memory result) = token.call(data);
        if (!success || (result.length != 0 && (result.length != 32 || abi.decode(result, (uint256)) != 1))) {
            revert TokenTransferFailed(token);
        }

        debitBalance = erc20.balanceOf(from);
        // The maker can be the taker. Self-payment leaves the buy balance unchanged.
        if (from == to) {
            if (debitBalance != previousDebit) revert InexactTransfer(token);
            return (debitBalance, debitBalance);
        }
        creditBalance = erc20.balanceOf(to);
        if (debitBalance != previousDebit - amount || creditBalance < previousCredit
            || creditBalance - previousCredit != amount) revert InexactTransfer(token);
    }
}
