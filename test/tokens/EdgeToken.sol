// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Tokens that behave as some real ones do, for the tests in test/. Anyone can mint, and anyone can change how
/// the token behaves (as an upgradeable token's owner can); never deploy it anywhere real.
/// Fee: the recipient gets 1% less than sent. FeeOnTop: the sender pays 1% more than sent. False: every transfer
/// answers false and moves nothing. Reset: an allowance that is not zero cannot be changed to another that is not
/// zero, as USDT does.
contract EdgeToken {
    enum Kind { Plain, Fee, FeeOnTop, False, Reset, OutgoingFee }

    string public symbol;
    uint8 public immutable decimals;
    Kind public kind;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_, uint8 decimals_, Kind kind_) {
        symbol = symbol_;
        decimals = decimals_;
        kind = kind_;
    }

    function setKind(Kind kind_) external {
        kind = kind_;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    // Simulate an externally reduced balance, e.g. a negative token rebase.
    function burn(address from, uint256 value) external {
        balanceOf[from] -= value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        require(kind != Kind.Reset || value == 0 || allowance[msg.sender][spender] == 0, "set the allowance to 0 first");
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (kind == Kind.False) return false;
        allowance[from][msg.sender] -= value;
        return _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) private returns (bool) {
        if (kind == Kind.False) return false;
        uint256 fee = value / 100;
        balanceOf[from] -= kind == Kind.FeeOnTop ? value + fee : value;
        bool taxRecipient = kind == Kind.Fee || (kind == Kind.OutgoingFee && msg.sender == from);
        balanceOf[to] += taxRecipient ? value - fee : value;
        return true;
    }
}
