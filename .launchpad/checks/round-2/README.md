# Round 2 acceptance checks

Implement `OtcDealsV2` in `contracts/OtcDealsV2.sol` with the interface in [IOtcDealsV2.sol](IOtcDealsV2.sol) and a single `address treasury` constructor argument. The original `IOtcDeals` and Round 1 checks still apply to the legacy contract.

- Terms use token base units and onchain Unix seconds. `fixedStart = 0` means start at settlement; otherwise it is a future timestamp. For immediate delivery, use zero for all schedule fields.
- The seller calls `createDeal` with an allowance, and the full allocation moves to the deal contract in that transaction. Deal IDs and grant IDs are nonzero. A funded deal without a grant reports grant ID zero.
- For vesting, `getGrant` reports the address holding the backing balance in `custodian`. The deal contract or a separate vesting vault can hold it. The caller of `claim` can be limited to the buyer or permissionless. Either way, positive claims pay only the buyer. A zero claim can revert or leave balances unchanged.
- The harness runs Solidity with local EVM state, synthetic accounts, and mock tokens. It uses the frozen Round 1 toolchain and writes Hotpod's named JSON report. No network services or keys are needed.
- The suite covers the onchain parts of R2-01 through R2-07. The failed-delivery fixture refuses an outgoing token transfer. If the submission uses a separate grant factory, show its specific rollback case in submission evidence. Wrong-network behavior, unsupported positions, the fresh-browser flows in R2-08, and the known Round 1 usability fixes remain in the product rubric.

From the repo root, after installing the locked dependencies:

```sh
LAUNCHPAD_GATE_OUT=/tmp/otc-round2-report.json node .launchpad/checks/round-2/run.mjs
```
