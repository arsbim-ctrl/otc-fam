import { address, encode, same, say, uint, word, words, ZERO_ADDRESS } from "./eth.js";
import { isAddress } from "./units.js";
import { money } from "./v2.js";

export const BROKER_FIELDS = [
  ["seller", "address"], ["buyer", "address"], ["baseToken", "address"], ["quoteToken", "address"],
  ["allocation", "uint256"], ["quote", "uint256"], ["expiry", "uint64"], ["nonce", "uint256"],
  ["delivery", "uint8"], ["fixedStart", "uint64"], ["cliffSeconds", "uint64"], ["durationSeconds", "uint64"],
  ["broker", "address"], ["brokerBps", "uint16"],
].map(([name, type]) => ({ name, type }));

const DOMAIN_FIELDS = [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
];

// These selectors and topics are checked against the compiled contract in test/v3-abi.test.mjs.
export const V3_SELECT = {
  hashTerms: "0x34f4d2c2", getDeal: "0x51a6fad5", nonceUsed: "0x1647795e",
  fund: "0xcdbe064f", settle: "0x2eb42332", refund: "0x7249fbb6",
  getGrant: "0xb8cc6c93", claimable: "0xd1d58b25", claim: "0x379607f5",
  treasury: "0x61d027b3", FEE_BPS: "0xbf333f2c",
};
export const V3_TOPIC = {
  BrokerDealFunded: "0x6443a239b8c4af787b362a9af5f4d9ed48e90d4f215a4f00bdbf5fd2bccfa603",
  BrokerDealSettled: "0x03b817016100b7370d323dc856d4538d5782b8134ea2a859b4e89503e6adc72c",
  BrokerDealRefunded: "0xd7c7f553c7294348d6136ac53cde27eb143f355e50cd1acf79d158bdea774bc7",
  BrokerDealForBuyer: "0x960f17108f96d63455129ee0e9f6c80b5026aac8cbe2c2374853b36318848004",
  BrokerGrantClaimed: "0xf9fb8a486ac1f86d57a6cdbdf1d21d614822a2a1d5a4b7cd6184dc19d37d9001",
};

const STATUS = ["unfunded", "funded", "settled", "refunded"];
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const values = (terms) => BROKER_FIELDS.map(({ name }) => terms[name]);
const termWords = (w) => Object.fromEntries(BROKER_FIELDS.map(({ name, type }, i) =>
  [name, type === "address" ? address(w[i]) : uint(w[i])]));
const hexBlock = (block) => `0x${block.toString(16)}`;

export function brokerMoney(quote, share) {
  const price = money(quote);
  const brokerFee = price.feePool * share / 10_000n;
  return { ...price, brokerFee, treasuryFee: price.feePool - brokerFee };
}

export function normalizeTerms(input) {
  const terms = Object.fromEntries(BROKER_FIELDS.map(({ name, type }) => {
    const val = input[name];
    if (type === "address") {
      if (typeof val !== "string" || !isAddress(val) || same(val, ZERO_ADDRESS)) throw say(`Check the ${name} address.`);
      return [name, val.toLowerCase()];
    }
    const raw = String(val);
    const bits = BigInt(type.slice(4));
    if (!/^\d{1,78}$/.test(raw) || BigInt(raw) >= 1n << bits) throw say(`Check the ${name} value.`);
    return [name, BigInt(raw)];
  }));
  if (new Set([terms.seller, terms.buyer, terms.broker]).size !== 3) throw say("Use a different wallet address for the seller, buyer and broker.");
  if (terms.baseToken === terms.quoteToken) throw say("Choose two different token contracts.");
  if (!terms.allocation || !terms.quote) throw say("Enter two positive amounts.");
  if (brokerMoney(terms.quote, terms.brokerBps).buyerTotal > MAX_UINT256) throw say("The quote is too large to add fees.");
  if (terms.brokerBps > 10_000n) throw say("The broker share must be between 0% and 100% of the fee pool.");
  if (terms.delivery === 0n) {
    if (terms.fixedStart || terms.cliffSeconds || terms.durationSeconds) throw say("Immediate delivery has no schedule.");
  } else {
    if (terms.delivery !== 1n || terms.cliffSeconds >= terms.durationSeconds) {
      throw say("Choose a vesting duration longer than its cliff.");
    }
    if ((terms.fixedStart || terms.expiry) + terms.durationSeconds > MAX_UINT64) throw say("The vesting end is too far in the future.");
  }
  return terms;
}

export function linkPayload(domain, terms) {
  return btoa(JSON.stringify([domain.chainId, domain.verifyingContract, ...values(terms).map(String)]))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function readPayload(payload, domain) {
  let decoded;
  try {
    if (!/^[\da-z_-]{1,1600}$/i.test(payload)) throw Error();
    decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(decoded) || decoded.length !== BROKER_FIELDS.length + 2 || !decoded.slice(2).every((v) => typeof v === "string")) throw Error();
  } catch {
    throw say("This broker link is incomplete or invalid. Ask the broker for the full link.");
  }
  const [chainId, verifyingContract, ...fields] = decoded;
  if (chainId !== domain.chainId || !same(verifyingContract, domain.verifyingContract)) {
    throw say("This link names a different chain or broker contract. Open it on the site for that deployment.");
  }
  const terms = normalizeTerms(Object.fromEntries(BROKER_FIELDS.map(({ name }, i) => [name, fields[i]])));
  if ([terms.buyer, terms.broker, terms.seller].includes(domain.verifyingContract)) throw say("A party cannot use the escrow contract as its wallet.");
  return terms;
}

