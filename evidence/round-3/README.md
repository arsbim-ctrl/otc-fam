# Broker deals replay

The [play log](play.txt) records the visible page, asserted balance changes in raw units and completed scenes for two Chromium viewport sizes. The replay runs against a local chain with distinct broker, seller, buyer and unrelated wallets.

Run from the repository root after installing the locked dependencies and Playwright Chromium.

```sh
npm run evidence
```

This runs `npm run play` once in a temporary replay folder. It checks that scenes 01–34 were captured at 390 and 1440 pixels and that the log names those same images. It then writes the complete stdout to `play.txt` and all 68 Round 3 screenshots to this directory. The Round 2 evidence is kept as published.

Each broker scene checks horizontal fit and browser console errors. The form scene verifies keyboard focus and the wallet-free scenes use fresh browser profiles.

## Scenes

| Scene | 390 px | 1440 px |
| --- | --- | --- |
| The broker enters the two wallet addresses, assets and quote. The fee preview shows the exact broker share. | [390](01-broker-enters-terms-390.jpg) | [1440](01-broker-enters-terms-1440.jpg) |
| The broker copies one shareable link. Creating and copying it leaves all balances unchanged. | [390](02-link-copied-390.jpg) | [1440](02-link-copied-1440.jpg) |
| The named seller opens the immediate deal, reviews the exact terms and sees the funding action. | [390](03-seller-inspects-390.jpg) | [1440](03-seller-inspects-1440.jpg) |
| The full allocation moves into escrow. The funding receipt confirms that no fees moved. | [390](04-seller-funded-390.jpg) | [1440](04-seller-funded-1440.jpg) |
| An unfunded link previews all terms without a wallet. The buyer sees why settlement is unavailable. | [390](05-awaiting-funding-390.jpg) | [1440](05-awaiting-funding-1440.jpg) |
| A fresh browser without a wallet verifies immediate delivery and the onchain funding receipt. | [390](06-fresh-buyer-immediate-390.jpg) | [1440](06-fresh-buyer-immediate-1440.jpg) |
| The buyer declines the typed signature. No approval or settlement transaction is sent. | [390](07-wallet-request-declined-390.jpg) | [1440](07-wallet-request-declined-1440.jpg) |
| The designated buyer settles. Onchain logs supply the hash, confirmation and exact payment split. | [390](08-immediate-receipt-390.jpg) | [1440](08-immediate-receipt-1440.jpg) |
| Reloading rebuilds the settlement receipt with the same transaction hash. | [390](09-reload-confirmed-390.jpg) | [1440](09-reload-confirmed-1440.jpg) |
| A fresh browser without a wallet sees the 30-day cliff, 90-day schedule and escrow funding. | [390](10-fresh-buyer-vesting-390.jpg) | [1440](10-fresh-buyer-vesting-1440.jpg) |
| An unrelated wallet sees the required buyer address and has no settlement action. | [390](11-wrong-wallet-390.jpg) | [1440](11-wrong-wallet-1440.jpg) |
| A buyer on chain 1 is prompted to switch to the deal’s chain. | [390](12-wrong-network-390.jpg) | [1440](12-wrong-network-1440.jpg) |
| Settlement fully funds the grant vault. The receipt and grant show the beneficiary and custody address. | [390](13-vesting-receipt-390.jpg) | [1440](13-vesting-receipt-1440.jpg) |
| At the cliff, 300 FAM is available to the beneficiary. | [390](14-vesting-cliff-390.jpg) | [1440](14-vesting-cliff-1440.jpg) |
| The claim transfers exactly 300 FAM from the vault and charges no fees. | [390](15-vesting-claimed-390.jpg) | [1440](15-vesting-claimed-1440.jpg) |
| The seller recovers the entire allocation. The refund page and receipt show zero payment and no fees. | [390](16-refund-receipt-390.jpg) | [1440](16-refund-receipt-1440.jpg) |
| The connected buyer sees that settlement is closed and the allocation is still in escrow for the seller to refund. | [390](17-expired-390.jpg) | [1440](17-expired-1440.jpg) |
| The broker’s six deal statuses show the agreed share, delivery mode, and short deal IDs. | [390](18-broker-history-390.jpg) | [1440](18-broker-history-1440.jpg) |
| The buyer role filter returns no matches for this broker wallet. | [390](19-history-role-filter-390.jpg) | [1440](19-history-role-filter-1440.jpg) |
| A historical link copies with its original digest and terms. | [390](20-history-link-copied-390.jpg) | [1440](20-history-link-copied-1440.jpg) |
| Duplication retains the values and gives the new deal its own seller nonce. | [390](21-duplicate-terms-390.jpg) | [1440](21-duplicate-terms-1440.jpg) |
| An unrelated wallet sees no records from the broker’s activity. | [390](22-unrelated-wallet-history-390.jpg) | [1440](22-unrelated-wallet-history-1440.jpg) |
| An RPC error hides receipts and the payment split. The link terms, deal ID and submitted transaction survive a reload. | [390](23-rpc-interruption-390.jpg) | [1440](23-rpc-interruption-1440.jpg) |
| Refresh follows the same transaction and restores the confirmed settlement receipt and exact split. | [390](24-rpc-recovered-390.jpg) | [1440](24-rpc-recovered-1440.jpg) |
| The broker sets new vesting and previews the fee split beside the schedule. | [390](25-broker-sets-vesting-390.jpg) | [1440](25-broker-sets-vesting-1440.jpg) |
| The vesting schedule is included in the copied link. | [390](26-vesting-link-copied-390.jpg) | [1440](26-vesting-link-copied-1440.jpg) |
| The seller can review the vesting terms before funding. | [390](27-seller-inspects-vesting-390.jpg) | [1440](27-seller-inspects-vesting-1440.jpg) |
| The vesting proposal is funded and awaiting the named buyer. | [390](28-seller-funded-vesting-390.jpg) | [1440](28-seller-funded-vesting-1440.jpg) |

