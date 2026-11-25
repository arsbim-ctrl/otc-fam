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
and its pages. Round 3: a third contract (v3) for deals a broker prepares: the seller and the buyer each
sign the same terms, and the broker receives a share of the fees; with its pages, a history and receipts.
Nothing here has been reviewed for security, and nothing is deployed: local chains and test networks only.

**Three versions, side by side.** Each version is a contract of its own with links of its own, and a later
one never changes an earlier one: v1 `#/d/<id>` (`contract` in `config.json`), v2 `#/v2/d/<id>`
(`contractV2`), v3 `#/v3/d/<chain>/<contract>/<terms>` (`contractV3`). Every page says which version it
shows. `test/v3-abi.test.mjs` holds the contracts of rounds 1 and 2 to the bytes those rounds ended with.

## What is in the repository

| Path | What it is |
| --- | --- |
| `contracts/OtcDeals.sol`, `IOtcDeals.sol` | v1, round 1: plain swaps, no owner, no fee. Frozen: the round 1 files, byte for byte. |
| `contracts/OtcDealsV2.sol`, `IOtcDealsV2.sol` | v2, round 2: deals for one named buyer, with fees, delivered at once or as a vesting grant. Frozen: the round 2 files. |
| `contracts/BrokerDeals.sol`, `IBrokerDeals.sol` | v3, round 3: deals a broker prepares, funded and settled with EIP-712 signatures, with a broker's share of the fees. The interface is the round's, unchanged. |
| `contracts/GrantVault.sol`, `TokenMoves.sol` | The vault that holds one grant's tokens, and the three checked ways a token moves. Written for v2, used by v3 as they are. |
| `web/` | The page, plain files and no dependency. `app.js` routes. v1: `deal-page.js`, `new-deal-page.js`. v2: `v2-new-page.js`, `v2-deal-page.js`, `v2-grant.js`, `v2-receipts.js`, `v2.js`. v3: `v3-new-page.js` (the broker's form), `v3-deal-page.js`, `v3-receipt.js`, `v3-history-page.js`, and `v3.js` (the contract, the signed message, the link, the fees). Shared: `flow.js` runs a page's presses and remembers a transaction across a reload; `eth.js`, `ui.js`, `units.js`. |
| `scripts/` | `build.mjs`, `deploy.mjs`, `play.mjs` and `play3.mjs` (round 2's and round 3's scenes), `dev.mjs` (a local stand to click through), and `lib/`, the local chain and site they and the tests stand on (`world3.mjs` adds broker deals and people who can sign). |
| `test/` | The entry's own tests: what the rounds' checks leave out. Round 3's are named by the brief's acceptance points (`R3-01` … `R3-05`). |
| `evidence/round-3/`, `evidence/round-2/` | One run of each round's scenes: the text of every step, the balances that moved, the screenshots; for round 3 also the output of the checks and the tests. |
| `.launchpad/` | The pod's settings, each round's brief and each round's checks. |

## Run it

Node.js 22 or later. After the two installs, everything below runs with no network, no key and no wallet.

```sh
npm ci
npx playwright install chromium    # the browser the page checks, tests and scenes drive
npm run check    # the three rounds' checks: 16 for round 1, 7 for round 2, 5 for round 3
npm test         # the entry's own tests, contract and page
npm run play:v3  # round 3's scenes at 390 px and 1440 px: text on the terminal, screenshots in screens/
npm run play     # round 2's scenes, the same way
npm run dev      # the page on a local chain, to click through: http://127.0.0.1:8787/
npm run build    # dist/, the static site: serve it with any static server
```

`npm run dev` deploys the three contracts and two test tokens (FAM, 18 decimals; USDC, 6) on a chain inside
the process, and serves the page with a stand-in wallet. A bar at the bottom chooses whose wallet the
browser has (the seller's, the buyer's, the broker's, a stranger's, none), moves the chain's time on by 1,
14, 15 or 45 days, and copies the addresses to paste. Each tab keeps its own choice. In a container, add
`HOST=0.0.0.0`.

## v3: broker deals, round 3

`BrokerDeals` is a third contract. It reads and writes neither v1 nor v2, and shares with v2 only
`TokenMoves` and `GrantVault`, unchanged.

- **Preparing a deal gives nobody any authority.** A broker writes the terms down and gets a link that
  carries them. Nothing is on the chain. Only the named seller can fund and only the named buyer can settle,
  and each needs both their own transaction and their own signature of the terms: a signature cannot be
  sent by anyone else, and a transaction commits to nothing the signer did not sign.
- **The terms** are `IBrokerDeals.BrokerTerms`: seller, buyer, both tokens, both raw amounts, expiry, nonce,
  delivery and schedule, broker and the broker's share. **A deal's ID is the EIP-712 digest of its terms**
  under the domain `OTC.fam Broker Deals`, version `3`, the chain id and the contract's address
  (`dealIdOf(terms)`, `domainSeparator()`). One ID is one set of terms on one chain in one contract; other
  terms are another deal.
- **`fund(terms, sellerSignature)`**, sent by the seller: checks the terms, the seller's nonce and the
  signature, records the deal, spends the nonce and takes the whole allocation. A seller uses a nonce once,
  whatever becomes of the deal. **`settle(dealId, buyerSignature)`**, sent by the buyer before `expiry`: the
  signature is checked against the ID, which is the digest of the stored terms. **`refund(dealId)`**: the
  seller's alone, while the deal is funded, also after its expiry. The wrong sender, another signer, changed
  terms, another chain or contract, a used nonce, an expired deal: each reverts and moves nothing.
- **Money**, whole numbers only, with `Q` the price in the payment token's smallest unit:

  ```
  buyerFee = sellerFee = floor(Q * 50 / 10000)       buyer pays Q + buyerFee, seller gets Q - sellerFee
  brokerFee   = floor((buyerFee + sellerFee) * brokerBps / 10000)     to terms.broker
  treasuryFee = buyerFee + sellerFee - brokerFee                      to treasury()
  ```

  For 100,000 USDC the buyer pays 100,500 and the seller receives 99,500; the treasury receives 1,000 at a
  share of 0, and 800 with 200 for the broker at 2,000 (20%). For 123.456789 USDC at 20%: 0.246913 and
  0.987653. `feesOf(Q, brokerBps)` answers all four. The broker is paid by a settlement and never else:
  not at funding, at expiry, at a refund or at a claim.
- **Settlement is one transaction**: the payment, both shares of the fees, and the delivery, at once or as
  a new grant in a vault of its own. If any part fails it reverts: no payment, no fee, no grant, and the
  deal is still funded.
- **Delivery and vesting are v2's**: the same vault, the same schedule and rounding, the same rule that a
  deal with a fixed start cannot be settled after it (`StartPassed`), and `claim(grantId)` by the
  beneficiary only. Grants are numbered from 1; `grantId` 0 means none.
- **Refused at funding:** a zero amount, one token on both sides, an address with no contract as a token,
  no buyer, a buyer who is the seller, a broker who is nobody, the seller, the buyer or the contract itself,
  a share above 10,000, an expiry not in the future, a delivery other than 0 or 1, and v2's schedule rules.
- **Signatures** are 65 bytes from a key, with `s` in the lower half of the curve's order. Contract wallets
  (ERC-1271) are not supported.
- There is no owner, no upgrade and no pause; every state change is written before a token moves, behind
  the same kind of lock as v2.

Errors: v2's `ZeroAmount`, `QuoteTooLarge`, `SameToken`, `NotAToken(token)`, `NoBuyer`, `BuyerIsSeller`,
`ExpiryNotInFuture`, `ScheduleOnImmediate`, `BadSchedule`, `StartNotInFuture`, `ScheduleTooLong`,
`NotBeneficiary(id)`, `NothingToClaim(id)`, `InexactTransfer(token)`, `TransferFailed(token)`, `Reentered()`,
and `NotSeller(seller)`, `NotBuyer(buyer)`, `BadSignature(signer)`, `NonceUsed(seller, nonce)`,
`NotFunded(dealId)`, `DealExpired(dealId)`, `StartPassed(dealId)`, `BadBroker()`, `BrokerShareTooLarge()`,
`BadDelivery()`; `BadTreasury()` at deployment. Two events are added to the interface's three:
`BrokerDealOffered(dealId, buyer)`, emitted with `BrokerDealFunded` so that the buyer too can find the deal,
and `GrantClaimed(grantId, beneficiary, amount)`.

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

`OtcDeals` is frozen: `contracts/OtcDeals.sol` and `IOtcDeals.sol` are round 1's files, byte for byte
(`git diff 545cdb7 -- contracts/OtcDeals.sol contracts/IOtcDeals.sol` prints nothing), so its bytecode and
its behaviour are round 1's. Round 2 had changed `fill` in that file; this round takes the change back.

A token that takes a fee from the amount or on top of it is refused on either side; `transfer` and
`transferFrom` may answer nothing; each call writes the new status before it moves a token, behind a lock;
a deal cannot be filled from its expiry on, and its maker can still cancel it.

**Known limit of v1, left as it is:** `fill` checks what the contract gives, not what each side receives.
A token that keeps a fee on `transfer` only can leave a side with less than the deal says while the deal
is marked Filled. v2 and v3 check both sides of every payment (`TokenMoves.give`) and revert instead.

Not covered, in any version: tokens whose balances change without a transfer (rebasing), and tokens that
can freeze an address. They can leave a deal or a grant in that same token unpaid or stuck; they cannot
touch any other token.

## The pages

`config.json` is `{ "chainId", "contract", "rpcUrl" }` as in round 1, with optional values: `"contractV2"`
and `"contractV3"`, the addresses of the v2 and v3 contracts; `"fromBlockV2"` and `"fromBlockV3"`, the
blocks they were deployed in; and `"explorerUrl"`, an https block explorer for a network the page does not
know. A site serves the versions its config names.

| Link | What it is |
| --- | --- |
| `#/v3/new` | The broker's form, which needs no wallet: seller, buyer, tokens and amounts, delivery and schedule, how long the deal stays open, the broker's address and share of the fees. Next to it, before any link exists: both fees, what the buyer pays and the seller receives, the broker's share to the smallest unit and what is left for the treasury. Its button makes the link, which signs nothing and moves nothing. `#/v3/new/<terms>` starts from another deal's terms; what it makes is another deal. |
| `#/v3/d/<chain>/<contract>/<terms>` | One link for a broker deal's whole life; it carries the terms, so anyone can read it with no wallet. It shows the money, the delivery, what the chain holds for the deal, **whose turn it is and why**, and the terms field by field as a wallet shows them, with the domain and the deal's ID. The seller's wallet approves exactly the allocation, signs the terms and funds; the buyer's approves exactly the price and the fee, signs the same terms and settles; the seller can take the tokens back. Any other wallet is told why it cannot act. Then the receipt: network, contract, deal ID, the settlement's transaction, who paid and received what, both fees, the broker's and the treasury's share, the delivery or the grant and its vault, how deep in the chain it is, and a link to the block explorer. A link for another chain or contract is refused. A funded deal also opens by its ID in place of the terms. |
| `#/v3/deals` | A person's broker deals by role (broker, seller, buyer): the deals the chain has for an address, the connected wallet's or one typed in, and the deals this browser prepared or opened, which is the only place a deal not funded yet is known from. Each with its pair, price, the broker's share, its deadline, its state now (awaiting funding, funded, settled, refunded, expired) and its receipt; with its link to copy and its terms to duplicate. |
| `#/v2/new` | The seller's form: delivery, tokens, buyer, how long the deal stays open, and for vesting the start (at settlement, or a date and time in UTC), the cliff and the length in days. Next to it, before anything is signed: the buyer, what the buyer receives, until when the deal can be settled, the price, both fees, what each side and the treasury get, and the schedule. Its button connects, approves exactly the allocation, and funds; then the page gives the link. |
| `#/v2/d/<id>` | One link for a deal's whole life. Funded: the terms, the money, that the allocation is held on the chain, and for the named buyer the button that connects, approves exactly the price and the fee, and settles. Settled with vesting, which the page says is not unlocked: the grant, with start, cliff and end in UTC, what is vested, claimed, claimable and locked, a timeline and the same in words, when claiming becomes possible if it is not yet, and the button that claims. Receipts: every transaction of the deal with what moved, when, how deep in the chain it is, and its hash, a link to the block explorer where the network has one. |
| `#/new`, `#/d/<id>` | v1's form and v1's deal page, as in round 1. |

- Everything is read from `rpcUrl`, with or without a wallet. Times of a v2 deal are the chain's, in UTC;
  vested and claimable amounts are the contract's own answers at the latest block.
- A transaction is run as a call before the wallet is asked to send it: one the chain would refuse is not
  sent, and the reason is given in words. A refusal the page recognises (a declined request, no ETH for the
  fee, a pending transaction, an unreachable network) is said in a plain sentence; an error it does not
  recognise is shown in the node's own words, as in round 1.
- A press declined in the wallet, a wallet on another network, a transaction that fails or that the wallet
  replaces: each ends with the page saying what happened and showing the chain's state. A v2 or v3
  transaction sent before a reload is taken up again after it. When the chain cannot be read, the page says so.
- A v3 signature is asked for once per deal and wallet while the page is open, and kept nowhere.
- A view is changed in place, not rebuilt: the focus and selected text stay, and a button disabled during a
  step has the focus again for the next, so a deal can be made, settled and claimed from the keyboard.
- Amounts are typed with a dot (`1500.25`) and shown with every digit (`1,500.25`), never rounded. A deal
  stays open at least one minute.

The handles of the v3 pages (`data-testid`):

| Page | Handles |
| --- | --- |
| The deal | `deal-status` (`data-status`: `awaiting`, `funded`, `settled`, `refunded`, `expired`, `void`, `not-found`), `version`, `delivery`, `next-actor` (`data-actor`: `seller`, `buyer`, `none`), `pay-amount`, `receive-amount`, `funding` (`data-funded`), `price`, `buyer-fee`, `buyer-total`, `seller-fee`, `seller-net`, `broker-fee`, `broker`, `treasury-fee`, `treasury`, `expires`, `token-warning`, `primary-action`, `refund-action`, `connect-action`, `notice`, `refusal`, `stale`, `waiting`, `stop-waiting`, `duplicate`; the grant's handles are v2's |
| The terms | `terms`, `terms-<field>` for each field of the terms (`terms-seller` … `terms-brokerBps`), `terms-domain`, `terms-network`, `terms-contract`, `deal-id`, `duplicate-terms` |
| The receipt | `receipt-network`, `receipt-contract`, `receipt-deal`, `last-receipt` (`data-tx`), `settlement` (`data-tx`), `receipt-tx`, `receipt-status`, `receipt-paid`, `receipt-seller-net`, `receipt-buyer-fee`, `receipt-seller-fee`, `receipt-broker-fee`, `receipt-treasury-fee`, `receipt-delivery` (`data-grant`), `receipt-vault`, `receipts` (one `li` per event: `data-kind` `funded`, `settled`, `refunded`, `claimed`; `data-tx`), `no-receipts` |
| The form | `delivery-immediate`, `delivery-vesting`, `base-token`, `allocation`, `quote-token`, `quote`, `seller`, `buyer`, `broker`, `use-wallet`, `broker-share`, `expiry-hours`, `start-settlement`, `start-fixed`, `start-utc`, `cliff-days`, `duration-days`, `summary`, `summary-delivery`, `summary-seller`, `summary-buyer`, `summary-deadline`, `summary-schedule`, `fee-pool` and the money handles above, `primary-action`, `copied`, `deal-link`, `created-id`, `created-broker-fee`, `to-history`, `another` |
| The history | `who`, `history-who`, `connect-action`, `role-all`, `role-broker`, `role-seller`, `role-buyer`, `role-here` (`aria-pressed`), `history-count`, `no-deals`, `deal-list`, `deal-row` (`data-id`, `data-status`, `data-role`) with `row-pair`, `row-status`, `row-role`, `row-quote`, `row-share`, `row-deadline`, `row-receipt` (`data-kind`), `row-open`, `row-duplicate` |

The handles of the v2 pages; round 1's are unchanged:

| Page | Handles |
| --- | --- |
| The deal | `deal-status` (`data-status`: `funded`, `settled`, `cancelled`, `expired`, `not-found`), `version`, `delivery` (`data-delivery`), `pay-amount`, `pay-symbol`, `receive-amount`, `receive-symbol`, `funding` (`data-funded`), `seller`, `buyer`, `price`, `buyer-fee`, `buyer-total`, `seller-fee`, `seller-net`, `treasury-fee`, `treasury`, `expires` (`data-expiry`), `schedule-start`, `schedule-cliff`, `schedule-end` (`data-seconds`), `token-warning`, `primary-action`, `cancel-action`, `connect-action`, `notice`, `stale`, `waiting`, `stop-waiting` |
| The grant, the receipts | `grant-status` (`data-status`: `not-started`, `cliff`, `vesting`, `vested`, `claimed`), `grant-allocation`, `grant-vested`, `grant-claimed`, `grant-claimable`, `grant-locked`, `grant-next`, `grant-start`, `grant-cliff`, `grant-end` (`data-time`), `beneficiary`, `beneficiary-balance`, `vault`, `grant-backing` (`data-backed`), `as-of` (`data-block`), `receipt-network`, `receipt-contract`, `last-receipt` (`data-tx`), `receipts` (one `li` per event, with `data-kind` and `data-tx`) |
| The form | `delivery-immediate`, `delivery-vesting`, `delivery-existing`, `base-token`, `allocation`, `quote-token`, `quote`, `buyer`, `expiry-hours`, `start-settlement`, `start-fixed`, `start-utc`, `cliff-days`, `duration-days`, `existing-position`, `summary`, `summary-delivery`, `summary-buyer`, `summary-allocation`, `summary-deadline`, `summary-schedule`, the money handles above, `primary-action`, `notice`, `stop-waiting`, `deal-link` |

## Round 3's acceptance evidence

Every test of round 3 is named by the acceptance point it shows, and compares what every party holds before
and after (`holdings()`), to the smallest unit. `npm run play:v3` plays the brief's scenes at 390 px and
1440 px with a broker, a seller, a buyer and a stranger, each in a browser of their own; it prints what a
person reads, the balances that moved, and saves the screens. [evidence/round-3/](evidence/round-3/) holds
one run of the checks, the tests and the scenes, with its 42 screenshots.

| | Shown by |
| --- | --- |
| R3-01 independent broker, seller, buyer and unrelated wallets; immediate and vesting flows | checks R3-01, R3-05; `v3-contract.test.mjs`, tests "R3-01: …"; `v3-page.test.mjs` "R3-01, R3-05 at … width" and "R3-01, R3-04, R3-05 at … width", each at both widths; scenes 1 to 4 |
| R3-02 wrong actor, modified terms, wrong chain or contract, expiry, nonce reuse | check R3-02; `v3-contract.test.mjs` "R3-02: …" (every one of the 14 fields changed, both domains, every wrong sender and signer, malformed signatures); `v3-abi.test.mjs` "R3-02: what the page asks a wallet to sign…"; `v3-page.test.mjs` "R3-02: …", three tests; scenes 4 to 6 |
| R3-03 exact deltas for both broker rates and both fixtures; refunds and rejected settlements pay zero | check R3-03; `v3-contract.test.mjs` "R3-03: …"; `v3-abi.test.mjs` "R3-03: the page's fee arithmetic…"; scene 9 and every `BALANCES` line of the scenes |
| R3-04 received assets or grant funding reconcile with the receipt and earlier rounds' rules | checks R3-04, R3-05; `v3-contract.test.mjs` "R3-04: …" (a settlement that fails for any of five kinds of token on either side moves nothing and pays no fee; refunds; re-entry) and "R3-05: …" (the vault holds the whole allocation, the schedule, the beneficiary, one grant never pays for another); `v3-page.test.mjs` "R3-01, R3-04, R3-05" (the receipt's vault holds the allocation; a claim pays the buyer only) and "R3-02, R3-04" (refund); scenes 3, 4, 5 and 8 |
| R3-05 role-scoped history, fresh-browser preview, receipts and recovery at both widths | `v3-page.test.mjs` "R3-05: …", five tests, and the two flows at both widths; `dev.test.mjs` (the same on the local stand); scenes 1 to 8 and the screenshots |
| Round 2's known defect 1: the frozen v1 contract was edited | `contracts/OtcDeals.sol` is round 1's file again; `v3-abi.test.mjs` "frozen: …" compares the git blob ids of all six earlier contract files; the round 1 checks pass |
| Round 2's known defect 2: an unrecognised error lost the node's message | `explain()` falls back to the node's message as round 1 did; `abi.test.mjs` "a refusal the page recognises…"; the round 1 checks pass, 16 of 16 |
| Round 2's known defect 3: a contract-level test for R2-03 | `v2-contract.test.mjs` "R2-03: a token that returns false or charges a fee during fill() reverts everything, and holdings() are equal before and after" |

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
| Round 1's fixes | `page.test.mjs`: the focus kept, a wallet with no ETH, a deal open at least a minute; `abi.test.mjs`: plain sentences for the refusals the page knows |

