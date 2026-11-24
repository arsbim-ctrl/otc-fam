// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IBrokerDeals {
    struct BrokerTerms {
        address seller;
        address buyer;
        address baseToken;
        address quoteToken;
        uint256 allocation;
        uint256 quote;
        uint64 expiry;
        uint256 nonce;
        uint8 delivery;
        uint64 fixedStart;
        uint64 cliffSeconds;
        uint64 durationSeconds;
        address broker;
        uint16 brokerBps;
    }

    struct Grant {
        address token;
        address beneficiary;
        address custodian;
        uint256 allocation;
        uint64 start;
        uint64 cliff;
        uint64 end;
        uint256 claimed;
    }

    event BrokerDealFunded(bytes32 indexed dealId, address indexed seller, address indexed broker);
    event BrokerDealSettled(bytes32 indexed dealId, address indexed buyer, uint256 buyerFee,
        uint256 sellerFee, uint256 brokerFee, uint256 treasuryFee, uint256 grantId);
    event BrokerDealRefunded(bytes32 indexed dealId);

    function fund(BrokerTerms calldata terms, bytes calldata sellerSignature) external;
    function settle(bytes32 dealId, bytes calldata buyerSignature) external;
    function refund(bytes32 dealId) external;
    function getDeal(bytes32 dealId) external view returns (BrokerTerms memory terms, uint8 status, uint256 grantId);
    function getGrant(uint256 grantId) external view returns (Grant memory);
    function claim(uint256 grantId) external;
}
