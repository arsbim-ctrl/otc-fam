// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Tokens that behave as some real ones do, for the tests in test/. Anyone can mint; never deploy them anywhere real.
/// Fee keeps 1% of every transfer. False answers false to every transfer and moves nothing. Reset refuses to change
/// an allowance that is not zero to another that is not zero, as USDT does.
contract EdgeToken {
    enum Kind { Fee, False, Reset }

    string public symbol;
    uint8 public immutable decimals;
    Kind public immutable kind;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_, uint8 decimals_, Kind kind_) {
        symbol = symbol_;
        decimals = decimals_;
        kind = kind_;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
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
        balanceOf[from] -= value;
        balanceOf[to] += kind == Kind.Fee ? value - value / 100 : value;
        return true;
    }
}
