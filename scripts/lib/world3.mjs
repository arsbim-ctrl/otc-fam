// The stand's world (world.mjs) with broker deals on it: the BrokerDeals contract (version 3) next to the other two,
// and a seller, a buyer, a broker and a stranger who can sign, because a broker deal is funded and settled with
// EIP-712 signatures. Their keys are written here for everyone to read: they are good for a local chain and for
// nothing else. The tests, the scenes (scripts/play3.mjs) and the local stand (scripts/dev.mjs) all stand on it.
import { TypedDataEncoder, Wallet } from "ethers";
import { CHAIN_ID, contractAt, deploy } from "../../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../../.launchpad/checks/round-1/lib/entry.mjs";
import { ALLOCATION, artifacts, DAY, feeOn, PEOPLE, QUOTE, world } from "./world.mjs";

export { ALLOCATION, DAY, feeOn, QUOTE, ZERO } from "./world.mjs";
export const STATUS3 = { Unfunded: 0n, Funded: 1n, Settled: 2n, Refunded: 3n };
/** The fields both parties sign, with the names, types and order of IBrokerDeals.BrokerTerms. */
export const TYPES = { BrokerTerms: [
  ["seller", "address"], ["buyer", "address"], ["baseToken", "address"], ["quoteToken", "address"], ["allocation", "uint256"], ["quote", "uint256"],
  ["expiry", "uint64"], ["nonce", "uint256"], ["delivery", "uint8"], ["fixedStart", "uint64"], ["cliffSeconds", "uint64"], ["durationSeconds", "uint64"],
  ["broker", "address"], ["brokerBps", "uint16"],
].map(([name, type]) => ({ name, type })) };

const key = (n) => `0x${n.toString(16).padStart(64, "0")}`;
/** Local test keys, public on purpose: never use them on a real network. */
export const SIGNERS = { seller: new Wallet(key(0x51)), buyer: new Wallet(key(0xb0)), broker: new Wallet(key(0xb7)), other: new Wallet(key(0x07)) };
/** The people of a broker deal, by address; the treasury only ever receives. */
export const WHO = { ...Object.fromEntries(Object.entries(SIGNERS).map(([name, signer]) => [name, signer.address.toLowerCase()])), treasury: PEOPLE.treasury };

/** The money of a settlement at `quote` with a broker share of `brokerBps`, as the brief writes it. */
export function feesOf(quote, brokerBps) {
  const fee = feeOn(quote), brokerFee = (2n * fee * BigInt(brokerBps)) / 10_000n;
  return { buyerFee: fee, sellerFee: fee, brokerFee, treasuryFee: 2n * fee - brokerFee, buyerTotal: quote + fee, sellerNet: quote - fee };
}

let compiled;
/** The stand's contracts and tokens, with BrokerDeals. */
export function artifacts3() {
  compiled ??= { ...artifacts(), ...compile(ROOT, "contracts/BrokerDeals.sol") };
  return compiled;
}

/**
 * What `signer`'s wallet answers to a request to sign typed data (eth_signTypedData_v4), or null for any other
 * request. `name` is one of SIGNERS.
 */
export async function signing(name, { method, params = [] }) {
  if (method !== "eth_signTypedData_v4") return null;
  if (String(params[0]).toLowerCase() !== WHO[name]) return { error: { code: 4100, message: `the wallet's account is ${WHO[name]}, not ${params[0]}` } };
  const { domain, types: { EIP712Domain: _, ...types }, message } = JSON.parse(params[1]);
  return { result: await SIGNERS[name].signTypedData(domain, types, message) };
}

/** A fresh world with broker deals. `w.seller`, `w.buyer`, `w.broker` and `w.other` are the people who can sign. */
export async function world3(options) {
  const w = await world(options), a = artifacts3(), { chain } = w;
  for (const name of Object.keys(SIGNERS)) await chain.fund(WHO[name]);
  const v3 = await deploy(chain, PEOPLE.deployer, a.BrokerDeals, [PEOPLE.treasury], { label: "BrokerDeals" });
  for (const [name, address] of Object.entries(WHO)) w.watch(name, address);
  w.watch("brokerDeals", v3.address);
  const domain = { name: "OTC.fam Broker Deals", version: "3", chainId: CHAIN_ID, verifyingContract: v3.address };
  const tokenAt = (address) => Object.values(w.tokens).find((t) => t.address.toLowerCase() === address.toLowerCase());
  let nonce = 0n;

  return Object.assign(w, {
    ...WHO, v3, domain,
    /** Immediate-delivery terms: a million FAM from the seller to the buyer for 123.456789 USDC, for a day, the broker taking 20% of the fees; with `changes`. */
    async terms3(changes = {}) {
      return { seller: WHO.seller, buyer: WHO.buyer, baseToken: w.fam.address, quoteToken: w.usdc.address, allocation: ALLOCATION, quote: QUOTE,
        expiry: (await chain.now()) + DAY, nonce: ++nonce, delivery: 0, fixedStart: 0, cliffSeconds: 0, durationSeconds: 0, broker: WHO.broker, brokerBps: 2_000, ...changes };
    },
    /** Vesting-delivery terms: the same deal, as a grant with a 30-day cliff over 90 days from its settlement. */
    vesting3: (changes = {}) => w.terms3({ delivery: 1, cliffSeconds: 30 * DAY, durationSeconds: 90 * DAY, ...changes }),
    /** The deal's id: the EIP-712 digest of `terms` under `scope` (this contract on this chain unless given). */
    idOf: (terms, scope = domain) => TypedDataEncoder.hash(scope, TYPES, terms),
    /** `name`'s signature of `terms` under `scope`. */
    sign: (name, terms, scope = domain) => SIGNERS[name].signTypedData(scope, TYPES, terms),
    /** The seller is given the allocation and approves it. Nothing is sent to the deal contract. */
    async stock(t) {
      const base = tokenAt(t.baseToken);
      await base.as(PEOPLE.deployer).mint(t.seller, t.allocation);
      await base.as(t.seller).approve(v3.address, t.allocation);
    },
    /** `stock`, then the seller signs the terms and funds the deal; returns the deal's id. */
    async fund3(t) {
      await w.stock(t);
      await v3.as(t.seller).fund(t, await w.sign("seller", t));
      return w.idOf(t);
    },
    /** The buyer is given the quote and the buyer fee, and approves them. Nothing is sent to the deal contract. */
    async ready3(t) {
      const quote = tokenAt(t.quoteToken), total = t.quote + feeOn(t.quote);
      await quote.as(PEOPLE.deployer).mint(t.buyer, total);
      await quote.as(t.buyer).approve(v3.address, 0);
      await quote.as(t.buyer).approve(v3.address, total);
    },
    /** `ready3`, then the buyer signs the terms and settles; returns the events. */
    async settle3(t) {
      await w.ready3(t);
      return v3.as(t.buyer).settle(w.idOf(t), await w.sign("buyer", t));
    },
    /** The vault of broker grant `id`, as a contract. */
    async vault3(id) {
      const { custodian } = await v3.read.getGrant(id);
      return contractAt(chain, a.GrantVault.abi, custodian, { label: "GrantVault" });
    },
  });
}
