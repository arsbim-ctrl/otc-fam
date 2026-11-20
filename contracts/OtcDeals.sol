// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IOtcDeals} from "./IOtcDeals.sol";

interface IERC20Settlement {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract OtcDeals is IOtcDeals {
    error InvalidTerms();
    error DealNotOpen();
    error DealExpired();
    error Unauthorized();
    error ReentrantCall();
    error TransferFailed(address token);
    error InexactTransfer(address token);
    error EscrowShortfall(address token);

    uint256 private lastId;
    mapping(uint256 => Deal) private deals;
    mapping(address => uint256) private reserved;
    bool private settling;

    struct Balances {
        uint256 sender;
        uint256 recipient;
    }

    modifier nonReentrant() {
        if (settling) revert ReentrantCall();
        settling = true;
        _;
        settling = false;
    }

    function createDeal(
        address sellToken,
        uint256 sellAmount,
        address buyToken,
        uint256 buyAmount,
        address taker,
        uint64 expiry
    ) external override nonReentrant returns (uint256 id) {
        if (
            sellAmount == 0 || buyAmount == 0 || sellToken == buyToken ||
            sellToken.code.length == 0 || buyToken.code.length == 0 || expiry <= block.timestamp
        ) revert InvalidTerms();

        id = ++lastId;
        deals[id] = Deal(msg.sender, taker, sellToken, sellAmount, buyToken, buyAmount, expiry, Status.Open);
        reserved[sellToken] += sellAmount;
        Balances memory beforeDeposit = balances(sellToken, msg.sender, address(this));
        transfer(sellToken, abi.encodeCall(IERC20Settlement.transferFrom, (msg.sender, address(this), sellAmount)));
        Balances memory afterDeposit = balances(sellToken, msg.sender, address(this));
        requireExactChange(sellToken, sellAmount, beforeDeposit, afterDeposit);
        requireCovered(sellToken, afterDeposit.recipient);
        emit DealCreated(id, msg.sender, taker);
    }

    function fill(uint256 id) external override nonReentrant {
        Deal storage deal = deals[id];
        if (deal.status != Status.Open) revert DealNotOpen();
        if (block.timestamp >= deal.expiry) revert DealExpired();
        if (deal.taker != address(0) && deal.taker != msg.sender) revert Unauthorized();

        deal.status = Status.Filled;
        reserved[deal.sellToken] -= deal.sellAmount;
        // Any failure rolls back both legs and restores the reservation.
        Balances memory buyBefore = balances(deal.buyToken, msg.sender, deal.maker);
        Balances memory sellBefore = balances(deal.sellToken, address(this), msg.sender);
        transfer(deal.buyToken, abi.encodeCall(IERC20Settlement.transferFrom, (msg.sender, deal.maker, deal.buyAmount)));
        transfer(deal.sellToken, abi.encodeCall(IERC20Settlement.transfer, (msg.sender, deal.sellAmount)));

        Balances memory buyAfter = balances(deal.buyToken, msg.sender, deal.maker);
        Balances memory sellAfter = balances(deal.sellToken, address(this), msg.sender);
        // In a self-fill, only the buy leg is a self-transfer.
        requireExactChange(deal.buyToken, msg.sender == deal.maker ? 0 : deal.buyAmount, buyBefore, buyAfter);
        requireExactChange(deal.sellToken, deal.sellAmount, sellBefore, sellAfter);
        requireCovered(deal.sellToken, sellAfter.sender);
        if (reserved[deal.buyToken] != 0) {
            requireCovered(deal.buyToken, IERC20Settlement(deal.buyToken).balanceOf(address(this)));
        }
        emit DealFilled(id, msg.sender);
    }

    function cancel(uint256 id) external override nonReentrant {
        Deal storage deal = deals[id];
        if (deal.status != Status.Open) revert DealNotOpen();
        if (deal.maker != msg.sender) revert Unauthorized();

        deal.status = Status.Cancelled;
        reserved[deal.sellToken] -= deal.sellAmount;
        Balances memory beforeRefund = balances(deal.sellToken, address(this), deal.maker);
        transfer(deal.sellToken, abi.encodeCall(IERC20Settlement.transfer, (deal.maker, deal.sellAmount)));
        Balances memory afterRefund = balances(deal.sellToken, address(this), deal.maker);
        requireExactChange(deal.sellToken, deal.sellAmount, beforeRefund, afterRefund);
        requireCovered(deal.sellToken, afterRefund.sender);
        emit DealCancelled(id);
    }

    function getDeal(uint256 id) external view override returns (Deal memory) {
        return deals[id];
    }

    function balances(address token, address from, address to) private view returns (Balances memory result) {
        IERC20Settlement erc20 = IERC20Settlement(token);
        result.sender = erc20.balanceOf(from);
        result.recipient = from == to ? result.sender : erc20.balanceOf(to);
    }

    function transfer(address token, bytes memory data) private {
        (bool success, bytes memory result) = token.call(data);
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TransferFailed(token);
        }
    }

    function requireExactChange(
        address token,
        uint256 amount,
        Balances memory beforeTransfer,
        Balances memory afterTransfer
    ) private pure {
        if (
            afterTransfer.sender > beforeTransfer.sender || beforeTransfer.sender - afterTransfer.sender != amount ||
            afterTransfer.recipient < beforeTransfer.recipient || afterTransfer.recipient - beforeTransfer.recipient != amount
        ) revert InexactTransfer(token);
    }

    function requireCovered(address token, uint256 balance) private view {
        if (balance < reserved[token]) revert EscrowShortfall(token);
    }
}
