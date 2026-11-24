# Round 3 broker deal evidence

The scenarios use a local chain with independent broker, seller, buyer and stranger fixture wallets. The browser opens each counterparty’s copy of the link in a fresh profile.

```sh
npm ci
npx playwright install chromium
npm run check
npm test
BROKER_EVIDENCE=evidence/round-3 node --test test/v3-page.test.mjs
```

| Requirement | Reproduce |
| --- | --- |
| R3-01 seller funding and buyer settlement | Frozen Round 3 check 1 and the four browser scenarios for immediate delivery and vesting at 390px and 1440px. Creation and wallet-free buyer preview make no signing or transaction requests. |
| R3-02 exact authority and replay | Frozen check 2 and `test/v3-contract.test.mjs`. Digest checks cover every signed field, both domain separators, the named actors, expiry, nonce reuse after refund and ERC-1271. |
| R3-03 exact fees and rollback | Frozen checks 3 and 4 assert raw token balance deltas for the four fixtures below and no payment or fees on rejected settlement and refund. |
| R3-04 delivery and grants | Frozen checks 4 and 5, the fixed-start test and the browser tests compare escrow, direct delivery, vault backing, beneficiary claims and the settlement receipt. |
| R3-05 role history and recovery | The browser suite covers copying and duplicating, expiry and refund, a stranger’s empty history, wrong account and chain, rejected signature with keyboard focus restored, reload while pending, and reload after settlement. |

## Exact USDC fixture amounts

USDC in the fixture has six decimals. Every entry in the table is in raw units. Each row conserves buyer debit as seller credit plus broker and treasury credits.

| Quote | Broker share | Each side’s fee | Buyer debit | Seller credit | Broker credit | Treasury credit |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100,000,000,000 | 0% | 500,000,000 | 100,500,000,000 | 99,500,000,000 | 0 | 1,000,000,000 |
| 100,000,000,000 | 20% | 500,000,000 | 100,500,000,000 | 99,500,000,000 | 200,000,000 | 800,000,000 |
| 123,456,789 | 0% | 617,283 | 124,074,072 | 122,839,506 | 0 | 1,234,566 |
| 123,456,789 | 20% | 617,283 | 124,074,072 | 122,839,506 | 246,913 | 987,653 |

## Browser demonstration

| Scene | 390px | 1440px |
| --- | --- | --- |
| Immediate terms and fee preview | [Phone](immediate-01-terms-390.jpg) | [Desktop](immediate-01-terms-1440.jpg) |
| Broker history with an unfunded draft | [Phone](immediate-02-history-draft-390.jpg) | [Desktop](immediate-02-history-draft-1440.jpg) |
| Seller declines typed signature | [Phone](immediate-03-rejected-signature-390.jpg) | [Desktop](immediate-03-rejected-signature-1440.jpg) |
| Wallet-free funded vesting preview | [Phone](vesting-04-wallet-free-buyer-390.jpg) | [Desktop](vesting-04-wallet-free-buyer-1440.jpg) |
| Unrelated wallet and wrong chain | [Wallet](immediate-05-wrong-wallet-390.jpg), [chain](immediate-06-wrong-chain-390.jpg) | [Wallet](immediate-05-wrong-wallet-1440.jpg), [chain](immediate-06-wrong-chain-1440.jpg) |
| Immediate settlement receipt after reload | [Phone](immediate-08-settled-receipt-390.jpg) | [Desktop](immediate-08-settled-receipt-1440.jpg) |
| Vesting receipt and grant | [Phone](vesting-08-settled-receipt-390.jpg) | [Desktop](vesting-08-settled-receipt-1440.jpg) |
| Broker history from onchain events | [Phone](vesting-10-history-settled-390.jpg) | [Desktop](vesting-10-history-settled-1440.jpg) |

The [pending transaction after reload](vesting-07-reloaded-pending-390.jpg) is shown before the test mines its block. The local receipt uses a fixture explorer URL to exercise the link format.

[Round 3 contract and browser test output](results.txt)