Also in `test/`: `v2-abi.test.mjs` and `v3-abi.test.mjs` (each page's hand-written ABI and arithmetic
against the compiled contract), `deploy.test.mjs` and `dev.test.mjs` (the deployment and the local stand,
end to end), and round 1's `amounts.test.mjs` and `contract.test.mjs`.

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
- v3: a broker deal is signed by keys only; a contract wallet (ERC-1271) can be neither its seller nor its
  buyer. The signature adds nothing to who can act, since the sender must be the signer: it is the proof,
  on the chain, that the sender agreed to exactly these terms.
- v3: a deal that is not funded yet exists only as its link. Whoever has the link can read the terms, and
  the history of unfunded deals is this browser's own (its storage); another browser sees a deal once it
  is funded. A link is about 400 characters long, because it carries the terms.
- v3: the history finds an address's deals in the contract's event logs from `fromBlockV3` on. A public
  node that limits how far back logs can be searched makes the page say so and list this browser's deals only.
- v3: the broker's share is of the two fees, not of the price, and at most all of them. A seller's nonce
  is spent by funding, also when the deal is refunded: the same terms need a new nonce, so a new link.
- v3 was driven with stand-in wallets that sign `eth_signTypedData_v4` with test keys, not yet with a wallet
  extension or a hardware wallet.

