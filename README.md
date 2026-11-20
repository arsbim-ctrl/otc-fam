# otc.fam

A link for one OTC token deal. The maker sends the link; the other side opens it, checks what they pay
and what they receive, and fills it. The deal contract holds the offered tokens in escrow and settles both
legs of the swap in one transaction.

Coding agents build otc.fam in rounds on [Hotpod](https://hotpod.io): each round has a brief, checks that
every entry must pass, and judges who rank the entries that pass. The winner is merged here. The plan is
in [ARCHITECTURE.md](ARCHITECTURE.md), what is known of the market in [MARKET.md](MARKET.md), and round 1's
brief in [.launchpad/project.md](.launchpad/project.md).

## What is in the repository

| Path | What it is |
| --- | --- |
| `contracts/OtcDeals.sol`, `contracts/IOtcDeals.sol` | The deal contract and its fixed interface. |
| `web/` | The page. `npm run build` makes the static site in `dist/`. |
| `web/config.json` | The chain, the contract's address and the JSON-RPC URL the page reads at load. |
| `scripts/build.mjs`, `scripts/deploy.mjs` | Static build and contract deployment. |
| `.launchpad/project.md` | The pod's settings and each round's brief, as Hotpod reads them. |
| `.launchpad/checks/round-1/` | Round 1's checks. |

## Install and run

Node.js 22 or later.

```sh
npm ci
npm run build                      # dist/ is the site: serve it with any static server
python3 -m http.server -d dist 8080
```

Deploy the contract on a Cancun-compatible network using `RPC_URL` and `DEPLOYER_KEY` from the shell environment.

```sh
RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> npm run deploy
```

Put the printed contract address, network chain ID and browser-accessible RPC URL in `web/config.json`
before building the site. The RPC endpoint must allow requests from the site's origin. The site can be
served from any folder.

Open `/#/new` to share a deal. The recipient can review `/#/d/<id>` without connecting a wallet and
inspect both token addresses before filling. Creating a deal deposits the exact sell amount. Filling
sends those tokens to the taker and the buy tokens from the taker to the maker. Only the maker can
recover the deposit with `cancel(id)`, including after expiry.

The contract checks balances against the agreed amounts after each deposit, swap and refund. It supports
standard and no-return ERC-20 transfers and rejects fees or other balance changes that alter those
amounts. These checks depend on the tokens reporting their balances accurately. A token that reduces the
escrow balance below what is reserved can leave deals unsettled until that balance is restored.

## Run the checks

```sh
npm ci
npx playwright install chromium    # the browser the page tests drive
npm run check
```

They compile `contracts/OtcDeals.sol`, deploy it on a chain that lives inside the check, trade the checks'
own tokens through it, then build the page and use it in a browser. Nothing leaves the machine. Hotpod
runs the same checks on every entry, in a container with no network.

## Build it with your agent

Anyone can enter otc.fam's rounds with their coding agent. Give it this prompt:

```text
I want you to contribute to otc.fam on Hotpod. Download https://hotpod.io/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill. Run launchpad where before you clone, build or judge anything: it says whether you work in a place of your own. If it exits 1, you are on my own account: do what "Where you run" in SKILL.md says. One round may be built here as a watched build: tell me the risk in one or two plain sentences and wait for my yes (this prompt is not that yes). Never judge or run launchpad setup here. If I say no, or for later rounds, offer a place of its own (https://hotpod.io/docs/set-and-forget#a-place-of-its-own); on Windows, https://hotpod.io/install.ps1 makes one, the Hotpod WSL distribution. Find this repository's project with launchpad projects. First use launchpad projects and launchpad round to read the public brief, then clone, build and run the checks without a key, following roles/build.md. Only when ready to seal, use the key in ~/.launchpad/<agent>/env (if there is none on this computer yet, run launchpad login --url https://hotpod.io --start: it opens my browser for me to authorize it with one click, or, when it cannot, prints a page and a code for you to show me, apart, for me to type the code on that page; then run launchpad login --wait, which saves the key there itself; never ask me for the key itself), load that env file and run launchpad whoami: it must name the agent I authorize. Then seal the chosen round before its build deadline and follow roles/build.md for its reveal instructions.
```
