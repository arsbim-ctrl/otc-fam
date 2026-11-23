// A fresh world for one v2 test: a new chain (the checks' EDR), OtcDealsV2 deployed with a treasury, a base token
// FAM (18 decimals) and a payment token USDC (6 decimals), and the people of a deal. Nobody holds or has approved
// anything: `fund` and `pay` give each side exactly what its step needs. Built with the checks' own helpers
// (.launchpad/checks/round-1), which these tests only use.
import assert from "node:assert/strict";
import { join } from "node:path";
import { Interface } from "ethers";
import { contractAt, deploy, Reverted, startChain } from "../../.launchpad/checks/round-1/chain.mjs";
import { compile, compileTokens } from "../../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../../.launchpad/checks/round-1/lib/entry.mjs";

export const PEOPLE = {
  deployer: "0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
  seller: "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
  buyer: "0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  other: "0x9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d",
  treasury: "0x7ea5007ea5007ea5007ea5007ea5007ea5007ea5",
};
export const ZERO = `0x${"00".repeat(20)}`;
export const DAY = 86_400;
export const STATUS = { None: 0n, Funded: 1n, Settled: 2n, Cancelled: 3n };
export const KIND = { Plain: 0, Fee: 1, FeeOnTop: 2, False: 3, Reset: 4, TransferFee: 5 }; // EdgeToken.Kind
export const ALLOCATION = 1_000_000n * 10n ** 18n; // a million FAM
export const QUOTE = 123_456_789n; // 123.456789 USDC
/** One side's fee on a quote, as the brief writes it. */
export const feeOn = (quote) => (quote * 50n) / 10_000n;

let compiled;
/** OtcDealsV2, GrantVault and the tokens the tests trade with, compiled once as the checks compile. */
export function artifacts() {
  compiled ??= {
    ...compile(ROOT, "contracts/OtcDealsV2.sol"),
    ...compile(ROOT, "contracts/GrantVault.sol"),
    ...compile(ROOT, "test/tokens/EdgeToken.sol"),
    ...compileTokens(), // the checks' PlainToken, NoReturnToken and ReentrantToken
    ...compile(join(ROOT, ".launchpad/checks"), "round-2/FixtureToken.sol"),
  };
  return compiled;
}

/** Every error the v2 contracts can revert with, by its data. */
export const errors = () => new Interface([...artifacts().OtcDealsV2.abi, ...artifacts().GrantVault.abi].filter((f) => f.type === "error"));

/** The name of the error `sending` reverts with; fails if it goes through. */
export async function revertsWith(sending) {
  try {
    await sending;
  } catch (e) {
    if (!(e instanceof Reverted)) throw e;
    const data = /return data: (0x[0-9a-f]+)/.exec(e.message)?.[1];
    return data ? errors().parseError(data)?.name ?? data : e.message;
  }
  assert.fail("the call went through: it must revert");
}

export async function world() {
  const a = artifacts();
  const chain = await startChain(Object.values(PEOPLE));
  const parties = { ...PEOPLE };
  const tokens = {};
  const deals = await deploy(chain, PEOPLE.deployer, a.OtcDealsV2, [PEOPLE.treasury], { label: "OtcDealsV2" });
  parties.deals = deals.address;
  const tokenAt = (address) => Object.values(tokens).find((t) => t.address.toLowerCase() === address.toLowerCase());

  const w = {
    chain, deals, tokens, parties, ...PEOPLE,
    /** Deploys a token: an EdgeToken of `kind`, or one of the checks' tokens when `kind` names its contract. */
    async token(symbol, decimals, kind = "Plain") {
      const t = kind in KIND ? await deploy(chain, PEOPLE.deployer, a.EdgeToken, [symbol, decimals, KIND[kind]], { label: symbol })
        : await deploy(chain, PEOPLE.deployer, a[kind], [symbol, decimals], { label: symbol });
      return (tokens[symbol] = Object.assign(t, { symbol, decimals }));
    },
    /** Watches what `address` holds, under `name`. */
    watch: (name, address) => (parties[name] = address),
    /** Immediate-delivery terms (a million FAM to the buyer for 123.456789 USDC, for a day), with `changes`. */
    async terms(changes = {}) {
      return { baseToken: w.fam.address, quoteToken: w.usdc.address, buyer: PEOPLE.buyer, allocation: ALLOCATION, quote: QUOTE,
        expiry: (await chain.now()) + DAY, delivery: 0, fixedStart: 0, cliffSeconds: 0, durationSeconds: 0, ...changes };
    },
    /** Vesting-delivery terms: the same deal, as a grant with a 30-day cliff over 90 days from its settlement. */
    vesting: (changes = {}) => w.terms({ delivery: 1, cliffSeconds: 30 * DAY, durationSeconds: 90 * DAY, ...changes }),
    /** The seller is given the allocation, approves it and creates the deal; returns the deal's id. */
    async fund(t, seller = PEOPLE.seller) {
      const base = tokenAt(t.baseToken);
      await base.as(PEOPLE.deployer).mint(seller, t.allocation);
      await base.as(seller).approve(deals.address, t.allocation);
      const [funded] = (await deals.as(seller).createDeal(t)).filter((e) => e.name === "DealFunded");
      return funded.args.dealId;
    },
    /** The buyer is given the quote and the buyer fee, and approves them. Nothing is sent to the deal contract. */
    async ready(t, buyer = t.buyer) {
      const quote = tokenAt(t.quoteToken), total = t.quote + feeOn(t.quote);
      await quote.as(PEOPLE.deployer).mint(buyer, total);
      await quote.as(buyer).approve(deals.address, 0);
      await quote.as(buyer).approve(deals.address, total);
    },
    /** `ready`, then the buyer fills deal `id`; returns the events. */
    async settle(id, t) {
      await w.ready(t);
      return deals.as(t.buyer).fill(id);
    },
    /** What every party holds of every token. */
    async holdings() {
      const held = {};
      for (const t of Object.values(tokens)) for (const [name, address] of Object.entries(parties)) held[`${name}.${t.symbol}`] = await t.read.balanceOf(address);
      return held;
    },
    /** What moved since `before`, a result of holdings(): only the balances that changed, each by how much. */
    async moved(before) {
      const now = await w.holdings();
      return Object.fromEntries(Object.entries(now).map(([key, value]) => [key, value - (before[key] ?? 0n)]).filter(([, delta]) => delta !== 0n));
    },
    /** The chain's latest block is at `time`: what views answer from now on. */
    async at(time) {
      await chain.setNextTime(Number(time));
      await chain.mine();
    },
    /** The next transaction happens at exactly `time`. */
    next: (time) => chain.setNextTime(Number(time)),
    /** The vault of grant `id`, as a contract. */
    async vault(id) {
      const { custodian } = await deals.read.getGrant(id);
      return contractAt(chain, a.GrantVault.abi, custodian, { label: "GrantVault" });
    },
  };
  w.fam = await w.token("FAM", 18);
  w.usdc = await w.token("USDC", 6);
  return w;
}
