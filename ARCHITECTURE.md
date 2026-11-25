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
contracts/IBrokerDeals.sol  the interface of the broker deals contract (v3), as round 3's checks give it
contracts/BrokerDeals.sol   its implementation (round 3); it uses GrantVault.sol and TokenMoves.sol as they are
web/                        the page, built into dist/ by "npm run build"
web/config.json             { "chainId", "contract", "rpcUrl" }, for v2 "contractV2" and "fromBlockV2", for v3 "contractV3" and "fromBlockV3"
scripts/deploy.mjs          deploys any of the three; RPC_URL, DEPLOYER_KEY and TREASURY come from the environment only
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

**The broker deals contract** (v3, round 3) is a third contract, independent of the other two. A broker
writes a deal's terms down and passes them on as a link; that is not on the chain and gives nobody any
right. The terms name the seller, the buyer, the tokens and amounts, the expiry, a nonce, the delivery and
the broker with its share of the fees, and the deal's id is their EIP-712 digest for this contract on this
chain. The seller funds with its signature of the terms, the buyer settles with its signature of the same
terms, and only they can: a signature without its signer's own transaction does nothing. Settlement is
v2's, in one transaction, with the two 0.5% fees split between the broker and the treasury; the broker is
paid then and never else. Delivery is v2's too: at once, or a new grant in a `GrantVault` of its own.

**What a version may share.** Code that holds no state and has no owner can be used by a later version as
it is: `TokenMoves` (a library) and `GrantVault` (one new contract per grant, which answers only the
contract that made it). A later version never edits a file an earlier version is compiled from:
`test/v3-abi.test.mjs` compares those files with the git blobs their rounds ended with.

**The page** (static files, no server). It reads `config.json`, then the deal from the chain through
`rpcUrl`: a person sees a deal before connecting any wallet. Sending a transaction goes through the
browser's wallet (`window.ethereum`).

**The link.** `<site>/#/d/<id>` shows deal `<id>`; `<site>/#/new` makes one. A v2 deal's link names its
version: `<site>/#/v2/d/<id>` shows it, and its grant once it is settled; `<site>/#/v2/new` makes one.
A broker deal exists before it is on the chain, so its link carries its terms, and with them the chain and
the contract they are signed for: `<site>/#/v3/d/<chain id>/<contract>/<terms>`, where `<terms>` is the
231 bytes of the fourteen fields at fixed places, as base64 for a URL (`web/v3.js`, `packTerms`). The page
asks the contract for the terms' id (`dealIdOf`) and reads the deal's status by it; it refuses a link whose
chain or contract is not the site's. `<site>/#/v3/new` prepares a deal and `<site>/#/v3/deals` lists a
person's deals by role.

**The handles.** The page marks what it shows with `data-testid` attributes (`deal-status`, `pay-amount`,
`primary-action`…), listed in round 1's brief. The checks and later rounds rely on them: a round may add
handles, never rename one.

## The rounds

| Round | Title | What it adds | How it is checked | Prize |
| --- | --- | --- | --- | --- |
| 1 | One deal, one link | The deal contract, and the smallest page that shows a deal from its link and fills it | The contract on a local chain with the checks' own tokens; the built page in a browser with a stand-in wallet | 1,000,000 points |
| 2 | Vesting OTC: funded grants and exact fees | The v2 contract: a 0.5% fee on each side, delivery at once or as a new vesting grant, and the pages that fund, settle and claim | The v2 contract on a local chain with the checks' tokens (`.launchpad/checks/round-2/`), and all of round 1's checks again; the pages by the judges | 1,000,000 points |
| 3 | Broker deals: signed terms and receipts | The v3 contract: terms a broker prepares and both parties sign (EIP-712), a broker's share of the fees, immediate or vesting delivery; the broker's form, the deal's page, a history by role and receipts | The v3 contract on a local chain (`.launchpad/checks/round-3/`), and all of round 1's and round 2's checks again; the pages by the judges | Set on Hotpod |

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
