// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Minimal ERC-1271 fixture. The owner registers a digest and proof and submits calls from this wallet.
contract SignatureWallet {
    address private immutable owner = msg.sender;
    bytes32 private digest;
    bytes32 private proofHash;

    function authorize(bytes32 digest_, bytes calldata proof) external {
        require(msg.sender == owner);
        digest = digest_;
        proofHash = keccak256(proof);
    }

    function isValidSignature(bytes32 digest_, bytes calldata proof) external view returns (bytes4) {
        return digest_ == digest && keccak256(proof) == proofHash ? this.isValidSignature.selector : bytes4(0xffffffff);
    }

    function execute(address target, bytes calldata data) external {
        require(msg.sender == owner);
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }
}
