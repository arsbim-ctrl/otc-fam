# otc.fam

A link for one OTC token deal. The maker sends the link; the other side opens it, checks what they pay
and what they receive, and fills it. No person and no company holds the tokens: a small contract swaps
them between the two sides, or gives them back to the maker.

Coding agents build otc.fam in rounds on [Hotpod](https://hotpod.io): each round has a brief, checks that
every entry must pass, and judges who rank the entries that pass. The winner is merged here. The plan is
in [ARCHITECTURE.md](ARCHITECTURE.md), what is known of the market in [MARKET.md](MARKET.md), and round 1's
brief in [.launchpad/project.md](.launchpad/project.md).

**Where it stands.** Round 1 built the deal contract, the deal page and the deployment. What was chosen
where the brief left it open:

- The contract holds the maker's sell tokens from `createDeal` until the fill or the cancel, so a fill
  never fails for lack of the maker's tokens. Each deal's status is written before any token is called:
  a token that re-enters `fill` or `cancel` finds the deal closed.
- Tokens are called by a low-level `call`: one that returns nothing (USDT) is accepted, one that returns
  `false`, reverts, or is not a contract is refused. No library.
- The page is one HTML file with no dependency and no bundler: it encodes and decodes the few ABI calls
  it needs by hand and talks JSON-RPC with `fetch`. `npm run build` copies `web/` to `dist/`.
- Nothing here has been audited, and nothing is deployed yet.

## What is in the repository

| Path | What it is |
| --- | --- |
| `contracts/IOtcDeals.sol`, `contracts/OtcDeals.sol` | The deal contract's fixed interface, and the contract. |
| `web/` | The page. `npm run build` makes the static site in `dist/`. |
| `web/config.json` | The chain, the contract's address and the JSON-RPC URL the page reads at load. |
| `scripts/build.mjs`, `scripts/deploy.mjs` | The build, and the deployment: it compiles the contract as the checks do and deploys it with ethers. |
| `.launchpad/project.md` | The pod's settings and each round's brief, as Hotpod reads them. |
| `.launchpad/checks/round-1/` | Round 1's checks. |

## Install and run

Node.js 22 or later.

```sh
npm ci
npm run build                      # dist/ is the site: serve it with any static server
python3 -m http.server -d dist 8080
```

Deploying the contract takes the network and the key from the environment,
never from a file:

```sh
RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> npm run deploy
```

It prints the contract's address: put it in `web/config.json`, with the network's chain id and RPC URL.

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
