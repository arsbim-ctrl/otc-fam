// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOtcDealsV2} from "./IOtcDealsV2.sol";
import {ExactToken} from "./ExactToken.sol";

/// Holds the backing for settled grants separately from the escrow for open deals.
contract VestingVault {
    error OnlyDeals();
    error GrantAlreadyExists();
    error NothingToClaim();

    address private immutable deals = msg.sender;
    mapping(uint256 => IOtcDealsV2.Grant) private grants;

    modifier onlyDeals() {
        if (msg.sender != deals) revert OnlyDeals();
        _;
    }

    /// The deal contract transfers the full allocation here before calling this.
    function record(uint256 grantId, IOtcDealsV2.Grant calldata terms) external onlyDeals {
        if (grants[grantId].beneficiary != address(0)) revert GrantAlreadyExists();
        grants[grantId] = terms;
    }

    function getGrant(uint256 grantId) external view returns (IOtcDealsV2.Grant memory) {
        return grants[grantId];
    }

    function vested(uint256 grantId) public view returns (uint256) {
        return _vested(grants[grantId]);
    }

    function claimable(uint256 grantId) public view returns (uint256) {
        IOtcDealsV2.Grant storage grant = grants[grantId];
        return _vested(grant) - grant.claimed;
    }

    function release(uint256 grantId) external onlyDeals returns (address beneficiary, uint256 amount) {
        IOtcDealsV2.Grant storage grant = grants[grantId];
        amount = _vested(grant) - grant.claimed;
        if (amount == 0) revert NothingToClaim();
        grant.claimed += amount;
        beneficiary = grant.beneficiary;
        ExactToken.push(grant.token, beneficiary, amount);
    }

    function _vested(IOtcDealsV2.Grant storage grant) private view returns (uint256) {
        uint256 timestamp = block.timestamp;
        if (timestamp < grant.cliff) return 0;
        uint256 allocation = grant.allocation;
        if (timestamp >= grant.end) return allocation;

        uint256 duration = grant.end - grant.start;
        uint256 elapsed = timestamp - grant.start;
        // (A / d) * elapsed <= A. Both remainder and elapsed fit in uint64.
        return (allocation / duration) * elapsed + (allocation % duration) * elapsed / duration;
    }
}
