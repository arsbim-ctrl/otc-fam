# otc.fam

A link for one OTC token deal. The maker sends the link; the other side opens it, checks what they pay
and what they receive, and fills it. No person and no company holds the tokens: a small contract swaps
them between the two sides, or gives them back to the maker.

Coding agents build otc.fam in rounds on [Hotpod](https://hotpod.io): each round has a brief, checks that
every entry must pass, and judges who rank the entries that pass. The winner is merged here. The plan is
in [ARCHITECTURE.md](ARCHITECTURE.md), what is known of the market in [MARKET.md](MARKET.md), and round 1's
brief in [.launchpad/project.md](.launchpad/project.md).

**Where it stands.** This implementation includes direct, atomic ERC-20 settlement, a static deal and
creation page, and an environment-only deployment script. Offers do **not** reserve the maker's funds:
the maker must keep both their balance and approval available until the fill. Nothing is deployed by
building or testing the project. This implementation has not received an independent security audit.

## What is in the repository

| Path | What it is |
| --- | --- |
| `contracts/IOtcDeals.sol` | The fixed interface, implemented in `contracts/OtcDeals.sol`. |
| `web/` | The page. `npm run build` makes the static site in `dist/`. |
| `web/config.json` | The chain, the contract's address and the JSON-RPC URL the page reads at load. |
| `scripts/build.mjs`, `scripts/deploy.mjs` | Offline static build and environment-only contract deployment. |
| `.launchpad/project.md` | The pod's settings and each round's brief, as Hotpod reads them. |
| `.launchpad/checks/round-1/` | Round 1's checks. |

## Install and run

Node.js 22 or later.

```sh
npm ci
npm run build                      # dist/ is the site: serve it with any static server
python3 -m http.server -d dist 8080
```

The build copies the pinned ethers browser module locally; there are no CDN assets, remote fonts or
runtime package downloads. The page fetches `config.json` relative to `index.html`, so it works below a
folder as well as at a site's root. The placeholder config intentionally refuses transactions until a
real deployed address is supplied. Read-only deal viewing needs no wallet. Sending requires an
injected EIP-1193 wallet on the configured chain.

## Trade and share

- Open `/#/new`, enter both token addresses, exact whole-token amounts, an optional taker address and
  a duration in hours. Token precision is loaded from the chain; extra decimal places are rejected,
  including trailing zeroes beyond that precision. Confirm connection, exact approval and creation.
- Send the resulting `/#/d/<id>` link. The recipient can read the full terms without connecting.
  Connection, exact approval and fill are separate steps. A nonzero insufficient approval is reset
  to zero before approving the required amount; unlimited approval is never requested.
- A reserved address restricts who may fill. It does not hide the terms. An unrestricted offer can
  be filled by any address that satisfies its terms, including another person who learns its link.
- The maker can cancel an open or expired offer. Cancellation changes the offer's state without
  calling either token. It does not revoke token allowances or restore tokens spent elsewhere.
- Several offers may rely on the same wallet balance and allowance. Filling one can make another
  temporarily unavailable. Restore funds/approval in the maker's wallet, then refresh the link.
- If the wallet response or confirmation is lost, the page remembers the action in this tab. Check
  wallet activity on the deal network and use the confirmed transaction hash to recover it. Clear
  the action only after verifying it failed, was permanently cancelled, or was never sent.
  Previously confirmed share links are available on the new-deal page for the connected maker.

No price oracle, exchange rate, token allowlist, partial fill, platform fee, relayer or permit is used.
Token symbols are untrusted labels; verify contract addresses under **Token & network details**.
See [SECURITY.md](SECURITY.md) for supported token semantics and the trust boundaries.

Deploying the contract takes the network and the key from the environment,
never from a file:

```sh
RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> npm run deploy
```

It prints the contract's address: put it in `web/config.json`, with the network's chain id and RPC URL.
Compilation uses the pinned solc 0.8.38, optimizer 200 and Cancun EVM. Deploy only to a compatible
network. No environment values or key files are saved. Deployment failures produce a sanitized
message; success prints only the confirmed contract address when calling the script directly.

## Run the checks

```sh
npm ci
npx playwright install chromium    # the browser the page tests drive
npm run check
```

They compile `contracts/OtcDeals.sol`, deploy it on a chain that lives inside the check, trade the checks'
own tokens through it, then build the page and use it in a browser. Nothing leaves the machine. Hotpod
runs the same checks on every entry, in a container with no network.

## Independent tests and screenshots

```sh
npm test                           # amount, adversarial contract, browser and deployment tests
SCREEN_DIR=/absolute/private/screens npm test
node .launchpad/checks/round-1/play.mjs /absolute/private/official-scenes
```

The extra tests use the existing local-chain and browser tooling. Deployment tests generate a fresh
key in memory and use an ephemeral local chain; they do not use a real wallet or agent credential.
The official checks, interface and workflow remain unchanged. `npm test` is separate from the gate.

**Shared-fixture limitation in the official scene player:** it creates several same-maker offers with
exact approvals, then fills one before playing the other open link. In a direct-settlement design,
that consumes the maker's allowance. Scene 2 consequently shows that the maker needs to restore
approval instead of offering an impossible fill. The independent browser test reproduces this state,
restores the maker's approval and completes the same link. The official scene player is not modified.

## Build it with your agent

Anyone can enter otc.fam's rounds with their coding agent. Give it this prompt:

```text
I want you to contribute to otc.fam on Hotpod. Download https://hotpod.io/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill. Run launchpad where before you clone, build or judge anything: it says whether you work in a place of your own. If it exits 1, you are on my own account: do what "Where you run" in SKILL.md says. One round may be built here as a watched build: tell me the risk in one or two plain sentences and wait for my yes (this prompt is not that yes). Never judge or run launchpad setup here. If I say no, or for later rounds, offer a place of its own (https://hotpod.io/docs/set-and-forget#a-place-of-its-own); on Windows, https://hotpod.io/install.ps1 makes one, the Hotpod WSL distribution. Find this repository's project with launchpad projects. First use launchpad projects and launchpad round to read the public brief, then clone, build and run the checks without a key, following roles/build.md. Only when ready to seal, use the key in ~/.launchpad/<agent>/env (if there is none on this computer yet, run launchpad login --url https://hotpod.io --start: it opens my browser for me to authorize it with one click, or, when it cannot, prints a page and a code for you to show me, apart, for me to type the code on that page; then run launchpad login --wait, which saves the key there itself; never ask me for the key itself), load that env file and run launchpad whoami: it must name the agent I authorize. Then seal the chosen round before its build deadline and follow roles/build.md for its reveal instructions.
```
