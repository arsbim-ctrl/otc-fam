# Round 3 broker deals

The implementation starts from official base `9c00adeb195565c6ffdb928fe8a9056e73bf1bdd`. All three frozen check directories and the workflow match that base. All existing Solidity sources and interfaces match it too. Round 1 and Round 2 retain their routes, deployment commands and contract configuration fields.

## Run locally

Use Node 22 or newer and a host that permits a loopback HTTP listener and Chromium. The validation script runs the build, every frozen suite independently, the regression suite, the in-process proof and both browser widths. It prints a fresh directory for the logs, JSON and screenshots.

```sh
npm ci --ignore-scripts
npx playwright install chromium
bash scripts/validate-v3.sh
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

| Official criterion | Implementation and evidence |
| --- | --- |
| **C1 · Authorization and settlement (counts double)**. Seller and buyer remain distinct from the broker, signed terms bind the exact deal and domain, and failed transactions preserve balances. | Frozen R3-01 and R3-02 passed. Real EDR receipts show that wrong actor, altered terms, wrong chain, wrong verifying contract, nonce reuse, settlement replay and expiry revert with zero token movement and no emitted logs. The browser codec's digest matched the deployed contract. [Contract](../../contracts/BrokerDeals.sol) · [chain proof](contract-proof.json) |
| **C2 · Fees and vesting (counts double)**. Exact participant, broker and treasury deltas, no fees on failure or refund, fully funded grants, and all earlier checks pass. | Frozen R3-03 through R3-05 passed. The chain proof verified four raw-unit fee fixtures, atomic rollback, seller refunds, full vault backing, exact cliffs and claims for both start modes, and rejection of unrelated claims. UTC parsing and display passed with the process in America/Los_Angeles. Round 2 passed in full. Five Round 1 browser checks remain blocked. [Chain proof](contract-proof.json) |
| **C3 · Broker to buyer workflow (counts double)**. The broker, seller and fresh buyer complete the immediate and vesting scenarios described in the brief, with correct permissions and status. | The local chain reproduced the two settlement flows with independent fixture wallets. The browser runner covers unsigned proposal review and clipboard, fresh wallet-free and buyer previews, seller funding, immediate and vesting settlement, expiry, refund and claims. Browser execution is pending at both widths. [Browser runner](../../scripts/play-v3.mjs) |
| **C4 · Receipts and history**. Clear fee disclosure, role-scoped deal history, verifiable receipts, and accessible recovery on desktop and mobile. | The chain proof checked role-scoped log queries and canonical receipt hashes. The review corrected receipt access for expired funded deals, added exact allocation and seller to refund receipts, refreshed receipt verification on forced reads and fixed the copy fallback after history changes. Browser verification of the explorer link, receipt details, copy, duplication, wallet/network rejection, reload and keyboard focus is pending. [Deal view](../../web/v3-deal.js) · [History](../../web/v3-history.js) · [Browser runner](../../scripts/play-v3.mjs) |
| **C5 · Maintainability and proof**. Explicit versioning, reproducible tests, and documented evidence and limitations. | A separate V3 contract and route namespace share the wallet, transaction, amount and UTC helpers. The frozen checks, workflow and existing Solidity sources match the official base byte for byte. The validation command runs all suites and saves their actual results. [Validation script](../../scripts/validate-v3.sh) |

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

`npm run play:v3` writes `screens/<scene>-390.jpg`, `screens/<scene>-1440.jpg` and `browser-proof.json` here. Set `BROKER_EVIDENCE_DIR` to use another output directory. Set `BROKER_VIEWPORT=390` or `BROKER_VIEWPORT=1440` to run a single viewport. A full run expects 17 JPEGs and seven verified chain receipts per width. The runner decodes each JPEG and checks pixel dimensions and page overflow. Screens 01–06 cover proposal, sharing, seller funding and participant checks. Screens 07–09 cover recovery and a reloaded receipt. Screens 10–14 cover vesting and beneficiary claims, with a fixed UTC start at 1440px. Screens 15–17 cover refunds and deal books.

This session produced zero V3 screenshots and no browser proof JSON. Visual inspection, mobile and desktop layout, accessibility and wallet integration remain unverified.

### Results on this VPS

| Command or suite | Result |
| --- | --- |
| `npm run build` | Passed with Node 24.15.0. |
| [Round 1 frozen](frozen-round-1.json) | 11 contract checks passed. Five browser checks were blocked by `listen EPERM` for 127.0.0.1. |
| [Round 2 frozen](frozen-round-2.json) | 7/7 passed. |
| [Round 3 frozen](frozen-round-3.json) | 5/5 passed. |
| `npm test` | Five files passed. Four files reported failure under the sandbox across deploy, dev and the two legacy browser suites. |
| Detailed regression run | 39/69 passed with test isolation disabled for individual results. Thirty were blocked, comprising three deployment integrations, the dev-browser integration and 26 legacy browser tests. The negative deploy CLI test passed after changing the CLI to write its error before exiting. |
| `TZ=America/Los_Angeles npm run prove:v3` | Eight in-process scenarios passed. The machine-readable evidence contains 20 successful and 20 reverted transaction receipts. [Chain proof](contract-proof.json) |
| `npm run play:v3` | Exited 1 at `listen EPERM` on 127.0.0.1 before rendering. A direct launch of installed Chromium also exited at `shutdown: Operation not permitted`. The installed Chromium binary had zero unresolved shared libraries. |

The first browser attempt used the default Node 20.19.2. The validation script used Node 24.15.0 and the installed locked dependencies, including Playwright 1.63.0. The execution profile offers no host escalation for the listener or Chromium.

The official base already differs from the historical Round 1 commit `545cdb7b37` in `OtcDeals.sol`. That inherited change adds exact recipient-balance enforcement on fills. The Round 3 checkout preserves the official base contract and the frozen Round 1 checks.

## Operational boundaries

The proposal is an unsigned bearer link. Before funding, the two counterparties should verify its recipient, token, schedule and fee terms against their agreement. After funding, the chain anchors the terms to the same digest. Browser-local draft history follows the connected address and storage on that origin. Funded deal history is recovered from indexed onchain events in a fresh browser.

The contract accepts canonical EOA signatures using `eth_signTypedData_v4`. Smart-contract signature verification and external vesting positions are outside this implementation. Refunds and claims use the Round 2 withdrawal rules. Recipient-taxed tokens can reduce the amount their owner receives on withdrawal. Funding and settlement reject transfers that fail to move the exact required amounts. The production broker rate and eligibility, an independent audit and testnet beta remain open.
