# Round 3 evidence

The contract checks use an in-process chain and four independent roles. The browser tests use Chromium,
fresh browser contexts, deterministic test wallets and the same onchain interactions as the local stand.
The screenshots come from a single successful run at 390 px and 1440 px. The repository suite passed
74 tests with Node.js 24 in the pinned Playwright image. The standalone Round 3 check passed all five cases.

```sh
npm ci
npx playwright install chromium
npm run check
npm test
BROKER_EVIDENCE_DIR=evidence/round-3 node --test test/v3-page.test.mjs
```

| Acceptance | Verification |
| --- | --- |
| R3-01 | Round 3 checks fund and settle immediate swaps and funded vesting grants. Both browser viewport tests prepare as broker, fund as seller, settle as buyer and check the stranger's restrictions. |
| R3-02 | The contract checks reject wrong actors, altered terms, foreign signing domains, expiry and reused seller nonces. The browser ABI test cross-checks the link, typed terms and call encoding with the compiled interface. |
| R3-03 | The four quote and broker-share cases assert exact raw balance deltas. Failed delivery and refunds leave fees at zero. The browser test rejects a settlement after approval, checks zero broker and treasury balances, then retries. |
| R3-04 | The contract checks reconcile settlement logs, vault funding and claims against chain balances. The browser verifies the transaction recipient, receipt hash, fees and a buyer-only claim after advancing the chain 45 days. |
| R3-05 | The browser tests verify a fresh wallet-free preview, rejection with keyboard focus preserved, wrong-wallet and wrong-chain recovery, and the same onchain receipt after reload. They also check duplicate terms, refunds, expiry, and role-scoped history at both widths. |

| Scene | 390 px | 1440 px |
| --- | --- | --- |
| Review and copy a proposal with raw-unit fee rounding | [Phone](01-proposal-and-link-390.jpg) | [Desktop](01-proposal-and-link-1440.jpg) |
| Wallet-free preview before funding | [Phone](02-wallet-free-unfunded-390.jpg) | [Desktop](02-wallet-free-unfunded-1440.jpg) |
| Seller declines the typed signature | [Phone](03-signature-declined-390.jpg) | [Desktop](03-signature-declined-1440.jpg) |
| Confirmed seller funding | [Phone](04-seller-funded-390.jpg) | [Desktop](04-seller-funded-1440.jpg) |
| Fresh wallet-free buyer preview of a funded vesting deal | [Phone](05-fresh-buyer-preview-390.jpg) | [Desktop](05-fresh-buyer-preview-1440.jpg) |
| Buyer sees a network mismatch | [Phone](06-wrong-chain-390.jpg) | [Desktop](06-wrong-chain-1440.jpg) |
| Immediate settlement receipt after reload | [Phone](07-reloaded-settlement-receipt-390.jpg) | [Desktop](07-reloaded-settlement-receipt-1440.jpg) |
| Settlement into a new funded grant | [Phone](08-settled-vesting-390.jpg) | [Desktop](08-settled-vesting-1440.jpg) |
| Broker history after settlements, expiry and refund | [Phone](09-broker-history-390.jpg) | [Desktop](09-broker-history-1440.jpg) |

The browser tests use `https://example.test` as the configured explorer to verify transaction URLs on the local chain.
