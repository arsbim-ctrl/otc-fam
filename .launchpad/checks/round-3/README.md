# Round 3 broker deal checks

Implement the versioned entry point as `contracts/BrokerDeals.sol`, contract `BrokerDeals`, with constructor `(address treasury)` and the interface in [IBrokerDeals.sol](IBrokerDeals.sol). The legacy and V2 contracts and the earlier Hotpod checks still apply.

Use EIP-712 domain name `OTC.fam Broker Deals`, version `3`, the current chain ID, and the deployed BrokerDeals address. The primary type is `BrokerTerms`, with the exact field names, types and order in the Solidity interface. Both signers sign those same terms. The deal ID is the full typed data digest. The seller submits their signed terms to fund. The designated buyer submits their signature to settle. Each seller can use a nonce once. Only the seller can refund a funded deal. The events in the interface link settlement receipts to the deal and grant.

Deal statuses are 0 for unfunded, 1 for funded, 2 for settled and 3 for refunded. Unknown deal IDs return status 0. Delivery modes are 0 for immediate and 1 for new vesting. An immediate deal has zero schedule fields and returns grant ID zero. A vesting deal supports a zero start for the settlement timestamp and a future fixed start. Use raw token amounts throughout. Each party's fee is 50 basis points rounded down. The broker receives the specified share of the sum of those fees, rounded down, and the treasury receives the rest. The 0 and 2,000 basis point inputs are test fixtures.

The gate checks authority, the exact payment splits for the two published quotes, rollback, refund and vesting backing against real local chain balances. It examines the contract logs used by the receipt views. The Hotpod product rubric covers wallet-free preview, role-specific browser history, exact fee disclosure, explorer links, recovery and both viewport sizes. Include those demonstrations and test output in your submission.

Run locally after installing the locked dependencies:

```sh
LAUNCHPAD_GATE_OUT=/tmp/otc-round3.json node .launchpad/checks/round-3/run.mjs
```
