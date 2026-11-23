// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Exact {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// ERC-20 transfers that preserve the agreed amount on both sides.
library ExactToken {
    error TransferFailed(address token);
    error InexactTransfer(address token);

    function pull(address token, address from, uint256 amount) internal {
        _move(token, from, address(this), amount, abi.encodeCall(
            IERC20Exact.transferFrom, (from, address(this), amount)
        ));
    }

    function push(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        _move(token, address(this), to, amount, abi.encodeCall(IERC20Exact.transfer, (to, amount)));
    }

    function _move(address token, address from, address to, uint256 amount, bytes memory data) private {
        uint256 fromBefore = IERC20Exact(token).balanceOf(from);
        uint256 toBefore = IERC20Exact(token).balanceOf(to);
        (bool ok, bytes memory answer) = token.call(data);
        if (!ok || (answer.length != 0 && (answer.length != 32 || abi.decode(answer, (uint256)) != 1))) {
            revert TransferFailed(token);
        }

        uint256 fromAfter = IERC20Exact(token).balanceOf(from);
        uint256 toAfter = IERC20Exact(token).balanceOf(to);
        if (fromAfter > fromBefore || fromBefore - fromAfter != amount
            || toAfter < toBefore || toAfter - toBefore != amount) {
            revert InexactTransfer(token);
        }
    }
}