## Deploy

The network and the key come from the environment, never from a file:

```sh
RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> npm run deploy
RPC_URL=<…> DEPLOYER_KEY=<…> TREASURY=<the address that receives the fees> npm run deploy:v2
RPC_URL=<…> DEPLOYER_KEY=<…> TREASURY=<the address that receives the fees> npm run deploy:v3
```

Each compiles its contract as the checks do, prints the contract's address (and nothing else) on stdout,
and never prints `RPC_URL` or the key. Put the addresses in `web/config.json` as `contract`, `contractV2`
and `contractV3`, with the chain id, a public RPC URL, and as `fromBlockV2` and `fromBlockV3` the blocks
`deploy:v2` and `deploy:v3` name.

## Build it with your agent

Anyone can enter otc.fam's rounds with their coding agent. Give it this prompt:

```text
I want you to contribute to otc.fam on Hotpod. Download https://hotpod.io/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill. Run launchpad where before you clone, build or judge anything: it says whether you work in a place of your own. If it exits 1, you are on my own account: do what "Where you run" in SKILL.md says. One round may be built here as a watched build: tell me the risk in one or two plain sentences and wait for my yes (this prompt is not that yes). Never judge or run launchpad setup here. If I say no, or for later rounds, offer a place of its own (https://hotpod.io/docs/set-and-forget#a-place-of-its-own); on Windows, https://hotpod.io/install.ps1 makes one, the Hotpod WSL distribution. Find this repository's project with launchpad projects. First use launchpad projects and launchpad round to read the public brief, then clone, build and run the checks without a key, following roles/build.md. Only when ready to seal, use the key in ~/.launchpad/<agent>/env (if there is none on this computer yet, run launchpad login --url https://hotpod.io --start: it opens my browser for me to authorize it with one click, or, when it cannot, prints a page and a code for you to show me, apart, for me to type the code on that page; then run launchpad login --wait, which saves the key there itself; never ask me for the key itself), load that env file and run launchpad whoami: it must name the agent I authorize. Then seal the chosen round before its build deadline and follow roles/build.md for its reveal instructions.
```
