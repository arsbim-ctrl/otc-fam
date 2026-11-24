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
out=$(mktemp -d)
for round in 1 2 3; do
  LAUNCHPAD_GATE_OUT="$out/frozen-round-$round.json" node ".launchpad/checks/round-$round/run.mjs"
done
```

`npm run dev` prints the local address and test wallet and token addresses. Open `/#/v3/new`, use the Broker wallet and enter the seller and buyer from the demo bar. Use FAM as the base token, USDC as the payment token and a quote of 100000 or 123.456789. Review, create and copy the proposal. Open the same link with the Seller, then Buyer, using the local wallet switcher. For vesting, use the default 30-day cliff and 90-day duration, then advance chain time and claim as the buyer. Use `/#/v3/deals` to browse the connected wallet's history. The dev wallet and its fixture keys are for the in-process chain.

The optional version 3 config fields are `contractV3` and `fromBlockV3` alongside the existing chain, RPC and explorer settings. Use the deployment block for `fromBlockV3` so history queries begin at the right block. The command for a separate local or testnet deployment is `RPC_URL=… DEPLOYER_KEY=… TREASURY=… npm run deploy:v3`. Deployment secrets come from the environment. The configured RPC must serve `eth_getLogs`, transaction receipts, block reads and ERC-20 calls.

## Judge criteria

| Official criterion | Implementation and evidence |
| --- | --- |
| **C1 · Authorization and settlement (counts double)**. Seller and buyer remain distinct from the broker, signed terms bind the exact deal and domain, and failed transactions preserve balances. | Frozen R3-01 and R3-02 passed. Real EDR receipts show that wrong actor, altered terms, wrong chain, wrong verifying contract, nonce reuse, settlement replay and expiry revert with zero token movement and no emitted logs. The browser codec's digest matched the deployed contract. [Contract](../../contracts/BrokerDeals.sol) · [chain proof](contract-proof.json) |
| **C2 · Fees and vesting (counts double)**. Exact participant, broker and treasury deltas, no fees on failure or refund, fully funded grants, and all earlier checks pass. | All three frozen suites passed on the host. The chain proof verifies four raw-unit fee fixtures, atomic rollback, seller refunds, full vault backing, both vesting start modes and beneficiary-only claims. UTC parsing and display passed with the process in America/Los_Angeles. [Chain proof](host/contract-proof.json) |
| **C3 · Broker to buyer workflow (counts double)**. The broker, seller and fresh buyer complete the immediate and vesting scenarios described in the brief, with correct permissions and status. | Both widths passed unsigned proposal review and copying, fresh previews, seller funding, designated buyer settlement, expiry, seller refund and beneficiary claims. Fixed-start terms and history show the earlier cutoff when it precedes the signed expiry. [Browser runner](../../scripts/play-v3.mjs) · [Host browser proof](host/browser-proof.json) |
| **C4 · Receipts and history**. Clear fee disclosure, role-scoped deal history, verifiable receipts, and accessible recovery on desktop and mobile. | Both widths verified receipt and explorer URL construction, role-scoped history in fresh profiles, clipboard fallback, duplication, wrong network and wallet, connection and signature rejection, focus restoration and post-settlement reload. [Deal view](../../web/v3-deal.js) · [History](../../web/v3-history.js) · [Host browser proof](host/browser-proof.json) |
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

Run `BROKER_EVIDENCE_DIR="$(mktemp -d)" npm run play:v3` to write a fresh set of artifacts. Set `BROKER_VIEWPORT=390` or `BROKER_VIEWPORT=1440` to run one viewport. The runner checks pixel dimensions and page overflow and verifies receipts against the in-process chain. The [host browser proof](host/browser-proof.json) contains seven receipts per width and indexes all 34 [screenshots](host/screens/).

| Scene | 390px | 1440px |
| --- | --- | --- |
| Fee review | [01](host/screens/01-broker-review-immediate-390.jpg) | [01](host/screens/01-broker-review-immediate-1440.jpg) |
| Funded preview without a wallet | [05](host/screens/05-fresh-funded-preview-390.jpg) | [05](host/screens/05-fresh-funded-preview-1440.jpg) |
| Focus after signing rejection | [08](host/screens/08-signature-declined-focus-restored-390.jpg) | [08](host/screens/08-signature-declined-focus-restored-1440.jpg) |
| Settlement receipt after reload | [09](host/screens/09-settlement-receipt-after-reload-390.jpg) | [09](host/screens/09-settlement-receipt-after-reload-1440.jpg) |
| Backed vesting grant | [12](host/screens/12-vesting-backed-at-settlement-390.jpg) | [12](host/screens/12-vesting-backed-at-settlement-1440.jpg) |
| Expired allocation and seller refund | [15](host/screens/15-expired-seller-refund-390.jpg) | [15](host/screens/15-expired-seller-refund-1440.jpg) |
| Onchain deal book in a fresh profile | [17](host/screens/17-broker-onchain-history-fresh-profile-390.jpg) | [17](host/screens/17-broker-onchain-history-fresh-profile-1440.jpg) |

### Final host validation

| Command or suite | Result |
| --- | --- |
| `npm run build` | Passed with Node 24.15.0. |
| [Round 1 frozen](host/frozen-round-1.json) | 16/16 passed. |
| [Round 2 frozen](host/frozen-round-2.json) | 7/7 passed. |
| [Round 3 frozen](host/frozen-round-3.json) | 5/5 passed. |
| [Regression](host/regression.log) | 69/69 passed. |
| [Contract proof](host/contract-proof.json) | Eight in-process scenarios passed, with 20 successful and 20 reverted transaction receipts. |
| [Browser proof](host/browser-proof.json) | 17 screenshots and seven verified receipts at each width. |

The original JSON beside this README records the earlier sandbox run. The host browser run used Playwright Chromium and independent injected fixture wallets on chain 31337, with an example explorer URL. The Round 3 browser scenes cover reload after confirmation. Pending reload, replacement and onchain failure recovery are exercised through the shared Round 2 transaction flow. The browser run covers targeted keyboard and status checks. Screen-reader behavior, real wallet extensions and live explorers remain untested.

The official base already differs from the historical Round 1 commit `545cdb7b37` in `OtcDeals.sol`. That inherited change adds exact recipient-balance enforcement on fills. The Round 3 checkout preserves the official base contract and the frozen Round 1 checks.

## Operational boundaries

The proposal is an unsigned bearer link. Before funding, the two counterparties should verify its recipient, token, schedule and fee terms against their agreement. After funding, the chain anchors the terms to the same digest. Browser-local draft history follows the connected address and storage on that origin. Funded deal history is recovered from indexed onchain events in a fresh browser.

The contract accepts canonical EOA signatures using `eth_signTypedData_v4`. Smart-contract signature verification and external vesting positions are outside this implementation. Refunds and claims use the Round 2 withdrawal rules. Recipient-taxed tokens can reduce the amount their owner receives on withdrawal. Funding and settlement reject transfers that fail to move the exact required amounts. The production broker rate and eligibility, an independent audit and testnet beta remain open.
