// The broker deals contract (contracts/BrokerDeals.sol, version 3), as the page uses it: the terms of a deal and the
// link that carries them, the EIP-712 message both parties sign, the transactions the page sends, what it reads of
// a deal and its grant, the events it shows as receipts and history, and the fee arithmetic, written as the
// contract writes it (whole numbers only, rounded down) so that the page shows before a press what the chain will do.
import { address, encode, same, say, uint, word, words } from "./eth.js";

// keccak256 of each signature (test/v3-abi.test.mjs checks them against the compiled contract).
const TERMS = "(address,address,address,address,uint256,uint256,uint64,uint256,uint8,uint64,uint64,uint64,address,uint16)";
const SELECTOR = {
  getDeal: "0x51a6fad5", // getDeal(bytes32)
  getGrant: "0xb8cc6c93", // getGrant(uint256)
  vested: "0x968fb8ba", // vested(uint256)
  claimable: "0xd1d58b25", // claimable(uint256)
  treasury: "0x61d027b3", // treasury()
  feeBps: "0xbf333f2c", // FEE_BPS()
  dealIdOf: "0x54ea58e5", // dealIdOf(TERMS)
  nonceUsed: "0x1647795e", // nonceUsed(address,uint256)
  fund: "0xcdbe064f", // fund(TERMS,bytes)
  settle: "0x2eb42332", // settle(bytes32,bytes)
  refund: "0x7249fbb6", // refund(bytes32)
  claim: "0x379607f5", // claim(uint256)
};
const TOPIC = {
  funded: "0x6443a239b8c4af787b362a9af5f4d9ed48e90d4f215a4f00bdbf5fd2bccfa603", // BrokerDealFunded(bytes32,address,address)
  offered: "0x757a3aa40ef7150669aed69c5d490e7db039f0d7fa92109dde5b10cc3614b6c5", // BrokerDealOffered(bytes32,address)
  settled: "0x03b817016100b7370d323dc856d4538d5782b8134ea2a859b4e89503e6adc72c", // BrokerDealSettled(bytes32,address,uint256,uint256,uint256,uint256,uint256)
  refunded: "0xd7c7f553c7294348d6136ac53cde27eb143f355e50cd1acf79d158bdea774bc7", // BrokerDealRefunded(bytes32)
  claimed: "0x617847aec64ffd2e4a19d71c3e0062f744212a6f13486fec81d004b3a5c8fb2e", // GrantClaimed(uint256,address,uint256)
};
export const SIGNATURES = { TERMS, SELECTOR, TOPIC };
const STATUS = ["unfunded", "funded", "settled", "refunded"];

/** The fields of the terms, in the contract's order: name, type, and how many bytes each takes in a link. */
export const FIELDS = [
  ["seller", "address", 20], ["buyer", "address", 20], ["baseToken", "address", 20], ["quoteToken", "address", 20], ["allocation", "uint256", 32], ["quote", "uint256", 32],
  ["expiry", "uint64", 8], ["nonce", "uint256", 32], ["delivery", "uint8", 1], ["fixedStart", "uint64", 8], ["cliffSeconds", "uint64", 8], ["durationSeconds", "uint64", 8],
  ["broker", "address", 20], ["brokerBps", "uint16", 2],
];
const PACKED = FIELDS.reduce((sum, [, , size]) => sum + size, 0); // 231 bytes: 308 letters of base64, with no padding
/** The EIP-712 domain every signature of a broker deal is bound to, besides the chain and the contract. */
export const DOMAIN = { name: "OTC.fam Broker Deals", version: "3" };
export const IMMEDIATE = 0n, VESTING = 1n;

/** Each side's fee, in hundredths of a percent of the price: 0.5%. The page refuses to work with a contract that says otherwise. */
export const FEE_BPS = 50n;
export const BPS = 10_000n;

/**
 * The money of a settlement at price `quote` with a broker share of `brokerBps`, in the payment token's smallest
 * unit. Each fee is rounded down on its own; the broker's share of both is rounded down, and the treasury has the rest.
 */
export function money(quote, brokerBps) {
  const fee = (quote * FEE_BPS) / BPS, feePool = 2n * fee, brokerFee = (feePool * BigInt(brokerBps)) / BPS;
  // A share above all of the fees is refused by the contract; the page then says so, and shows no negative amount.
  return { quote, buyerFee: fee, sellerFee: fee, buyerTotal: quote + fee, sellerNet: quote - fee, feePool, brokerFee, treasuryFee: brokerFee > feePool ? 0n : feePool - brokerFee };
}

/** "20%" or "12.5%" for a share in hundredths of a percent. */
export const percent = (bps) => `${(Number(bps) / 100).toString()}%`;

