// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IOtcDealsV2 {
    enum Status { None, Funded, Settled, Cancelled }
    enum Delivery { Immediate, NewVesting }

    struct Terms {
        address baseToken;
        address quoteToken;
        address buyer;
        uint256 allocation;
        uint256 quote;
        uint64 expiry;
        Delivery delivery;
        uint64 fixedStart;
        uint64 cliffSeconds;
        uint64 durationSeconds;
    }

    struct Grant {
        uint256 dealId;
        address token;
        address beneficiary;
        address custodian;
        uint256 allocation;
        uint64 start;
        uint64 cliff;
        uint64 end;
        uint256 claimed;
    }

    event DealFunded(uint256 indexed dealId, address indexed seller, address indexed buyer);
    event DealSettled(uint256 indexed dealId, uint256 grantId, uint256 buyerFee, uint256 sellerFee);
    event DealCancelled(uint256 indexed dealId);
    event GrantCreated(uint256 indexed grantId, uint256 indexed dealId, address indexed beneficiary);
    event GrantClaimed(uint256 indexed grantId, address indexed beneficiary, uint256 amount);

    function treasury() external view returns (address);
    function createDeal(Terms calldata terms) external returns (uint256 dealId);
    function fill(uint256 dealId) external;
    function cancel(uint256 dealId) external;
    function getDeal(uint256 dealId) external view returns (
        address seller, Terms memory terms, Status status, uint256 grantId
    );
    function getGrant(uint256 grantId) external view returns (Grant memory);
    function vested(uint256 grantId) external view returns (uint256);
    function claimable(uint256 grantId) external view returns (uint256);
    function claim(uint256 grantId) external;
}
