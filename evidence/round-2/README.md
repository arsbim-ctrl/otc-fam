# Round 2's scenes, as played

One run of `node scripts/play.mjs evidence/round-2`, on a local chain inside the process, with the test
tokens FAM (18 decimals) and USDC (6 decimals) and a stand-in wallet. Nothing here touched a network.

- [play.txt](play.txt): the text a person reads at each step, what was typed into the form, each press of
  the button, and every `BALANCES` line: what moved, checked against the deal's exact numbers before it
  was printed.
- `NN-<scene>-390.jpg` and `NN-<scene>-1440.jpg`: the same step at a phone's width and at a desktop's.

| Screens | Scene |
| --- | --- |
| 01, 02 | The seller's form with immediate delivery, and the link once the deal is funded |
| 03 | The seller's form with vesting delivery: a 30-day cliff over 90 days |
| 04 | An existing vesting position, refused before the wallet is asked for anything |
| 05, 06 | A fresh buyer with no wallet: the immediate deal, and the vesting deal |
| 07 | The immediate deal settled: delivery, fees and the receipt |
| 08, 09 | A press declined in the wallet, then the vesting deal settled: funded, nothing unlocked |
| 10 to 15 | The grant on day 29, at the cliff (day 30), on day 45 before and after a claim, on day 90 before and after the last claim |
| 16 to 20 | A wallet on another network; a settlement that fails on the chain; one the wallet replaces; a page reloaded while settling, and after its transaction is confirmed |
| 21 to 24 | A wallet that is not the buyer's; the seller's own deal, and cancelled; an expired deal |

To play them again: `npm ci && npx playwright install chromium && npm run play` (screenshots go to
`screens/`, or to the folder named after the command).