/** The terms as the link carries them: every field at its fixed place, as base64 for a URL. Terms are addresses in lower case and BigInts. */
export function packTerms(t) {
  const hex = FIELDS.map(([name, , size]) => BigInt(t[name]).toString(16).padStart(size * 2, "0")).join("");
  const bytes = hex.match(/../g).map((byte) => String.fromCharCode(parseInt(byte, 16))).join("");
  return btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The terms a link carries, or null when `text` is not such a link's end. */
export function unpackTerms(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text ?? "")) return null;
  let bytes;
  try {
    bytes = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (bytes.length !== PACKED) return null;
  const hex = [...bytes].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const t = {};
  let at = 0;
  for (const [name, type, size] of FIELDS) {
    const part = hex.slice(at, (at += size * 2));
    t[name] = type === "address" ? `0x${part}` : BigInt(`0x${part}`);
  }
  return packTerms(t) === text ? t : null; // one deal, one spelling of its link
}

/**
 * Why terms could never be funded, as the contract's own rules have it, or null. The page says it before a wallet
 * is asked for anything. Times are not judged here: whether a deal has expired depends on when it is looked at.
 */
export function flawOf(t, contract) {
  const zero = (a) => /^0x0{40}$/.test(a);
  if (t.allocation === 0n || t.quote === 0n) return "Both amounts must be more than zero.";
  if (t.quote + (t.quote * FEE_BPS) / BPS >= 2n ** 256n) return "That price is too large for the fee to be added to it.";
  if (same(t.baseToken, t.quoteToken)) return "The token sold and the payment token are the same.";
  if (zero(t.buyer)) return "The terms name no buyer.";
  if (same(t.buyer, t.seller)) return "The buyer and the seller are the same address.";
  if (zero(t.broker) || same(t.broker, t.seller) || same(t.broker, t.buyer) || same(t.broker, contract)) return "The broker must be an address of its own: not the seller's, not the buyer's and not the deal contract's.";
  if (t.brokerBps > BPS) return "The broker's share is more than all of the fees.";
  if (t.delivery === IMMEDIATE) {
    if (t.fixedStart || t.cliffSeconds || t.durationSeconds) return "Immediate delivery takes no vesting schedule.";
  } else if (t.delivery === VESTING) {
    if (t.cliffSeconds >= t.durationSeconds) return "The vesting must last more than zero seconds, and its cliff must be shorter than the whole vesting.";
    if ((t.fixedStart || t.expiry) + t.durationSeconds >= 2n ** 64n) return "That vesting schedule ends too far in the future to be written on the chain.";
  } else return "This kind of delivery is not supported.";
  return null;
}

/** What `eth_signTypedData_v4` is asked to sign: the terms, field by field, for the contract at `contract` on chain `chainId`. */
export function typedData(chainId, contract, t) {
  return {
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      BrokerTerms: FIELDS.map(([name, type]) => ({ name, type })),
    },
    primaryType: "BrokerTerms",
    domain: { ...DOMAIN, chainId, verifyingContract: contract },
    message: Object.fromEntries(FIELDS.map(([name, type]) => [name, type === "address" ? t[name] : t[name].toString()])),
  };
}

/**
 * Asks the app's wallet for its account's signature of `t`, on the site's chain. Signing sends nothing: the wallet
 * shows the terms and the person agrees to them or not.
 */
export async function signTerms({ wallet, config, v3 }, t) {
  await wallet.readChain();
  if (wallet.chainId !== config.chainId) throw say("Your wallet changed network. Switch it back, then try again.");
  const signature = await wallet.provider.request({ method: "eth_signTypedData_v4", params: [wallet.account, JSON.stringify(typedData(config.chainId, v3.contract, t))] });
  if (!/^0x[0-9a-f]{130}$/i.test(signature ?? "")) {
    throw say("Your wallet did not answer with a signature the deal contract can read (65 bytes, from a key). A contract wallet cannot sign a broker deal.");
  }
  return signature;
}

const termsWords = (t) => FIELDS.map(([name]) => word(t[name])).join("");
/** A `bytes` argument's tail: its length, then its bytes padded to whole words. */
const bytesTail = (hex) => word(hex.length / 2 - 1) + hex.slice(2).padEnd(Math.ceil((hex.length - 2) / 64) * 64, "0");
export const fundData = (t, signature) => SELECTOR.fund + termsWords(t) + word((FIELDS.length + 1) * 32) + bytesTail(signature);
export const settleData = (id, signature) => SELECTOR.settle + id.slice(2) + word(64) + bytesTail(signature);
export const refundData = (id) => SELECTOR.refund + id.slice(2);
export const claimData = (grantId) => encode(SELECTOR.claim, grantId);

