// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Test-only adversary: unrestricted minting, arbitrary callbacks and deliberately broken ERC-20s.
contract AdversarialToken {
    string public symbol = "EDGE";
    uint8 public decimals = 6;
    mapping(address => uint256) private balances;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public mode;
    address public target;
    bytes public payload;
    bool public propagate;
    bool public calledBack;
    bytes public callbackResult;
    bool public armed;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function setMode(uint256 next) external { mode = next; }
    function setMetadata(string calldata s, uint8 d) external { symbol = s; decimals = d; }
    function balanceOf(address who) external view returns (uint256) {
        require(mode != 12, "balance unavailable");
        return balances[who];
    }
    function mint(address who, uint256 amount) external { balances[who] += amount; }
    function burn(address who, uint256 amount) external { balances[who] -= amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        if (mode == 11) require(amount == 0 || allowance[msg.sender][spender] == 0, "reset first");
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        if (mode == 2) assembly { return(0, 0) }
        return mode != 13;
    }
    function arm(address t, bytes calldata p, bool bubble) external {
        target = t; payload = p; propagate = bubble; armed = true; calledBack = false;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(mode != 3 && mode != 12, "blocked token");
        allowance[from][msg.sender] -= amount;
        if (mode == 4) return true;
        uint256 debit = amount + (mode == 8 ? 1 : 0);
        uint256 credit = amount - (mode == 7 ? 1 : 0);
        balances[from] -= debit;
        balances[to] += credit;
        emit Transfer(from, to, amount);
        if (armed) {
            armed = false;
            (calledBack, callbackResult) = target.call(payload);
            if (propagate) require(calledBack, "callback failed");
        }
        if (mode == 1) return false;
        if (mode == 2) assembly { return(0, 0) }
        if (mode == 5) assembly { mstore(0, 1) return(31, 1) }
        if (mode == 6) assembly { mstore(0, 2) return(0, 32) }
        return true;
    }
}