## Seller and buyer history

These profiles connect directly from Deal history with empty browser storage. The buyer’s funded row comes from the chain before settlement and without opening a terms link. Each wallet then stores its own cursor and deals for later visits.

| Scene | 390 px | 1440 px |
| --- | --- | --- |
| The seller sees net proceeds across five onchain deals and the allocation still in escrow on the expired deal. | [390](29-seller-history-390.jpg) | [1440](29-seller-history-1440.jpg) |
| The buyer sees the payment, the funded and unsettled deal, and the settled grant’s vault balance and its vested, claimed, and claimable amounts. | [390](30-buyer-history-390.jpg) | [1440](30-buyer-history-1440.jpg) |

## Settled fee fixtures

Each capture shows a mined settlement. The replay asserts all token balance changes in raw units and checks the confirmed split against the displayed amounts.

| Quote and broker share | Buyer pays | Seller receives | Broker | Treasury | 390 px | 1440 px |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| 123.456789 USDC at 20% | 124.074072 | 122.839506 | 0.246913 | 0.987653 | [390](08-immediate-receipt-390.jpg) | [1440](08-immediate-receipt-1440.jpg) |
| 123.456789 USDC at 0% | 124.074072 | 122.839506 | 0 | 1.234566 | [390](31-small-quote-zero-share-390.jpg) | [1440](31-small-quote-zero-share-1440.jpg) |
| 100,000 USDC at 0% | 100,500 | 99,500 | 0 | 1,000 | [390](32-large-quote-zero-share-390.jpg) | [1440](32-large-quote-zero-share-1440.jpg) |
| 100,000 USDC at 20% | 100,500 | 99,500 | 200 | 800 | [390](33-large-quote-twenty-percent-390.jpg) | [1440](33-large-quote-twenty-percent-1440.jpg) |

## Refund during signing

The seller refunds during the buyer’s typed-signature request. The buyer sees zero payment, a refund receipt, and guidance to ask for a new link. The replay asserts that the buyer sends no transaction and the full escrowed allocation returns to the seller. [390 px](34-refund-during-signing-390.jpg) · [1440 px](34-refund-during-signing-1440.jpg)

## Balance and authorization tests

| Acceptance evidence | Reproduction |
| --- | --- |
| R3-01 immediate and vesting workflows with four wallets | `npm run play`, scenes 01–15 and 25–28 |
| R3-02 wrong actor, altered terms, wrong chain or contract, expiry and nonce reuse preserve holdings | `authorization failures preserve every holding` in [broker-contract.test.mjs](../../test/broker-contract.test.mjs) |
| R3-03 all four quote and share combinations, and zero fees on rejection or refund | `exact raw balances` and `a delivery that fails after the payment` in [broker-contract.test.mjs](../../test/broker-contract.test.mjs), scenes 07, 08, 16 and 31–34 |
| R3-04 receipts reconcile to allocation delivery, vault holdings and fee splits | Scenes 08, 13–16 and `fully backed vesting and exact fee-free claims` in [broker-contract.test.mjs](../../test/broker-contract.test.mjs) |
| R3-05 fresh-browser preview, role-filtered history and recovery | Scenes 05–06, 09–12, 17–24 and 29–30, and [broker-page.test.mjs](../../test/broker-page.test.mjs) |