/**
 * A deal's state as the page says it, from its terms, its status on the chain and the time: "awaiting" (funding),
 * "funded", "settled", "refunded", or "expired": a deal that can no longer be funded, or no longer be settled.
 */
export function stateOf(t, status, now) {
  if (status === "settled" || status === "refunded") return status;
  // A grant never starts before it is funded: once a fixed vesting start has passed, the deal can go no further.
  // It can still be settled in the very second of that start, but no longer funded then.
  const startPassed = t.delivery === VESTING && t.fixedStart > 0n && (status === "funded" ? now > Number(t.fixedStart) : now >= Number(t.fixedStart));
  if (now >= Number(t.expiry) || startPassed) return "expired";
  return status === "funded" ? "funded" : "awaiting";
}

/** Until when a deal can be settled, in unix seconds: its expiry, or its fixed vesting start if that comes first. */
export const settleBy = (t) => Number(t.delivery === VESTING && t.fixedStart > 0n && t.fixedStart < t.expiry ? t.fixedStart : t.expiry);

/** Reads the broker deals contract at `contract` through `chain`. `fromBlock` is where its events start (its deployment). */
export class DealsV3 {
  constructor(chain, contract, fromBlock = 0) {
    this.chain = chain;
    this.contract = contract.toLowerCase();
    this.fromBlock = fromBlock;
    this.blockTimes = new Map();
  }

  /** The `count` words the contract answers to `data`; fails, in words, when what is at its address is not a broker deals contract. */
  async ask(data, count) {
    const absent = say(`There is no broker deals contract (v3) at ${this.contract} on this network: the site's config.json may be wrong.`);
    const answer = words(await this.chain.call(this.contract, data).catch((e) => {
      throw e?.plain ? e : absent; // the network's own failure is said as it is; a refusal means another contract
    }));
    if (answer.length !== count) throw absent;
    return answer;
  }

  /** The treasury, once the contract has answered that it is a broker deals contract with a 0.5% fee. */
  setup() {
    this.ready ??= Promise.all([this.ask(SELECTOR.treasury, 1), this.ask(SELECTOR.feeBps, 1)]).then(([[treasury], [fee]]) => {
      if (uint(fee) !== FEE_BPS) throw say("The deal contract's fee is not the 0.5% this page shows: the site must be updated before it can be used.");
      return { treasury: address(treasury) };
    });
    this.ready.catch(() => (this.ready = null)); // a failed look-up is tried again next time
    return this.ready;
  }

  /** The id of the deal of `t`, as the contract itself computes it: the digest both parties sign. */
  async idOf(t) {
    return `0x${(await this.ask(SELECTOR.dealIdOf + termsWords(t), 1))[0]}`;
  }

  /** Deal `id` as the chain has it: `status` is "unfunded" for a deal that was never funded, and its terms are then unknown to the chain. */
  async deal(id) {
    const w = await this.ask(SELECTOR.getDeal + id.slice(2), FIELDS.length + 2);
    const status = STATUS[Number(uint(w[FIELDS.length]))];
    const terms = status === "unfunded" ? null : Object.fromEntries(FIELDS.map(([name, type], i) => [name, type === "address" ? address(w[i]) : uint(w[i])]));
    return { id, status, terms, grantId: uint(w[FIELDS.length + 1]) };
  }

  /** Whether `seller` has already funded a deal with `nonce`: a seller uses a nonce once. */
  async nonceUsed(seller, nonce) {
    return uint((await this.ask(encode(SELECTOR.nonceUsed, seller, nonce), 1))[0]) === 1n;
  }

  /** Grant `id`, with what the contract says has vested and can be claimed at the latest block, and what its vault holds. */
  async grant(id) {
    const call = (selector) => this.chain.call(this.contract, encode(selector, id));
    const [grant, vested, claimable] = (await Promise.all([call(SELECTOR.getGrant), call(SELECTOR.vested), call(SELECTOR.claimable)])).map(words);
    const g = {
      id, token: address(grant[0]), beneficiary: address(grant[1]), custodian: address(grant[2]), allocation: uint(grant[3]),
      start: uint(grant[4]), cliff: uint(grant[5]), end: uint(grant[6]), claimed: uint(grant[7]), vested: uint(vested[0]), claimable: uint(claimable[0]),
    };
    return { ...g, held: await this.chain.balanceOf(g.token, g.custodian) };
  }

  logs(topics) {
    return this.chain.rpc("eth_getLogs", [{ address: this.contract, topics, fromBlock: `0x${this.fromBlock.toString(16)}`, toBlock: "latest" }]);
  }

