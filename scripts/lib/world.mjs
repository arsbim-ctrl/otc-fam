// A fresh world on a chain inside this process (the checks' EDR): both deal contracts, OtcDealsV2 with a treasury,
// a base token FAM (18 decimals), a payment token USDC (6 decimals), and the people of a deal. Nobody holds or has
// approved anything: `fund` and `ready` give each side exactly what its step needs. The local stand (scripts/dev.mjs),
// the scenes (scripts/play.mjs) and the tests (test/, through test/lib/v2-world.mjs) all stand on it. Built with the
// checks' own helpers (.launchpad/checks/round-1), which it only uses.
import { Wallet, TypedDataEncoder } from "ethers";
import { CHAIN_ID, contractAt, deploy, startChain } from "../../.launchpad/checks/round-1/chain.mjs";
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
export const ALLOCATION = 1_000_000n * 10n ** 18n; // a million FAM
export const QUOTE = 123_456_789n; // 123.456789 USDC
/** One side's fee on a quote, as the brief writes it. */
export const feeOn = (quote) => (quote * 50n) / 10_000n;

let compiled, brokerArtifact;
/** Both deal contracts, the vault and the checks' tokens (PlainToken, NoReturnToken, ReentrantToken), compiled once as the checks compile. */
export function artifacts() {
  compiled ??= {
    ...compile(ROOT, "contracts/OtcDeals.sol"),
    ...compile(ROOT, "contracts/OtcDealsV2.sol"),
    ...compile(ROOT, "contracts/GrantVault.sol"),
    ...compileTokens(),
  };
  return compiled;
}

/** A plain token: what the stand and the scenes trade with. */
const plainToken = (chain, symbol, decimals) => deploy(chain, PEOPLE.deployer, artifacts().PlainToken, [symbol, decimals], { label: symbol });

/** `makeToken(chain, symbol, decimals, kind)` deploys the world's tokens: plain ones unless the caller knows other kinds (the tests do). */
export async function world({ makeToken = plainToken, withBroker = false } = {}) {
  const a = artifacts();
  const people = { ...PEOPLE };
  const signers = new Map();
  if (withBroker) {
    for (const role of ["broker", "seller", "buyer", "other"]) {
      const signer = Wallet.createRandom();
      people[role] = signer.address.toLowerCase();
      signers.set(people[role], signer);
    }
  }
  const chain = await startChain(Object.values(people));
  const parties = { ...people };
  const tokens = {};
  const deals = await deploy(chain, PEOPLE.deployer, a.OtcDealsV2, [PEOPLE.treasury], { label: "OtcDealsV2" });
  parties.deals = deals.address;
  const fromBlockV2 = Number(await chain.rpc("eth_blockNumber"));
  const tokenAt = (address) => Object.values(tokens).find((t) => t.address.toLowerCase() === address.toLowerCase());

  const w = {
    chain, deals, tokens, parties, fromBlockV2, ...people,
    /** Deploys a token of `kind` (as `makeToken` reads it), and watches who holds it. */
    async token(symbol, decimals, kind) {
      return (tokens[symbol] = Object.assign(await makeToken(chain, symbol, decimals, kind), { symbol, decimals }));
    },
    /** Watches what `address` holds, under `name`. */
    watch: (name, address) => (parties[name] = address),
    /** Immediate-delivery terms (a million FAM to the buyer for 123.456789 USDC, for a day), with `changes`. */
    async terms(changes = {}) {
      return { baseToken: w.fam.address, quoteToken: w.usdc.address, buyer: people.buyer, allocation: ALLOCATION, quote: QUOTE,
        expiry: (await chain.now()) + DAY, delivery: 0, fixedStart: 0, cliffSeconds: 0, durationSeconds: 0, ...changes };
    },
    /** Vesting-delivery terms: the same deal, as a grant with a 30-day cliff over 90 days from its settlement. */
    vesting: (changes = {}) => w.terms({ delivery: 1, cliffSeconds: 30 * DAY, durationSeconds: 90 * DAY, ...changes }),
    /** The seller is given the allocation, approves it and creates the deal; returns the deal's id. */
    async fund(t, seller = people.seller) {
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
  /** The round 1 contract, deployed next to v2 as on a real site (the page's config names both). */
  w.legacy = await deploy(chain, PEOPLE.deployer, a.OtcDeals, [], { label: "OtcDeals" });
  if (withBroker) {
    brokerArtifact ??= compile(ROOT, "contracts/BrokerDeals.sol").BrokerDeals;
    w.brokerDeals = await deploy(chain, w.deployer, brokerArtifact, [w.treasury], { label: "BrokerDeals" });
    w.watch("escrow", w.brokerDeals.address);
    const fromBlockBroker = Number(await chain.rpc("eth_blockNumber"));
    w.brokerConfig = { contractBroker: w.brokerDeals.address, fromBlockBroker, treasuryBroker: w.treasury };
    const fields = brokerArtifact.abi.find((entry) => entry.name === "fund").inputs[0].components;
    const types = { BrokerTerms: fields.map(({ name, type }) => ({ name, type })) };
    const domain = { name: "OTC.fam Broker Deals", version: "3", chainId: CHAIN_ID, verifyingContract: w.brokerDeals.address };
    w.brokerId = (terms) => TypedDataEncoder.hash(domain, types, terms);
    w.brokerSign = (person, terms, scope = domain) => signers.get(person.toLowerCase()).signTypedData(scope, types, terms);
    w.brokerDomain = domain;
    w.brokerTerms = async (nonce, changes = {}) => ({ ...await w.terms(), seller: w.seller, broker: w.broker, brokerBps: 2000, nonce, ...changes });
    w.signAs = async (account, { params = [] }) => {
      const refuse = (code, message) => ({ error: { code, message } });
      try {
        const [actor, raw] = params, { domain: scope, message, primaryType, types: requested } = JSON.parse(raw);
        if (String(actor).toLowerCase() !== account || !signers.has(account)) return refuse(4100, "Switch to the named local wallet.");
        if (primaryType !== "BrokerTerms" || JSON.stringify(requested.BrokerTerms) !== JSON.stringify(types.BrokerTerms)
            || Number(scope.chainId) !== CHAIN_ID || scope.verifyingContract.toLowerCase() !== domain.verifyingContract.toLowerCase()
            || scope.name !== domain.name || scope.version !== domain.version) return refuse(4200, "This demo wallet only signs local BrokerDeals terms.");
        return { result: await w.brokerSign(account, message) };
      } catch { return refuse(-32602, "The local broker signing request was invalid."); }
    };
  }
  return w;
}
