# Round 3 broker deals

The implementation starts from official base `9c00adeb195565c6ffdb928fe8a9056e73bf1bdd`. All three frozen check directories and the workflow match that base. All existing Solidity sources and interfaces match it too. Round 1 and Round 2 retain their routes, deployment commands and contract configuration fields.

## Run locally

Use Node 22 or newer and a host that permits a loopback HTTP listener and Chromium.

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run build
npm run check
npm test
npm run prove:v3
npm run play:v3
npm run dev
```

For separate frozen output with all rounds attempted even if an earlier one fails:

```sh
for round in 1 2 3; do
  LAUNCHPAD_GATE_OUT="evidence/round-3/frozen-round-$round.json" node ".launchpad/checks/round-$round/run.mjs"
done
```

`npm run dev` prints the local address and test wallet and token addresses. Open `/#/v3/new`, use the Broker wallet and enter the seller and buyer from the demo bar. Use FAM as the base token, USDC as the payment token and a quote of 100000 or 123.456789. Review, create and copy the proposal. Open the same link with the Seller, then Buyer, using the local wallet switcher. For vesting, use the default 30-day cliff and 90-day duration, then advance chain time and claim as the buyer. Use `/#/v3/deals` to browse the connected wallet's history. The dev wallet and its fixture keys are for the in-process chain.

The optional version 3 config fields are `contractV3` and `fromBlockV3` alongside the existing chain, RPC and explorer settings. Use the deployment block for `fromBlockV3` so history queries begin at the right block. The command for a separate local or testnet deployment is `RPC_URL=… DEPLOYER_KEY=… TREASURY=… npm run deploy:v3`. Deployment secrets come from the environment. The configured RPC must serve `eth_getLogs`, transaction receipts, block reads and ERC-20 calls.

## Judge criteria

| Criterion | Implementation and evidence |
| --- | --- |
| **C1 · Authorization and settlement** | [BrokerDeals.sol](../../contracts/BrokerDeals.sol) binds a seller and buyer EIP-712 signature to the same terms and domain. Actor checks and a seller-scoped nonce guard execution. The authorization scenario in [contract-proof.json](contract-proof.json) contains actual reverted receipts for wrong actor, altered terms, wrong chain or verifying contract, nonce reuse and expiry. Raw balances and logs are checked after rejection. Frozen R3-01, R3-02 and R3-04 passed. |
| **C2 · Fees and vesting** | [Contract proof](contract-proof.json) records exact before/after balances, raw deltas, transaction receipts, vault balances and claim amounts. It covers all four fee fixtures, blocked delivery, seller refund, settlement-relative and fixed starts, cliff and final claims, and an unrelated claimant. Frozen R3-03 and R3-05 passed. Round 2 and the Round 1 contract checks passed. |
| **C3 · Broker to buyer workflow** | [Browser runner](../../scripts/play-v3.mjs) exercises proposal review and clipboard, independent seller funding, fresh no-wallet and buyer previews, immediate and vesting settlement, expiry and refunds, and beneficiary claims. It runs both widths with independent profiles and asserts the broker requested neither signatures nor transactions. Execution in this session was blocked before rendering. |
| **C4 · Receipts and history** | [Browser routes and views](../../web/v3-page.js) show domain, roles, fees, canonical transaction hashes, confirmation status and a configured explorer link. The browser runner covers wrong wallet, wrong chain, wallet rejection, keyboard focus, reload, copy, duplication and role-scoped history. The in-process proof independently verifies the history event queries, receipt hashes and balance deltas. |
| **C5 · Maintainability and proof** | Version 3 uses a separate contract and route namespace. Browser code shares existing wallet, token, transaction and amount helpers. The EIP-712 digest is verified against the deployed contract. This document contains the commands, run outcomes and limitations. |

### Exact USDC fixture deltas

Values below are signed integers in raw USDC units, with six decimals. The full proof includes both token balances for seller, buyer, broker, unrelated wallet, treasury, escrow and any grant vault.

| Agreed quote | Broker share | Buyer | Seller | Broker | Treasury |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100000000000 | 0% | -100500000000 | +99500000000 | 0 | +1000000000 |
| 100000000000 | 20% | -100500000000 | +99500000000 | +200000000 | +800000000 |
| 123456789 | 0% | -124074072 | +122839506 | 0 | +1234566 |
| 123456789 | 20% | -124074072 | +122839506 | +246913 | +987653 |

Each party fee is independently floored before the broker share is calculated from their sum. The proof asserts zero quote movement during funding, refund and claim and zero movement in either token after failed settlement.

### Browser artifacts

`npm run play:v3` writes `screens/<scene>-390.jpg`, `screens/<scene>-1440.jpg` and `browser-proof.json` here. Set `BROKER_EVIDENCE_DIR` to use another output directory. Set `BROKER_VIEWPORT=390` or `BROKER_VIEWPORT=1440` to run a single viewport. Scene names and the matching screenshot and receipt assertions are in the runner. Screens 01–06 show proposal, sharing, seller funding and participant checks. Screens 07–09 show recovery and a receipt after reload. Screens 10–14 show vesting and beneficiary claims. Screens 15–17 show refunds and local and fresh-profile deal books.

### Results on this VPS

| Command or suite | Result |
| --- | --- |
| `npm run build` | Passed. |
| [Round 1 frozen](frozen-round-1.json) | 11 contract checks passed. Five browser checks were blocked by `listen EPERM` for 127.0.0.1. |
| [Round 2 frozen](frozen-round-2.json) | 7/7 passed. |
| [Round 3 frozen](frozen-round-3.json) | 5/5 passed. |
| Previous-round ABI, units and contract regressions | 38/38 assertions passed across five test files. |
| Full `npm test` | Deploy, dev and the two legacy browser suites failed in this session. Local HTTP listens are denied and direct Chromium startup aborts on a sandbox-denied `shutdown` syscall. |
| `npm run prove:v3` | Eight in-process scenarios passed. [Machine-readable evidence](contract-proof.json) includes settlement, refund and claim receipts and failed-transaction receipts. |
| `npm run play:v3` | Blocked by the denied loopback listen before either viewport rendered. Screenshot and browser receipt files still require a browser-capable run. |

Tests used Node 24.15.0 and the existing locked tool versions on the VPS. An offline clean install could not fetch an uncached registry package. The installed packages were reused.

## Operational boundaries

The proposal is an unsigned bearer link. Before funding, the two counterparties should verify its recipient, token, schedule and fee terms against their agreement. After funding, the chain anchors the terms to the same digest. Browser-local draft history follows the connected address and storage on that origin. Funded deal history is recovered from indexed onchain events in a fresh browser.

The contract accepts canonical EOA signatures using `eth_signTypedData_v4`. Smart-contract signature verification and external vesting positions are outside this implementation. Refunds and claims use the Round 2 withdrawal rules. Recipient-taxed tokens can reduce the amount their owner receives on withdrawal. Funding and settlement reject transfers that fail to move the exact required amounts. The production broker rate and eligibility, an independent audit and testnet beta remain open.
