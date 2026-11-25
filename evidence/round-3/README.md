# Round 3's evidence, as run

One run of each command below in the round's pinned runner image, with no network, on a local chain inside
the process, with the test tokens FAM (18 decimals) and USDC (6 decimals). Nothing here touched a real
network, and the wallets are stand-ins that sign with the public test keys of `scripts/lib/world3.mjs`.

| File | Command | What it holds |
| --- | --- | --- |
| [checks.txt](checks.txt) | `npm run check` | The three rounds' checks: 16 of 16, 7 of 7, 5 of 5 |
| [tests.txt](tests.txt) | `npm test` | The entry's 144 tests, all passing; round 3's start with the acceptance point they show |
| [play.txt](play.txt) | `node scripts/play3.mjs evidence/round-3` | The brief's scenes at 390 px and at 1440 px. Each scene's heading names the acceptance points it shows. Under it: the text a person reads at each step, what was typed into the form, each press, and the lines listed below. The run ends with every balance check in one place |
| `NN-<scene>-390.jpg`, `NN-<scene>-1440.jpg` | the same run | Each step at a phone's width and at a desktop's: 34 screenshots |

The lines of `play.txt` that are checked before they are printed (`grep -n "BALANCES\|COPIED" play.txt`, and so on):

| Line | What was compared |
| --- | --- |
| `BALANCES` (13 at each width) | What every party holds after the step against what it held before: exactly the deal's numbers moved, and nothing else |
| `COPIED` | The clipboard after "Copy link" against the link on the page, for a new link and for one from the history |
| `READABLE` | The token warning is shown whole within the window; the state is in words; the line that says whose turn it is has `role="status"` |
| `KEYBOARD`, `Enter 1` … `Enter 3` | The buyer settles with Enter alone: before each press the button has the focus, after the last the focus is on the status line |
| `RELOAD` | After a reload the page shows the same settlement transaction and amounts; its whole text follows |
| `WALLET CHANGED` | The wallet turns from a stranger's account to the buyer's: the page reads the chain again and says what that account can do |

## The scenes

A broker, a seller, a buyer and a stranger each have a browser of their own. The deal is a million FAM for
100,000 USDC (immediate) or for 123.456789 USDC (vesting), with 20% of the fees for the broker.

| Screens | Scene | Acceptance |
| --- | --- | --- |
| 01, 02 | The broker, with no wallet, enters the terms, sees both fees and the exact share (200 of 1,000 USDC), gets one link and copies it. Nothing moved | R3-01, R3-05 |
| 03, 04 | The seller inspects the deal: whose turn it is, the terms as a wallet signs them. A signature declined in the wallet moves nothing; then the seller signs and funds | R3-01, R3-05 |
| 05, 06 | The buyer in a fresh browser with no wallet sees the funding and the delivery; then connects, signs and settles from the keyboard. The receipt: 100,500 paid, 99,500 received, 200 to the broker, 800 to the treasury, with its link to the explorer; a reload shows it again | R3-01, R3-03, R3-05 |
| 07 to 10 | A vesting deal. The buyer cannot settle before it is funded, and reads why; a wallet on another network switches first; settled is not unlocked: the whole allocation is in the grant's vault, which the receipt names | R3-01, R3-04, R3-05 |
| 11 to 13 | A stranger's wallet is told why it cannot act, and when it turns to the buyer's account the page follows; the broker's wallet is told what it can and cannot do; the seller takes the tokens back: no fee, nothing for the broker | R3-02, R3-03, R3-05 |
| 14, 15 | Expired: a deal that was never funded, where nobody can act; a funded one, which cannot be settled and only its seller can refund | R3-02 |
| 16, 17 | The broker's history: created and awaiting funding, funded, settled, expired and refunded deals, each with its pair, price, share, deadline and receipt; a link copied; duplicated terms become another deal with another ID | R3-05 |
| text only | The seller's history from the chain alone; the grant at its cliff and at its end, each claim paying the buyer and nobody else | R3-04, R3-05 |
| text only | The brief's four fee fixtures settled on the chain: 100,000 USDC and 123.456789 USDC, each with a broker share of 0% and of 20% | R3-03 |

## Where each thing the brief asks to see is shown

| The brief | Screens and lines | Tests (`test/v3-page.test.mjs` unless named) |
| --- | --- | --- |
| A broker enters terms, sees the exact proposed fee share, and copies a link | 01, 02, 07; `COPIED` | "R3-01, R3-05 at … width", "R3-05: the broker's form shows the broker's exact share…" |
| A seller can inspect and fund it | 03, 04; scene 2's `BALANCES` | "R3-01, R3-05 at … width" |
| A buyer in a fresh browser inspects funding and delivery before connecting, then settles and sees the receipt | 05, 06, 10 | "R3-01, R3-05 at … width", "R3-01, R3-04, R3-05 at … width" |
| Which wallet must act, and why an unfunded or expired deal cannot settle | 03, 05 (whose turn), 08 (unfunded), 14, 15 (expired) | "R3-02: the wallet is asked to sign exactly the terms…", "R3-02, R3-04: an expired deal…" |
| Created, awaiting funding, funded, settled, expired and refunded deals; copy or duplicate terms | 16, 17; `COPIED`, `DUPLICATE` | "R3-05: the history lists a person's deals by role…" |
| Rejected wallet requests | 04 | "R3-05: a signature declined in the wallet, a transaction declined after signing…", "R3-02: a signature of the terms made with another key…" |
| Wrong wallet or chain | 09 (chain), 11 (wallet); `WALLET CHANGED` | "R3-05: when the wallet turns to another account or another network…", "R3-05: a seller whose wallet is on another network…" |
| Reload after settlement | `RELOAD` in scene 3 | "R3-05: a page reloaded while its settlement is on its way…" |
| Keyboard focus, readable token warnings, accessible status at both widths | 06 (the focus on the status line); `KEYBOARD`, `READABLE` | "R3-05: the seller's funding can be done from the keyboard alone…", "R3-05: at … width the buyer settles from the keyboard alone…", "R3-05: a wallet that connects from the keyboard and is not the one whose turn it is…", "R3-05: a focused button never becomes another button in place…" |
| Exact balance deltas for both broker rates and both quotes; refunds and rejected settlements pay zero | every `BALANCES` line; scene 9 | `test/v3-contract.test.mjs` "R3-03: …", "R3-04: …" |

## To run it again

```sh
npm ci && npx playwright install chromium
npm run check && npm test && npm run play:v3     # screenshots go to screens/, or to the folder named after the command
```

Or without installing anything but Docker, in the image the round's gate runs the checks in:

```sh
IMAGE=mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
docker run --rm -v "$PWD":/work -w /work $IMAGE npm ci --ignore-scripts
docker run --rm --network none --ipc=host -v "$PWD":/work -w /work $IMAGE sh -c "npm run check && npm test && npm run play:v3"
```
