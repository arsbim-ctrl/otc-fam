// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Local test token: blocked recipients and callbacks during either transfer.
contract VaultToken {
    string public symbol = "VAULT";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public blocked;
    address public target;
    bytes public callback;
    bool public armed;
    bool public calledBack;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address to, uint256 amount) external returns (bool) { allowance[msg.sender][to] = amount; return true; }
    function blockRecipient(address to) external { blocked = to; }
    function arm(address target_, bytes calldata callback_) external {
        target = target_; callback = callback_; armed = true; calledBack = false;
    }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender,to,amount); return true; }
    function transferFrom(address from,address to,uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; _move(from,to,amount); return true;
    }
    function _move(address from,address to,uint256 amount) private {
        require(to != blocked, "recipient blocked");
        balanceOf[from] -= amount; balanceOf[to] += amount;
        if (armed) { armed = false; (calledBack,) = target.call(callback); }
    }
}
