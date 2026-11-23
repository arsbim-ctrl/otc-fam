// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TokenMoves} from "./TokenMoves.sol";

/// @title GrantVault: the tokens of one vesting grant, held apart from everything else.
/// @notice OtcDealsV2 makes one vault per grant, in the settlement transaction, and funds it with the grant's
/// whole allocation. The token and the beneficiary are written into the vault's code: it can only ever pay
/// that beneficiary, in that token. How much has vested is the deal contract's to say (it keeps the schedule),
/// and the vault's own balance is the most it can pay: one grant can never be paid out of another's tokens.
/// There is no owner, no upgrade and no way to move the tokens anywhere else.
contract GrantVault {
    error NotDeals();

    /// The deal contract that made this vault: the only caller of `pay`.
    address public immutable deals;
    address public immutable token;
    address public immutable beneficiary;

    constructor(address token_, address beneficiary_) {
        deals = msg.sender;
        token = token_;
        beneficiary = beneficiary_;
    }

    /// Pays `amount` of the grant's token to its beneficiary. Called by OtcDealsV2.claim with what has vested.
    function pay(uint256 amount) external {
        if (msg.sender != deals) revert NotDeals();
        TokenMoves.send(token, beneficiary, amount);
    }
}
