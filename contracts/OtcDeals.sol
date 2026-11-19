// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IOtcDeals} from "./IOtcDeals.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Immutable offers. Funds stay in wallets until both transfers settle atomically.
/// @dev Exact accounting supports ordinary and optional-return ERC-20s, not transfer taxes
/// or rebases during settlement. A dishonest token can still lie about its own balances.
contract OtcDeals is IOtcDeals, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidTerms();
    error InvalidToken();
    error NotOpen();
    error NotMaker();
    error NotTaker();
    error Expired();
    error InexactTransfer();

    mapping(uint256 => Deal) private deals;
    uint256 private nextId = 1;

    struct Balances {
        uint256 makerSell;
        uint256 takerSell;
        uint256 makerBuy;
        uint256 takerBuy;
        uint256 heldSell;
        uint256 heldBuy;
    }

    function createDeal(address sellToken, uint256 sellAmount, address buyToken,
        uint256 buyAmount, address taker, uint64 expiry
    ) external nonReentrant returns (uint256 id) {
        if (sellAmount == 0 || buyAmount == 0 || sellToken == buyToken || expiry <= block.timestamp) {
            revert InvalidTerms();
        }
        if (sellToken.code.length == 0 || buyToken.code.length == 0) revert InvalidToken();
        id = nextId++;
        deals[id] = Deal(msg.sender, taker, sellToken, sellAmount, buyToken, buyAmount, expiry, Status.Open);
        emit DealCreated(id, msg.sender, taker);
    }

    function fill(uint256 id) external nonReentrant {
        Deal memory d = deals[id];
        if (d.status != Status.Open) revert NotOpen();
        if (d.taker != address(0) && d.taker != msg.sender) revert NotTaker();
        if (block.timestamp >= d.expiry) revert Expired();

        // All failures below roll this state change, both transfers and their logs back.
        deals[id].status = Status.Filled;
        Balances memory before_ = balances(d, msg.sender);
        IERC20(d.buyToken).safeTransferFrom(msg.sender, d.maker, d.buyAmount);
        IERC20(d.sellToken).safeTransferFrom(d.maker, msg.sender, d.sellAmount);
        Balances memory after_ = balances(d, msg.sender);

        if (d.maker == msg.sender) {
            // Aliased participants have zero net movement, but still transfer and spend allowance.
            if (after_.makerSell != before_.makerSell || after_.makerBuy != before_.makerBuy) {
                revert InexactTransfer();
            }
        } else {
            debit(before_.makerSell, after_.makerSell, d.sellAmount);
            credit(before_.takerSell, after_.takerSell, d.sellAmount);
            debit(before_.takerBuy, after_.takerBuy, d.buyAmount);
            credit(before_.makerBuy, after_.makerBuy, d.buyAmount);
        }
        // Unsolicited deposits are never used or redistributed by settlement.
        if (after_.heldSell != before_.heldSell || after_.heldBuy != before_.heldBuy) revert InexactTransfer();
        emit DealFilled(id, msg.sender);
    }

    function cancel(uint256 id) external nonReentrant {
        Deal storage d = deals[id];
        if (d.status != Status.Open) revert NotOpen();
        if (msg.sender != d.maker) revert NotMaker();
        d.status = Status.Cancelled;
        emit DealCancelled(id);
    }

    function getDeal(uint256 id) external view returns (Deal memory) {
        return deals[id];
    }

    function balances(Deal memory d, address taker) private view returns (Balances memory b) {
        IERC20 sell = IERC20(d.sellToken);
        IERC20 buy = IERC20(d.buyToken);
        b = Balances(sell.balanceOf(d.maker), sell.balanceOf(taker), buy.balanceOf(d.maker),
            buy.balanceOf(taker), sell.balanceOf(address(this)), buy.balanceOf(address(this)));
    }

    function debit(uint256 before_, uint256 after_, uint256 amount) private pure {
        if (after_ > before_ || before_ - after_ != amount) revert InexactTransfer();
    }

    function credit(uint256 before_, uint256 after_, uint256 amount) private pure {
        if (after_ < before_ || after_ - before_ != amount) revert InexactTransfer();
    }
}
