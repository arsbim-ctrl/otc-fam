# otc.fam: the plan

otc.fam is a link for one OTC token deal. This file says what is fixed, what each round adds, and which
parts are the creator's words and which are proposals he can still change.

## What the creator asked for

- A link for one deal, like a calendar link, that one side sends to the other.
- Totally non-custodial.
- A page that looks like Uniswap, not like a SaaS form.

Everything else below is **proposed**: the chain, the contract's shape, the link's format, the rounds.

## The parts

```
contracts/IOtcDeals.sol     the fixed interface of the deal contract (v1)
contracts/OtcDeals.sol      its implementation (round 1)
contracts/IOtcDealsV2.sol   the interface of the v2 deal contract, as round 2's checks give it
contracts/OtcDealsV2.sol    its implementation (round 2), with GrantVault.sol and TokenMoves.sol
web/                        the page, built into dist/ by "npm run build"
web/config.json             { "chainId", "contract", "rpcUrl" }, and for v2 "contractV2" and "fromBlockV2"
scripts/deploy.mjs          deploys either contract; RPC_URL, DEPLOYER_KEY and TREASURY come from the environment only
```

**The contract** (Solidity, any EVM chain). One contract holds every deal. A deal says: the maker gives
`sellAmount` of `sellToken` and wants `buyAmount` of `buyToken`, from one named taker or from anyone,
until `expiry`. `createDeal` makes it, `fill` swaps the tokens in one transaction, `cancel` gives the
maker's tokens back, `getDeal` reads it. Ids count up from 1. The contract has no owner, no fee, no
upgrade and no pause. Whether it keeps the maker's tokens from `createDeal` or takes them at `fill` is
each entry's choice in round 1.

**The v2 contract** (round 2) is a second contract, deployed next to the first and independent of it. A
deal is for one named buyer; its seller's allocation is held from `createDeal`; `fill` settles payment,
a 0.5% fee on each side (to a treasury fixed at deployment) and delivery in one transaction; delivery is
immediate, or a new vesting grant whose tokens sit in a vault of their own and are paid to the buyer by
`claim` as they vest. The first contract keeps its deals, its ABI and its links, and never takes a fee.
Later versions follow the same rule: a new behaviour is a new contract with its own links, never a change
to deals that are already funded.

**The page** (static files, no server). It reads `config.json`, then the deal from the chain through
`rpcUrl`: a person sees a deal before connecting any wallet. Sending a transaction goes through the
browser's wallet (`window.ethereum`).

**The link.** `<site>/#/d/<id>` shows deal `<id>`; `<site>/#/new` makes one. A v2 deal's link names its
version: `<site>/#/v2/d/<id>` shows it, and its grant once it is settled; `<site>/#/v2/new` makes one.

**The handles.** The page marks what it shows with `data-testid` attributes (`deal-status`, `pay-amount`,
`primary-action`…), listed in round 1's brief. The checks and later rounds rely on them: a round may add
handles, never rename one.

## The rounds

| Round | Title | What it adds | How it is checked | Prize |
| --- | --- | --- | --- | --- |
| 1 | One deal, one link | The deal contract, and the smallest page that shows a deal from its link and fills it | The contract on a local chain with the checks' own tokens; the built page in a browser with a stand-in wallet | 1,000,000 points |
| 2 | Vesting OTC: funded grants and exact fees | The v2 contract: a 0.5% fee on each side, delivery at once or as a new vesting grant, and the pages that fund, settle and claim | The v2 contract on a local chain with the checks' tokens (`.launchpad/checks/round-2/`), and all of round 1's checks again; the pages by the judges | 1,000,000 points |
| 3 | To be decided | Added on Hotpod after round 2 has settled | Decided after round 2 | To set |

Rounds are added on Hotpod, each after the one before has settled.

## Where it runs

- **Checks:** a chain inside the check's own process, with no network. The compiler is solc 0.8.38,
  optimizer on (200 runs), EVM version cancun.
- **Demo (proposed):** Base Sepolia, after round 1 is merged. The creator deploys with his own key; no key
  is ever in this repository. `web/config.json` holds Base Sepolia's chain id and a zero address until then.
- **Any main network:** not before a security review of the winning contract. Depending on the winning
  design, the contract holds the makers' tokens between `createDeal` and `fill` or `cancel`.

## What it is not

Points only on Hotpod: no token, no fee, nothing to pay. otc.fam takes no custody and gives no advice
about any token or any deal.
