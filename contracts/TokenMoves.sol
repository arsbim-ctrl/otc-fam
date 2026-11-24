// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// The three calls of an ERC-20 the v2 contracts make.
interface IERC20Minimal {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// The token did not do the transfer: it reverted, answered `false`, or there is no contract at its address.
error TransferFailed(address token);
/// The token moved another amount than the one asked: it keeps a fee, charges one on top, or rebased.
error InexactTransfer(address token);

/// @title TokenMoves: the only three ways a token moves in OtcDealsV2 and its vaults.
/// @notice Every move reads the balances before and after, so a token is taken at its word about nothing.
/// `take` and `give` are the two halves of an exchange: both sides must move by exactly the amount, or the
/// whole transaction reverts. `send` returns tokens to their owner (a refund, a claim): the holder must give
/// up exactly the amount, so that nobody else's tokens pay for it, but what the token then delivers to its
/// owner is not a reason to refuse. Refusing would lock the owner's own tokens for as long as the token
/// misbehaves.
library TokenMoves {
    /// Takes `amount` of `token` from `from` into this contract: `from` loses and this contract gains exactly `amount`.
    function take(address token, address from, uint256 amount) internal {
        uint256 held = _balance(token, address(this));
        uint256 had = _balance(token, from);
        _call(token, abi.encodeCall(IERC20Minimal.transferFrom, (from, address(this), amount)));
        if (_balance(token, address(this)) != held + amount || _balance(token, from) + amount != had) revert InexactTransfer(token);
    }

    /// Pays `amount` of `token` from this contract to `to`: this contract loses and `to` gains exactly `amount`.
    function give(address token, address to, uint256 amount) internal {
        uint256 had = _balance(token, to);
        send(token, to, amount);
        if (_balance(token, to) != had + amount) revert InexactTransfer(token);
    }

    /// Returns `amount` of `token` from this contract to its owner `to`: this contract loses exactly `amount`.
    function send(address token, address to, uint256 amount) internal {
        uint256 held = _balance(token, address(this));
        _call(token, abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
        if (_balance(token, address(this)) + amount != held) revert InexactTransfer(token);
    }

    function _balance(address token, address owner) private view returns (uint256) {
        return IERC20Minimal(token).balanceOf(owner);
    }

    /// Calls `token` and fails unless it answers as an ERC-20 that did the transfer: `true`, or nothing at all
    /// (as USDT does). A revert, `false`, or an address with no code behind it fails the whole transaction.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory answer) = token.call(data);
        if (!ok || (answer.length == 0 ? token.code.length == 0 : !abi.decode(answer, (bool)))) revert TransferFailed(token);
    }
}
