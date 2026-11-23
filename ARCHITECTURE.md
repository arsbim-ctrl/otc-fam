# otc.fam: the plan

otc.fam is a link for one OTC token deal. This file says what is fixed, what each round adds, and which
parts are the creator's words and which are proposals he can still change.

## What the creator asked for

- A link for one deal, like a calendar link, that one side sends to the other.
- Totally non-custodial.
- A page that looks like Uniswap, not like a SaaS form.

The sections below record the interfaces for the first two rounds and the remaining proposals.

## The parts

```
contracts/IOtcDeals.sol   the fixed interface of the deal contract
contracts/OtcDeals.sol    its implementation (round 1)
web/                      the page, built into dist/ by "npm run build"
web/config.json           { "chainId", "contract", "rpcUrl" }: read by the page when it loads
scripts/deploy.mjs        deploys OtcDeals; RPC_URL and DEPLOYER_KEY come from the environment only
```

**The contract** (Solidity, any EVM chain). One contract holds every deal. A deal says: the maker gives
`sellAmount` of `sellToken` and wants `buyAmount` of `buyToken`, from one named taker or from anyone,
until `expiry`. `createDeal` makes it, `fill` swaps the tokens in one transaction, `cancel` gives the
maker's tokens back, `getDeal` reads it. Ids count up from 1. The contract has no owner, no fee, no
upgrade and no pause. Whether it keeps the maker's tokens from `createDeal` or takes them at `fill` is
each entry's choice in round 1.

**The page** (static files, no server). It reads `config.json`, then the deal from the chain through
`rpcUrl`: a person sees a deal before connecting any wallet. Sending a transaction goes through the
browser's wallet (`window.ethereum`).

**The link.** `<site>/#/d/<id>` shows deal `<id>`; `<site>/#/new` makes one.

**The handles.** The page marks what it shows with `data-testid` attributes (`deal-status`, `pay-amount`,
`primary-action`…), listed in round 1's brief. The checks and later rounds rely on them: a round may add
handles, never rename one.

## V2 settlement and vesting

`OtcDealsV2` implements `IOtcDealsV2` alongside the legacy contract. The funding caller is the
seller and the terms designate a distinct buyer. Funding moves the full allocation into the deal
contract. Only the buyer can settle a funded deal before the expiry and any fixed start. Only the seller
can cancel while funded. Both terminal paths consume that deal status.

Settlement checks the exact debit and credit of payment and delivery transfers. For a raw quote `Q`,
each side’s fee is `floor(Q / 200)`. The buyer pays `Q + fee`, the seller receives `Q - fee`, and
the deployment’s immutable treasury receives `2 * fee`. A grant uses the source deal ID and is
recorded only after the vesting vault receives the full allocation. A failed operation rolls the whole
transaction back. The deal contract creates and controls a dedicated vault at deployment, keeping
open-deal escrow and vested grant reserves at separate addresses.

The vault records an immutable beneficiary and schedule, plus cumulative claimed units. Before the cliff,
vested is zero. At the cliff, elapsed accrual becomes vested. Between cliff and end, the computation is
`(A / duration) * elapsed + (A % duration) * elapsed / duration`. Elapsed and the remainder each fit in
64 bits. At the end, vested is exactly `A`. Anyone can trigger a claim to the recorded beneficiary.

## The rounds

| Round | Title | What it adds | How it is checked | Prize |
| --- | --- | --- | --- | --- |
| 1 | One deal, one link | The deal contract, and the smallest page that shows a deal from its link and fills it | The contract on a local chain with the checks' own tokens; the built page in a browser with a stand-in wallet | 1,000,000 points |
| 2 | Vesting OTC: funded grants and exact fees | Immediate or new-grant delivery through V2, with immutable buyer and treasury terms | Cumulative checks on a local EVM and end-to-end browser scenarios | 1,000,000 points |
| 3 | What a real deal needs (proposed) | Decided after the creator has shown round 2 to three people who do OTC deals | Decided after round 2 | To set |

Hotpod publishes each round after the previous round settles.

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