export function typedTerms(domain, terms) {
  return {
    types: { EIP712Domain: DOMAIN_FIELDS, BrokerTerms: BROKER_FIELDS },
    primaryType: "BrokerTerms",
    domain,
    message: Object.fromEntries(BROKER_FIELDS.map(({ name }) => [name, String(terms[name])])),
  };
}

function encodeSignature(selector, args, signature) {
  if (typeof signature !== "string" || !/^0x[\da-f]{130}$/i.test(signature)) {
    throw say("This workflow needs a standard 65-byte typed-data signature from your wallet.");
  }
  const head = encode(selector, ...args, (args.length + 1) * 32);
  return head + word(65) + signature.slice(2).padEnd(192, "0");
}

export const fundData = (terms, signature) => encodeSignature(V3_SELECT.fund, values(terms), signature);
export const settleData = (id, signature) => encodeSignature(V3_SELECT.settle, [id], signature);
export const refundData = (id) => encode(V3_SELECT.refund, id);
export const grantClaimData = (id) => encode(V3_SELECT.claim, id);

export function dealPhase(status, terms, time, used = false) {
  if (status === "settled" || status === "refunded") return status;
  const now = BigInt(time);
  if (now >= terms.expiry || (terms.fixedStart !== 0n &&
      (status === "funded" ? now > terms.fixedStart : now >= terms.fixedStart))) return "expired";
  return status === "unfunded" && used ? "nonce-used" : status;
}

export class DealsV3 {
  constructor(chain, chainId, contract, fromBlock) {
    this.chain = chain;
    this.contract = contract.toLowerCase();
    this.fromBlock = fromBlock;
    this.domain = { name: "OTC.fam Broker Deals", version: "3", chainId, verifyingContract: this.contract };
  }

  async read(data, count, block = "latest") {
    const raw = await this.chain.rpc("eth_call", [{ to: this.contract, data }, block]);
    const res = words(raw);
    if (res.length !== count || raw.length !== 2 + 64 * count) throw say("The configured broker contract could not be verified.");
    return res;
  }

  async setup() {
    const [chainId, [treasury], [fee]] = await Promise.all([
      this.chain.rpc("eth_chainId", []), this.read(V3_SELECT.treasury, 1), this.read(V3_SELECT.FEE_BPS, 1),
    ]);
    if (Number(chainId) !== this.domain.chainId || uint(fee) !== 50n || address(treasury) === ZERO_ADDRESS) {
      throw say("The read-only network or broker contract does not match this site's configuration.");
    }
    return address(treasury);
  }

  async id(terms) {
    // Hash unfunded terms locally. The public RPC only needs the digest to look up the deal.
    const { TypedDataEncoder } = await import("./vendor/ethers.min.js");
    return TypedDataEncoder.hash(this.domain, { BrokerTerms: BROKER_FIELDS }, terms);
  }

  async deal(id, block) {
    const w = await this.read(encode(V3_SELECT.getDeal, id), 16, block);
    return { terms: termWords(w), status: STATUS[Number(uint(w[14]))], grantId: uint(w[15]) };
  }

  async used(terms, block) {
    const [result] = await this.read(encode(V3_SELECT.nonceUsed, terms.seller, terms.nonce), 1, block);
    return uint(result) !== 0n;
  }

  async grant(id, block) {
    const [w, [available]] = await Promise.all([
      this.read(encode(V3_SELECT.getGrant, id), 8, block), this.read(encode(V3_SELECT.claimable, id), 1, block),
    ]);
    return {
      id, token: address(w[0]), beneficiary: address(w[1]), custodian: address(w[2]), allocation: uint(w[3]),
      start: uint(w[4]), cliff: uint(w[5]), end: uint(w[6]), claimed: uint(w[7]), claimable: uint(available),
    };
  }

  async logs(topics, latest) {
    const range = async (first, last) => {
      const filter = { address: this.contract, topics, fromBlock: hexBlock(first), toBlock: hexBlock(last) };
      try {
        return await this.chain.rpc("eth_getLogs", [filter]);
      } catch (error) {
        if (first === last || !(error.code === -32005 || /block range|range.*limit|too many results|query returned more/i.test(error.message))) throw error;
        const middle = first + Math.floor((last - first) / 2);
        return [...await range(first, middle), ...await range(middle + 1, last)];
      }
    };
    return latest < this.fromBlock ? [] : range(this.fromBlock, latest);
  }

  async receipts(id, latest) {
    const topics = [V3_TOPIC.BrokerDealFunded, V3_TOPIC.BrokerDealSettled, V3_TOPIC.BrokerDealRefunded];
    const logs = await this.logs([topics, id], latest);
    return logs.filter((log) => !log.removed).map((log) => {
      const kind = ["funded", "settled", "refunded"][topics.indexOf(log.topics[0])];
      const details = { kind, hash: log.transactionHash, block: Number(log.blockNumber), confirmations: latest - Number(log.blockNumber) + 1 };
      if (kind === "settled") {
        const [buyerFee, sellerFee, brokerFee, treasuryFee, grantId] = words(log.data).map(uint);
        return { ...details, buyerFee, sellerFee, brokerFee, treasuryFee, grantId };
      }
      return details;
    });
  }

  async roleDeals(role, account, latest) {
    const topic = `0x${word(account)}`;
    const filters = {
      broker: [V3_TOPIC.BrokerDealFunded, null, null, topic],
      seller: [V3_TOPIC.BrokerDealFunded, null, topic],
      buyer: [V3_TOPIC.BrokerDealForBuyer, null, topic],
    };
    const logs = await this.logs(filters[role], latest);
    return logs.filter((log) => !log.removed).map((log) => log.topics[1]).reverse();
  }
}

export const blockTag = hexBlock;