  /** What the contract emitted about deal `id` and its grant (`grantId`, 0n for none), oldest first: its receipts. */
  async history(id, grantId) {
    const [deal, claims] = await Promise.all([
      this.logs([[TOPIC.funded, TOPIC.settled, TOPIC.refunded], id]),
      grantId ? this.logs([TOPIC.claimed, `0x${word(grantId)}`]) : [],
    ]);
    const kinds = Object.fromEntries(Object.entries(TOPIC).map(([kind, topic]) => [topic, kind]));
    const place = (log) => Number(log.blockNumber) * 1e6 + Number(log.logIndex ?? 0);
    return Promise.all([...deal, ...claims].sort((a, b) => place(a) - place(b)).map(async (log) => {
      const kind = kinds[log.topics[0]], data = words(log.data);
      const entry = { kind, hash: log.transactionHash, block: Number(log.blockNumber), time: await this.blockTime(log.blockNumber) };
      if (kind === "settled") Object.assign(entry, { buyerFee: uint(data[0]), sellerFee: uint(data[1]), brokerFee: uint(data[2]), treasuryFee: uint(data[3]), grantId: uint(data[4]) });
      if (kind === "claimed") Object.assign(entry, { amount: uint(data[0]) });
      return entry;
    }));
  }

  /**
   * The ids of the deals the chain has for `who` as seller, as broker or as buyer, newest first: the deals that
   * were funded, found by the events that name each of the three. A deal that was never funded is not on the chain.
   */
  async dealsOf(who) {
    const topic = `0x${word(who)}`;
    const found = await Promise.all([this.logs([TOPIC.funded, null, topic]), this.logs([TOPIC.funded, null, null, topic]), this.logs([TOPIC.offered, null, topic])]);
    const ids = new Map();
    for (const log of found.flat()) ids.set(log.topics[1], Math.max(ids.get(log.topics[1]) ?? 0, Number(log.blockNumber)));
    return [...ids].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  /** The settlement or the refund of each of the deals `ids` that has one: a Map from the deal's id to `{ kind, hash, block }`. */
  async receiptsOf(ids) {
    if (!ids.length) return new Map();
    const logs = await this.logs([[TOPIC.settled, TOPIC.refunded], ids]);
    return new Map(logs.map((log) => [log.topics[1], { kind: log.topics[0] === TOPIC.settled ? "settled" : "refunded", hash: log.transactionHash, block: Number(log.blockNumber) }]));
  }

  /** The time of block `number` (as the node writes it, in hex), in unix seconds. */
  blockTime(number) {
    if (!this.blockTimes.has(number)) {
      const time = this.chain.rpc("eth_getBlockByNumber", [number, false]).then((block) => Number(block.timestamp));
      time.catch(() => this.blockTimes.delete(number));
      this.blockTimes.set(number, time);
    }
    return this.blockTimes.get(number);
  }
}

/** The link of the deal whose terms are packed in `payload` (or whose id it is), on the site's chain and contract. */
export const linkOf = ({ config, v3 }, payload) => `#/v3/d/${config.chainId}/${v3.contract}/${payload}`;

// The deals this browser knows: the links prepared here by a broker, and the deals opened here. It is this
// browser's own list, kept in its storage; the chain says what became of each.
const bookKey = ({ config, v3 }) => `otcfam:v3:deals:${config.chainId}:${v3.contract}`;
/** This browser's deals on the site's chain and contract, newest first: `{ id, terms, payload, at, how }`, `how` being "prepared" or "opened". */
export function book(app) {
  try {
    const list = JSON.parse(localStorage.getItem(bookKey(app)));
    if (!Array.isArray(list)) return [];
    return list.map((entry) => ({ ...entry, terms: unpackTerms(entry?.payload) }))
      .filter((e) => e.terms && /^0x[0-9a-f]{64}$/.test(e.id) && Number.isFinite(e.at) && (e.how === "prepared" || e.how === "opened"));
  } catch {
    return []; // no storage, or not ours: nothing is known here
  }
}
/** Notes the deal `id` of `terms` in this browser's list. A link prepared here stays "prepared" when it is opened later. */
export function remember(app, id, terms, how) {
  const known = book(app), old = known.find((e) => e.id === id);
  if (old && (old.how === "prepared" || how === "opened")) return;
  const list = [{ id, payload: packTerms(terms), at: Math.floor(Date.now() / 1000), how }, ...known.filter((e) => e.id !== id).map(({ id: i, payload, at, how: h }) => ({ id: i, payload, at, how: h }))];
  try {
    localStorage.setItem(bookKey(app), JSON.stringify(list.slice(0, 300)));
  } catch {} // no storage: the link itself still carries the deal
}
