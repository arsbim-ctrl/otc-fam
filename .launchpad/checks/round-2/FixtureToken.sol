// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PlainToken} from "../round-1/tokens/Tokens.sol";

/// Local-only token whose issuers can refuse outgoing delivery after a deal is funded.
contract FixtureToken is PlainToken {
    address public blockedSender;

    constructor(string memory symbol_, uint8 decimals_) PlainToken(symbol_, decimals_) {}

    function setBlockedSender(address sender) external {
        blockedSender = sender;
    }

    function _move(address from, address to, uint256 amount) internal override {
        require(from != blockedSender, "fixture transfer blocked");
        super._move(from, to, amount);
    }
}
