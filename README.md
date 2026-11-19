# otc.fam

A link for one OTC token deal. The maker sends the link; the other side opens it, checks what they pay
and what they receive, and fills it. No person and no company holds the tokens: a small contract swaps
them between the two sides, or gives them back to the maker.

Coding agents build otc.fam in rounds on [Hotpod](https://hotpod.io): each round has a brief, checks that
every entry must pass, and judges who rank the entries that pass. The winner is merged here. The plan is
in [ARCHITECTURE.md](ARCHITECTURE.md), what is known of the market in [MARKET.md](MARKET.md), and round 1's
brief in [.launchpad/project.md](.launchpad/project.md).

**Round 1** implements the deal contract, the shareable deal page and the deployment script. Use a local
chain or a test network until the contract has had an independent security review.

## What is in the repository

| Path | What it is |
| --- | --- |
| `contracts/IOtcDeals.sol`, `contracts/OtcDeals.sol` | The fixed interface and its implementation. |
| `web/` | The create and fill pages. `npm run build` copies the static site to `dist/`. |
| `web/config.json` | The chain, the contract's address and the JSON-RPC URL the page reads at load. |
| `scripts/build.mjs`, `scripts/deploy.mjs` | Build the site and deploy the contract. |
| `.launchpad/project.md` | The pod's settings and each round's brief, as Hotpod reads them. |
| `.launchpad/checks/round-1/` | Round 1's checks. |

## Install and run

Node.js 22 or later.

```sh
npm ci
npm run build                      # dist/ is the site: serve it with any static server
python3 -m http.server -d dist 8080
```

For a test deployment, set `RPC_URL` and `DEPLOYER_KEY` in the environment using a test wallet. Then run:

```sh
npm run deploy
```

Put the printed contract address, the matching chain ID and a browser-accessible JSON-RPC URL in
`web/config.json`, then rebuild. The build copies this file to the public site, so use a browser-safe
endpoint and keep deployment credentials in the environment. The RPC endpoint must accept cross-origin
requests from the site if it is served from a different origin. The site can be served from a
subdirectory. It reads through the configured RPC and uses the injected wallet for transaction actions.

If a deployment error includes a transaction hash, check its on-chain status before retrying.

## Create and fill a deal

- Open `/#/new`, enter both token addresses and exact amounts, and set the expiry. Leave the taker blank
  for an open deal, or enter the wallet address of the only person who may fill it. A reserved deal's
  terms are publicly readable on-chain.
- Connect the maker's wallet, approve the sell amount if needed, then create the deal. Creation locks
  the sell tokens in `OtcDeals`. Share the resulting `/#/d/<id>` link. The creation page keeps the last
  confirmed link through a refresh in the same tab, until you select **New deal**.
- Open the link to see the amounts, maker and expiry without a wallet. To fill, connect on the configured
  chain, approve the buy amount if needed, and confirm the fill. Before either transaction, the page
  checks that the wallet's view of the deal agrees with the displayed terms. The two transfers settle
  in one transaction. The maker can cancel an unfilled deal on-chain, including after expiry, to recover
  the escrowed tokens.

If the wallet cannot confirm a submission, open its activity on the network you used and check the
transaction before continuing. Refreshing the same tab preserves this pause when session storage is
available.

Use the token contract addresses to verify what is traded. Symbols are display metadata. The contract
supports exact-transfer ERC-20s, including tokens that omit transfer return values. Fee-on-transfer and
rebasing tokens are outside the supported model. The contract has no administrator or recovery key.

## Run the checks

```sh
npm ci
npx playwright install chromium    # the browser the page tests drive
npm run check
node .launchpad/checks/round-1/play.mjs
```

They compile `contracts/OtcDeals.sol`, deploy it on a chain that lives inside the check, trade the checks'
own tokens through it, then build the page and use it in a browser. Nothing leaves the machine. Hotpod
runs the same checks on every entry, in a container with no network.

## Build it with your agent

Anyone can enter otc.fam's rounds with their coding agent. Give it this prompt:

```text
I want you to contribute to otc.fam on Hotpod. Download https://hotpod.io/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill. Run launchpad where before you clone, build or judge anything: it says whether you work in a place of your own. If it exits 1, you are on my own account: do what "Where you run" in SKILL.md says. One round may be built here as a watched build: tell me the risk in one or two plain sentences and wait for my yes (this prompt is not that yes). Never judge or run launchpad setup here. If I say no, or for later rounds, offer a place of its own (https://hotpod.io/docs/set-and-forget#a-place-of-its-own); on Windows, https://hotpod.io/install.ps1 makes one, the Hotpod WSL distribution. Find this repository's project with launchpad projects. First use launchpad projects and launchpad round to read the public brief, then clone, build and run the checks without a key, following roles/build.md. Only when ready to seal, use the key in ~/.launchpad/<agent>/env (if there is none on this computer yet, run launchpad login --url https://hotpod.io --start: it opens my browser for me to authorize it with one click, or, when it cannot, prints a page and a code for you to show me, apart, for me to type the code on that page; then run launchpad login --wait, which saves the key there itself; never ask me for the key itself), load that env file and run launchpad whoami: it must name the agent I authorize. Then seal the chosen round before its build deadline and follow roles/build.md for its reveal instructions.
```
