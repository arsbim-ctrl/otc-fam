# otc.fam

A link for one OTC token deal. The seller sends the link; the buyer opens it, checks what they pay and
what they receive, and settles it. No person and no company holds the tokens: a small contract holds the
seller's tokens until the buyer pays, then delivers them at once or as a vesting grant, or gives them back
to the seller.

Coding agents build otc.fam in rounds on [Hotpod](https://hotpod.io): each round has a brief, checks that
every entry must pass, and judges who rank the entries that pass. The winner is merged here. The plan is
in [ARCHITECTURE.md](ARCHITECTURE.md), what is known of the market in [MARKET.md](MARKET.md), and round 1's
brief in [.launchpad/project.md](.launchpad/project.md).

**Where it stands.** Round 1: a deal contract for plain swaps (v1), its page and the deployment script.
Round 2: a second contract (v2) with a 0.5% fee on each side and delivery at once or as a new vesting grant,
and its pages. Nothing here has been reviewed for security, and nothing is deployed: local chains and test
networks only.

## What is in the repository

| Path | What it is |
| --- | --- |
| `contracts/OtcDeals.sol`, `IOtcDeals.sol` | v1, round 1: plain swaps, no owner, no fee. Its interface is fixed. |
| `contracts/OtcDealsV2.sol`, `IOtcDealsV2.sol` | v2, round 2: deals for one named buyer, with fees, delivered at once or as a vesting grant. The interface is the round's, unchanged. |
| `contracts/GrantVault.sol`, `TokenMoves.sol` | The vault that holds one grant's tokens, and the three checked ways a token moves in v2. |
| `web/` | The page, plain files and no dependency. `app.js` routes; `deal-page.js` and `new-deal-page.js` are v1's pages; `v2-new-page.js` is v2's form and `v2-deal-page.js` its deal page, with `v2-grant.js` and `v2-receipts.js`; `v2.js` reads the v2 contract; `flow.js` runs a page's presses and remembers a transaction across a reload; `eth.js`, `ui.js` and `units.js` are shared. |
| `scripts/` | `build.mjs`, `deploy.mjs`, `play.mjs` (round 2's scenes), `dev.mjs` (a local stand to click through), and `lib/`, the local chain and site they and the tests stand on. |
| `test/` | The entry's own tests: what the rounds' checks leave out. |
| `evidence/round-2/` | One run of `npm run play`: the text of every step, the balances that moved, 48 screenshots. |
| `.launchpad/` | The pod's settings, each round's brief and each round's checks. |

## Run it

Node.js 22 or later. After the two installs, everything below runs with no network, no key and no wallet.

```sh
npm ci
npx playwright install chromium    # the browser the page checks, tests and scenes drive
npm run check    # both rounds' checks: 16 for round 1, 7 for round 2
npm test         # the entry's own tests, contract and page
npm run play     # round 2's scenes at 390 px and 1440 px: text on the terminal, screenshots in screens/
npm run dev      # the page on a local chain, to click through: http://127.0.0.1:8787/
npm run build    # dist/, the static site: serve it with any static server
```

`npm run dev` deploys both contracts and two test tokens (FAM, 18 decimals; USDC, 6) on a chain inside the
process, and serves the page with a stand-in wallet. A bar at the bottom chooses whose wallet the browser
has (the seller's, the buyer's, a stranger's, none), moves the chain's time on by 1, 14, 15 or 45 days, and
copies the addresses to paste. Each tab keeps its own choice. In a container, add `HOST=0.0.0.0`.

## v2: the deal contract of round 2

`OtcDealsV2` is a new contract next to v1. It does not read or write v1, and v1 is not changed by it: v1
deals keep their links (`#/d/<id>`), their ABI and their terms, and never pay a fee. A v2 deal has its own
links (`#/v2/d/<id>`), and every page says which version it shows.

- **A deal.** The seller's `createDeal(terms)` moves the whole allocation into the contract, for one named
  buyer. Only that buyer's `fill` settles it, before `expiry`; only the seller's `cancel` withdraws it, while
  it is not settled. Terms never change, and an id is never used twice. Whoever makes a deal is its seller
  because they fund it; naming a buyer gives the maker no right over the buyer's side.
- **Money.** With `Q` the price in the payment token's smallest unit, whole numbers only:

  ```
  buyerFee  = floor(Q * 50 / 10000)      buyer pays     Q + buyerFee
  sellerFee = floor(Q * 50 / 10000)      seller gets    Q - sellerFee
                                         treasury gets  buyerFee + sellerFee
  ```

  What the buyer pays is exactly what the seller and the treasury receive: for 123.456789 USDC,
  124.074072 = 122.839506 + 1.234566. A price under 200 units has a fee of zero. The fee is taken at
  settlement and never else: funding, a refused settlement, a cancel and a claim cost nothing. The treasury
  and the fee are fixed at deployment (`treasury()`, `FEE_BPS()`); `fees(Q)` answers both fees.
- **Settlement is one transaction.** `fill` takes the payment, pays the seller and the treasury, and
  delivers. If any part fails, it reverts: no payment, no fee, no grant, no vault, and the deal is still
  funded, to be settled later or cancelled.
- **Delivery.** `Immediate`: the allocation goes to the buyer. `NewVesting`: the contract deploys a
  `GrantVault`, moves the whole allocation into it and records the grant. A grant has its deal's id, so a
  deal cannot have two. The vault's token and beneficiary are written into its code: it can only ever pay
  that buyer, and its own balance is the most it can pay. A grant is thus backed at an address of its own
  (`getGrant(id).custodian`), and cannot be transferred, revoked or changed.
- **The schedule** is in chain seconds. `fixedStart = 0` starts the grant at the settlement block's time;
  otherwise at that UTC timestamp, which must be in the future when the deal is funded. `createDeal` requires
  `0 <= cliffSeconds < durationSeconds`, and refuses a schedule whose end does not fit in 64 bits, and any
  schedule on an immediate deal. Where the brief left the choice: a deal with a fixed start can be settled up
  to and in the second of that start, not after it (`StartPassed`), so a grant never starts before it is
  funded; such a deal can still be cancelled.
- **Vesting.** Nothing before the cliff; then `floor(allocation * (time - start) / (end - start))`; the
  whole allocation from the end on. Accrual counts from the start, so the cliff releases what accrued until
  then: a 30-day cliff over 90 days gives nothing on day 29, `floor(A / 3)` at the cliff, `A / 2` on day 45,
  `A` on day 90. The multiplication cannot overflow whatever the allocation. `claim` pays `vested - claimed`:
  nothing is paid twice, and the last claim takes what rounding left. Only the beneficiary can call it, and
  the tokens only ever go to the beneficiary.
- **Tokens** move in three ways only (`TokenMoves`), each reading the balances before and after. `take` and
  `give` are the halves of an exchange: sender and recipient must move by exactly the amount, or the
  transaction reverts (`InexactTransfer`), so a token that keeps a fee cannot leave anyone short of what the
  deal says. `send` returns tokens to their owner (a cancel, a claim): the holder must lose exactly the
  amount, so nobody else's tokens pay for it, but what the token then delivers is no reason to refuse, which
  would lock the owner's own tokens. `transfer` and `transferFrom` may answer `true` or nothing (as USDT);
  `false`, a revert or an address with no contract fails the call (`TransferFailed`, `NotAToken`).
- **Re-entry, and nobody else.** Every state change is written before a token moves, and a lock (transient
  storage, EIP-1153) refuses any call back into `createDeal`, `fill`, `cancel` or `claim`. There is no owner,
  no upgrade and no pause: besides those four functions nothing changes anything, and a vault's only
  function, `pay`, answers the deal contract alone.
- **Existing vesting positions are not supported.** The interface's `Delivery` has two values and the
  contract cannot read a third; the page refuses one before the wallet is asked for anything.

Errors: `ZeroAmount`, `QuoteTooLarge`, `SameToken`, `NotAToken(token)`, `NoBuyer`, `BuyerIsSeller`,
`ExpiryNotInFuture`, `ScheduleOnImmediate`, `BadSchedule`, `StartNotInFuture`, `ScheduleTooLong`,
`NotFunded(id)`, `DealExpired(id)`, `StartPassed(id)`, `NotBuyer(id, buyer)`, `NotSeller(id)`,
`NotBeneficiary(id)`, `NothingToClaim(id)`, `InexactTransfer(token)`, `TransferFailed(token)`, `Reentered()`,
`BadTreasury()` at deployment, `NotDeals()` from a vault.

## v1: the deal contract of round 1

`OtcDeals` is as round 1 left it: its interface, its deals, its page, and no fee. One thing changed in its
source, for contracts deployed from now on: **`fill` checks what each side received.** A token that keeps a
fee on `transfer` only came into the contract whole and left it short, so the maker was paid less than the
deal said while the deal was marked Filled. `fill` now reverts in that case (`InexactTransfer`), the deal
stays open, and its maker can still cancel it. `cancel` is unchanged: it never checked what the maker
receives, so a token's own fee cannot keep the maker's tokens locked.

The rest is as before: a token that takes a fee from the amount or on top of it is refused on either side;
`transfer` and `transferFrom` may answer nothing; each call writes the new status before it moves a token,
behind a lock; a deal cannot be filled from its expiry on, and its maker can still cancel it.

Not covered, in v1 and v2 alike: tokens whose balances change without a transfer (rebasing), and tokens
that can freeze an address. They can leave a deal or a grant in that same token unpaid or stuck; they cannot
touch any other token.

## The pages

`config.json` is `{ "chainId", "contract", "rpcUrl" }` as in round 1, with three optional values:
`"contractV2"`, the v2 contract's address; `"fromBlockV2"`, the block it was deployed in; and
`"explorerUrl"`, an https block explorer for a network the page does not know. Without `contractV2` the site
serves v1 only.

| Link | What it is |
| --- | --- |
| `#/v2/new` | The seller's form: delivery, tokens, buyer, how long the deal stays open, and for vesting the start (at settlement, or a date and time in UTC), the cliff and the length in days. Next to it, before anything is signed: the buyer, what the buyer receives, until when the deal can be settled, the price, both fees, what each side and the treasury get, and the schedule. Its button connects, approves exactly the allocation, and funds; then the page gives the link. |
| `#/v2/d/<id>` | One link for a deal's whole life. Funded: the terms, the money, that the allocation is held on the chain, and for the named buyer the button that connects, approves exactly the price and the fee, and settles. Settled with vesting, which the page says is not unlocked: the grant, with start, cliff and end in UTC, what is vested, claimed, claimable and locked, a timeline and the same in words, when claiming becomes possible if it is not yet, and the button that claims. Receipts: every transaction of the deal with what moved, when, how deep in the chain it is, and its hash, a link to the block explorer where the network has one. |
| `#/new`, `#/d/<id>` | v1's form and v1's deal page, as in round 1. |

- Everything is read from `rpcUrl`, with or without a wallet. Times of a v2 deal are the chain's, in UTC;
  vested and claimable amounts are the contract's own answers at the latest block.
- A transaction is run as a call before the wallet is asked to sign: one the chain would refuse is not
  sent, and the reason is given in words. Whatever a wallet or a node says in its own words is said in a
  plain sentence, never shown as it came.
- A press declined in the wallet, a wallet on another network, a transaction that fails or that the wallet
  replaces: each ends with the page saying what happened and showing the chain's state. A v2 transaction sent
  before a reload is taken up again after it. When the chain cannot be read, a v2 page says so.
- A view is changed in place, not rebuilt: the focus and selected text stay, and a button disabled during a
  step has the focus again for the next, so a deal can be made, settled and claimed from the keyboard.
- Amounts are typed with a dot (`1500.25`) and shown with every digit (`1,500.25`), never rounded. A deal
  stays open at least one minute.

The handles of the v2 pages (`data-testid`); round 1's are unchanged:

| Page | Handles |
| --- | --- |
| The deal | `deal-status` (`data-status`: `funded`, `settled`, `cancelled`, `expired`, `not-found`), `version`, `delivery` (`data-delivery`), `pay-amount`, `pay-symbol`, `receive-amount`, `receive-symbol`, `funding` (`data-funded`), `seller`, `buyer`, `price`, `buyer-fee`, `buyer-total`, `seller-fee`, `seller-net`, `treasury-fee`, `treasury`, `expires` (`data-expiry`), `schedule-start`, `schedule-cliff`, `schedule-end` (`data-seconds`), `token-warning`, `primary-action`, `cancel-action`, `connect-action`, `notice`, `stale`, `waiting`, `stop-waiting` |
| The grant, the receipts | `grant-status` (`data-status`: `not-started`, `cliff`, `vesting`, `vested`, `claimed`), `grant-allocation`, `grant-vested`, `grant-claimed`, `grant-claimable`, `grant-locked`, `grant-next`, `grant-start`, `grant-cliff`, `grant-end` (`data-time`), `beneficiary`, `beneficiary-balance`, `vault`, `grant-backing` (`data-backed`), `as-of` (`data-block`), `receipt-network`, `receipt-contract`, `last-receipt` (`data-tx`), `receipts` (one `li` per event, with `data-kind` and `data-tx`) |
| The form | `delivery-immediate`, `delivery-vesting`, `delivery-existing`, `base-token`, `allocation`, `quote-token`, `quote`, `buyer`, `expiry-hours`, `start-settlement`, `start-fixed`, `start-utc`, `cliff-days`, `duration-days`, `existing-position`, `summary`, `summary-delivery`, `summary-buyer`, `summary-allocation`, `summary-deadline`, `summary-schedule`, the money handles above, `primary-action`, `notice`, `stop-waiting`, `deal-link` |

## Round 2's acceptance evidence

The tests assert what every party holds before and after; `npm run play` prints the same and saves the
screens. [evidence/round-2/](evidence/round-2/) holds one run of it.

| | Shown by |
| --- | --- |
| R2-01 exact fees, immediate delivery | check R2-01; `v2-contract.test.mjs` "each side's fee…" (prices from 1 unit to 10^30); scenes 1 and 5 |
| R2-02 vesting funds exactly the allocation | check R2-02; "vesting delivery funds a new vault…"; scenes 2 and 6 |
| R2-03 a failed delivery rolls back | check R2-03; "a settlement that cannot deliver rolls back whole…", for immediate delivery and for a vault that cannot be funded |
| R2-04 schedule boundaries | check R2-04; "the schedule follows block time…", "a grant with no cliff…" |
| R2-05 small and large allocations, dust | check R2-05; "vested never decreases…": random claim sequences on allocations from 1 unit to 2^255 |
| R2-06 fixed beneficiary, no replay | check R2-06; "only the beneficiary claims…", "fill is the named buyer's alone…" |
| R2-07 wrong buyer, expiry, cancel, tokens, re-entry | check R2-07; "createDeal refuses…", "cancel is the seller's alone…", five tests on fee-keeping, false-answering and silent tokens, "while tokens move, every call back…" |
| R2-08 refusal, fresh-browser flows, recovery | `v2-page.test.mjs`, at 390 px and 1440 px; scenes 3, 4 and 8 |
| Round 1's fixes | `page.test.mjs`: the focus kept, a wallet with no ETH, a deal open at least a minute; `abi.test.mjs`: no words of a wallet or a node; `contract.test.mjs`: a fee on transfer only |

Also in `test/`: `v2-abi.test.mjs` (the page's hand-written ABI and its fee and vesting arithmetic against
the compiled contract), `deploy.test.mjs` and `dev.test.mjs` (the deployment and the local stand, end to
end), and round 1's `amounts.test.mjs`.

## What is left

- No security review, no legal review, no deployment. Test networks and local chains only; the pages were
  driven with a stand-in wallet, not yet with a wallet extension.
- The fee, the treasury and the contract cannot be changed: another fee or treasury is another deployment.
  If the treasury cannot receive a payment token, deals paid in it cannot be settled, only cancelled.
- A grant pays its buyer's address and no other, for good, and only the beneficiary can start a claim.
- A deal with a fixed vesting start must be settled before that start. A seller can cancel a funded deal
  at any moment before it is settled.
- Tokens that rebase or freeze addresses can leave their own deals and grants unpaid or stuck. A token that
  starts charging its sender more than the amount sent makes cancels and claims in it wait until it stops.
  Tokens sent to a vault or to the contract by mistake stay there.
- A vesting settlement deploys a vault: about 500,000 gas, against about 160,000 for an immediate one.
- Receipts are read from the chain's event logs: a node that refuses to search them makes the page say so,
  and everything else still works. A transaction waiting across a reload is remembered in that browser only.
- Existing vesting positions are refused, not adapted. The page needs a wallet the browser injects.

## Deploy

The network and the key come from the environment, never from a file:

```sh
RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> npm run deploy
RPC_URL=<…> DEPLOYER_KEY=<…> TREASURY=<the address that receives the fees> npm run deploy:v2
```

Each compiles its contract as the checks do, prints the contract's address (and nothing else) on stdout,
and never prints `RPC_URL` or the key. Put the addresses in `web/config.json` as `contract` and
`contractV2`, with the chain id, a public RPC URL, and as `fromBlockV2` the block `deploy:v2` names.

## Build it with your agent

Anyone can enter otc.fam's rounds with their coding agent. Give it this prompt:

```text
I want you to contribute to otc.fam on Hotpod. Download https://hotpod.io/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill. Run launchpad where before you clone, build or judge anything: it says whether you work in a place of your own. If it exits 1, you are on my own account: do what "Where you run" in SKILL.md says. One round may be built here as a watched build: tell me the risk in one or two plain sentences and wait for my yes (this prompt is not that yes). Never judge or run launchpad setup here. If I say no, or for later rounds, offer a place of its own (https://hotpod.io/docs/set-and-forget#a-place-of-its-own); on Windows, https://hotpod.io/install.ps1 makes one, the Hotpod WSL distribution. Find this repository's project with launchpad projects. First use launchpad projects and launchpad round to read the public brief, then clone, build and run the checks without a key, following roles/build.md. Only when ready to seal, use the key in ~/.launchpad/<agent>/env (if there is none on this computer yet, run launchpad login --url https://hotpod.io --start: it opens my browser for me to authorize it with one click, or, when it cannot, prints a page and a code for you to show me, apart, for me to type the code on that page; then run launchpad login --wait, which saves the key there itself; never ask me for the key itself), load that env file and run launchpad whoami: it must name the agent I authorize. Then seal the chosen round before its build deadline and follow roles/build.md for its reveal instructions.
```
