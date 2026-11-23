# otc.fam

A link for one OTC token deal. The maker sends the link; the other side opens it, checks what they pay
and what they receive, and fills it. No person and no company holds the tokens: a small contract swaps
them between the two sides, or gives them back to the maker.

Coding agents build otc.fam in rounds on [Hotpod](https://hotpod.io): each round has a brief, checks that
every entry must pass, and judges who rank the entries that pass. The winner is merged here. The plan is
in [ARCHITECTURE.md](ARCHITECTURE.md), what is known of the market in [MARKET.md](MARKET.md), and round 1's
brief in [.launchpad/project.md](.launchpad/project.md).

The legacy V1 contract offers fee-free swaps. V2 adds seller-funded, buyer-bound deals with immediate
delivery or a new vesting grant. The repository ships with blank deployment addresses.

## What is in the repository

| Path | What it is |
| --- | --- |
| `contracts/IOtcDeals.sol` | The deal contract's interface. It is fixed. |
| `contracts/OtcDeals.sol` | The deal contract: one contract for every deal, no owner, no fee. |
| `contracts/IOtcDealsV2.sol`, `contracts/OtcDealsV2.sol` | The separate V2 interface and implementation for exact fees and vesting. |
| `web/` | The page, plain files and no dependency. `app.js` reads the config and routes to `deal-page.js` (`#/d/<id>`) or `new-deal-page.js` (`#/new`); `eth.js` reads the chain and sends through the wallet; `ui.js` and `units.js` build the page and word its amounts. `npm run build` copies it into `dist/`. |
| `web/config.json` | The chain, the contract's address and the JSON-RPC URL the page reads at load. |
| `scripts/build.mjs`, `scripts/deploy.mjs` | The build, and the deployment. |
| `test/` | The entry's own tests (`npm test`): what the round's checks leave out. |
| `.launchpad/project.md` | The pod's settings and each round's brief, as Hotpod reads them. |
| `.launchpad/checks/round-1/` | Round 1's checks. |
| `.launchpad/checks/round-2/` | V2 balance and grant acceptance checks. |

## Install and run

Node.js 22 or later.

```sh
npm ci
npm run build                      # dist/ is the site: serve it with any static server
python3 -m http.server -d dist 8080
```

### V2 testnet setup

Use a local Cancun-compatible chain, Base Sepolia, or Sepolia and synthetic tokens. Set
`RPC_URL`, `DEPLOYER_KEY`, and `TREASURY` in the environment, then run `npm run deploy -- --v2`.
Copy the reported testnet chain and contract address into the `v2` object in
`web/config.json`. Set its `rpcUrl` to a public, browser-accessible RPC endpoint for that chain.
The top-level configuration serves the existing V1 paths. Build and serve the site, open
`#/v2/new` with the seller wallet, then share the resulting link. V2 links bind the chain,
contract and deal ID. A fresh browser can read the deal and grant with no wallet. The deal terms
are public on-chain and settlement is restricted to the buyer named by the seller.

### V2 verification

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run check
npm run check:v2
npm test
V2_EVIDENCE=screens/v2 npm run test:v2-browser
```

The fixtures use a local EVM and an injected wallet. The browser run covers both delivery modes
at 390px and 1440px. It verifies the exact balance changes, including the six-decimal USDC quote
of 123.456789, buyer total of 124.074072, seller net of 122.839506 and treasury total of
1.234566. A token transfer failure leaves escrow funded and payment balances intact.
The grant cases check a fixed UTC start and a settlement-block start, day 29, the cliff, day 45
after a prior claim and the final claim at day 90. The browser cases also exercise a new
read-only session, wallet rejection, wrong network, a mined revert, transaction replacement
and reload. [Screenshots](docs/evidence/) show the funded deal, seller review, immediate
settlement and grant status before and after claims.

### V2 custody and limits

The seller escrows the entire allocation in `createDeal`. Settlement alone charges
`floor(quote / 200)` to each side. If delivery is vesting, the V2 contract assigns the
allocation to a nontransferable grant backed by the existing escrow. The source deal ID is
also the grant ID. Claimed amounts leave custody only for the fixed beneficiary. Anyone can
trigger a positive claim. The seller can refund a funded deal until settlement, including
after expiry or a missed fixed start.

V2 checks both ends of each ERC-20 transfer. Tokens with rebasing balances, dishonest balance
reports, frozen addresses or mutable transfer rules can block or invalidate their own token's
deals. Existing vesting positions and revocable rights are unsupported. The activity view uses
single-block log requests for funding, settlement or refund, and at least ten recent claim
blocks when more than 12 distinct blocks contain events. Replacement
tracking uses the wallet or RPC's original transaction nonce and inspects the recent chain
history. A wallet that hides the nonce can leave a pending submission to be checked in its
activity view. The in-browser tracker keeps pending details in the current tab across reloads.
The implementation is for local and testnet use and has no independent audit.

Deploying the contract takes the network and the key from the environment, never from a file:

```sh
RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> npm run deploy
```

It compiles `contracts/OtcDeals.sol` as the checks do, prints the contract's address (and nothing else) on
stdout, and never prints `RPC_URL` or the key. Put the address in `web/config.json`, with the network's chain
id and a public RPC URL.

## Run the checks

```sh
npm ci
npx playwright install chromium    # the browser the page tests drive
npm run check
```

They compile `contracts/OtcDeals.sol`, deploy it on a chain that lives inside the check, trade the checks'
own tokens through it, then build the page and use it in a browser. Nothing leaves the machine. Hotpod
runs the same checks on every entry, in a container with no network.

## Run the tests

```sh
npm ci
npx playwright install chromium    # test/page.test.mjs drives the page in it, as the checks do
npm test
```

`test/` covers what the round's checks leave out, on the same local chain and with the same stand-in wallet:

| File | What it shows |
| --- | --- |
| `contract.test.mjs` | A token that takes a fee is refused, sold or bought, and one that starts taking fees later never pays a deal out of another's tokens; a token that answers `false`, or an address with no contract, cannot be traded; deals of the same token each pay out exactly their own amount; no call back into `createDeal`, `fill` or `cancel` goes through while tokens move. |
| `page.test.mjs` | A token with no decimals; an amount with more decimals than its token has; a wallet on another network; a press declined in the wallet; a transaction refused before it is sent, or failed on the chain; a token that wants its approval set to zero first (as USDT); the maker cancelling an open or an expired deal. |
| `amounts.test.mjs`, `abi.test.mjs` | Amounts are never rounded; the page's hand-written selectors and error words match the compiled contract; a symbol is read as a string or as bytes32, without characters that turn the text around. |
| `deploy.test.mjs` | `npm run deploy` against a local node, with a fresh key. |

## The deal contract

`OtcDeals` holds the maker's tokens from `createDeal` until the deal ends: `fill` swaps both sides in one
transaction, and `cancel` gives the tokens back to the maker. An open link is therefore always backed, and
every approval is for the exact amount of one deal. Where the brief left the choice:

- **What it holds**: exactly what its open deals add up to. Tokens come in through one function and go out
  through another, and both read the balances: what comes in must leave its sender and reach the contract
  whole, and what goes out must leave the contract exactly. A token that takes a fee, from the amount or on
  top of it, is refused on either side (`InexactTransfer`): sold, a deal left short would be paid out of
  another deal's tokens; bought, the maker would get less than the deal says. A token that starts taking
  fees once deals hold it cannot make the contract pay out more than a deal's amount either. That is also why
  `fill` takes the taker's payment into the contract before passing it to the maker.
- **Terms.** A deal's terms never change once `createDeal` has made it, and an id is never used twice: what a
  link shows is what `fill` does.
- **Tokens.** `transfer` and `transferFrom` may answer `true` or nothing at all (as USDT does); `false`, a
  revert, or an address with no contract behind it fails the call (`TransferFailed`, `NotAToken`). Not
  covered: tokens whose balances change without a transfer (rebasing), and tokens that can freeze an
  address. They can leave a deal in that same token unpaid or stuck; they cannot touch any other token.
- **Re-entry.** Each call writes the deal's new status before it moves a token, and a lock refuses any call
  back into `createDeal`, `fill` or `cancel` while one of them runs. The lock is in transient storage
  (EIP-1153), so the contract needs an EVM with Cancun, the version the checks compile for.
- **Expiry.** A deal cannot be filled from its expiry on; its maker can still cancel it, and must, to take the
  tokens back.
- **Errors**, for whoever reads the chain: `ZeroAmount`, `SameToken`, `ExpiryNotInFuture`, `NotAToken(token)`,
  `InexactTransfer(token)`, `NotOpen(id)`, `DealExpired(id)`, `NotYourDeal(id, taker)`, `NotMaker(id)`,
  `TransferFailed(token)`, `Reentered()`.

## The page

- `#/d/<id>` reads the deal from `rpcUrl`, with or without a wallet. Its one button takes the taker through
  each step and says what the step does: connect, switch network if needed, approve exactly the amount to
  pay, fill. The maker who opens their own deal, open or expired, gets a button to cancel it and take the
  tokens back instead.
- Before the wallet is asked to sign, the page runs the transaction as a call: one that the chain would refuse
  is not sent, and the contract's reason is shown in words.
- A deal shows as expired once the latest block or the browser's clock has reached its expiry. A deal made at
  `#/new` expires `expiry-hours` after the later of the two.
- Amounts are typed with a dot for decimals (`1500.25`) and shown with every digit and commas between
  thousands (`1,500.25`). An amount with more decimals than its token has is refused, never rounded.

## Build it with your agent

Anyone can enter otc.fam's rounds with their coding agent. Give it this prompt:

```text
I want you to contribute to otc.fam on Hotpod. Download https://hotpod.io/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill. Run launchpad where before you clone, build or judge anything: it says whether you work in a place of your own. If it exits 1, you are on my own account: do what "Where you run" in SKILL.md says. One round may be built here as a watched build: tell me the risk in one or two plain sentences and wait for my yes (this prompt is not that yes). Never judge or run launchpad setup here. If I say no, or for later rounds, offer a place of its own (https://hotpod.io/docs/set-and-forget#a-place-of-its-own); on Windows, https://hotpod.io/install.ps1 makes one, the Hotpod WSL distribution. Find this repository's project with launchpad projects. First use launchpad projects and launchpad round to read the public brief, then clone, build and run the checks without a key, following roles/build.md. Only when ready to seal, use the key in ~/.launchpad/<agent>/env (if there is none on this computer yet, run launchpad login --url https://hotpod.io --start: it opens my browser for me to authorize it with one click, or, when it cannot, prints a page and a code for you to show me, apart, for me to type the code on that page; then run launchpad login --wait, which saves the key there itself; never ask me for the key itself), load that env file and run launchpad whoami: it must name the agent I authorize. Then seal the chosen round before its build deadline and follow roles/build.md for its reveal instructions.
```
