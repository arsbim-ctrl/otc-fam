// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IOtcDeals} from "./IOtcDeals.sol";

interface IERC20DealToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract OtcDeals is IOtcDeals {
    error InvalidTokens();
    error InvalidAmounts();
    error DealNotOpen();
    error DealExpired();
    error WrongTaker();
    error OnlyMaker();
    error ReentrantCall();
    error InsufficientTokenBalance(address token);
    error TransferFailed(address token);
    error InexactTransfer(address token);
    error InsufficientEscrow(address token);

    mapping(uint256 => Deal) private deals;
    mapping(address => uint256) private reserved;
    uint256 private lastId;
    bool private locked;

    struct Transfer {
        IERC20DealToken token;
        address from;
        address to;
        uint256 amount;
        uint256 fromBefore;
        uint256 toBefore;
    }

    modifier nonReentrant() {
        if (locked) revert ReentrantCall();
        locked = true;
        _;
        locked = false;
    }

    function createDeal(
        address sellToken,
        uint256 sellAmount,
        address buyToken,
        uint256 buyAmount,
        address taker,
        uint64 expiry
    ) external override nonReentrant returns (uint256 id) {
        if (sellToken == buyToken || sellToken.code.length == 0 || buyToken.code.length == 0) {
            revert InvalidTokens();
        }
        if (sellAmount == 0 || buyAmount == 0) revert InvalidAmounts();
        if (expiry <= block.timestamp) revert DealExpired();

        id = ++lastId;
        deals[id] = Deal(msg.sender, taker, sellToken, sellAmount, buyToken, buyAmount, expiry, Status.Open);

        Transfer memory deposit = snapshot(sellToken, msg.sender, address(this), sellAmount);
        if (deposit.toBefore < reserved[sellToken]) revert InsufficientEscrow(sellToken);
        reserved[sellToken] += sellAmount;
        transfer(deposit);
        checkBalances(deposit);
        emit DealCreated(id, msg.sender, taker);
    }

    function fill(uint256 id) external override nonReentrant {
        Deal storage deal = deals[id];
        if (deal.status != Status.Open) revert DealNotOpen();
        if (block.timestamp >= deal.expiry) revert DealExpired();
        if (deal.taker != address(0) && deal.taker != msg.sender) revert WrongTaker();

        deal.status = Status.Filled;
        Transfer memory payment = snapshot(deal.buyToken, msg.sender, deal.maker, deal.buyAmount);
        Transfer memory delivery = release(deal.sellToken, msg.sender, deal.sellAmount);
        transfer(payment);
        transfer(delivery);
        checkBalances(payment);
        checkBalances(delivery);
        // The buy token may also back a different deal's sell side.
        uint256 otherEscrow = reserved[deal.buyToken];
        if (otherEscrow != 0 && payment.token.balanceOf(address(this)) < otherEscrow) {
            revert InsufficientEscrow(deal.buyToken);
        }
        emit DealFilled(id, msg.sender);
    }

    function cancel(uint256 id) external override nonReentrant {
        Deal storage deal = deals[id];
        if (deal.status != Status.Open) revert DealNotOpen();
        if (deal.maker != msg.sender) revert OnlyMaker();
        deal.status = Status.Cancelled;
        Transfer memory refund = release(deal.sellToken, deal.maker, deal.sellAmount);
        transfer(refund);
        checkBalances(refund);
        emit DealCancelled(id);
    }

    function getDeal(uint256 id) external view override returns (Deal memory) {
        return deals[id];
    }

    function release(address token, address to, uint256 amount) private returns (Transfer memory move) {
        move = snapshot(token, address(this), to, amount);
        // A token that shrinks its balances must not let one offer consume another's reserve.
        uint256 outstanding = reserved[token];
        if (move.fromBefore < outstanding) revert InsufficientEscrow(token);
        reserved[token] = outstanding - amount;
    }

    function snapshot(address token, address from, address to, uint256 amount) private view returns (Transfer memory) {
        IERC20DealToken erc20 = IERC20DealToken(token);
        uint256 fromBefore = erc20.balanceOf(from);
        if (fromBefore < amount) revert InsufficientTokenBalance(token);
        uint256 toBefore = from == to ? fromBefore : erc20.balanceOf(to);
        return Transfer(erc20, from, to, amount, fromBefore, toBefore);
    }

    function transfer(Transfer memory move) private {
        // Legacy ERC-20s return no data. A returned value must be exactly true.
        bytes memory data = move.from == address(this)
            ? abi.encodeCall(IERC20DealToken.transfer, (move.to, move.amount))
            : abi.encodeCall(IERC20DealToken.transferFrom, (move.from, move.to, move.amount));
        (bool success, bytes memory result) = address(move.token).call(data);
        if (!success || (result.length != 0 && (result.length != 32 || abi.decode(result, (uint256)) != 1))) {
            revert TransferFailed(address(move.token));
        }
    }

    function checkBalances(Transfer memory move) private view {
        uint256 fromAfter = move.token.balanceOf(move.from);
        // A maker can fill their own open deal. A self-transfer has zero net effect.
        if (move.from == move.to) {
            if (fromAfter != move.fromBefore) revert InexactTransfer(address(move.token));
            return;
        }
        uint256 toAfter = move.token.balanceOf(move.to);
        if (fromAfter != move.fromBefore - move.amount || toAfter < move.toBefore || toAfter - move.toBefore != move.amount) {
            revert InexactTransfer(address(move.token));
        }
    }
}
