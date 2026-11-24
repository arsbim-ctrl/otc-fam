import { Interface, TypedDataEncoder } from "ethers";
import { isAddress } from "./units.js";

const fields = [
  ["seller", "address"], ["buyer", "address"], ["baseToken", "address"], ["quoteToken", "address"],
  ["allocation", "uint256"], ["quote", "uint256"], ["expiry", "uint64"], ["nonce", "uint256"],
  ["delivery", "uint8"], ["fixedStart", "uint64"], ["cliffSeconds", "uint64"], ["durationSeconds", "uint64"],
  ["broker", "address"], ["brokerBps", "uint16"],
];
export const types = { BrokerTerms: fields.map(([name, type]) => ({ name, type })) };
const tuple = `(${fields.map(([name, type]) => `${type} ${name}`).join(",")})`;
export const abi = new Interface([
  `function fund(${tuple} terms, bytes sellerSignature)`,
  "function settle(bytes32 dealId, bytes buyerSignature)",
  "function refund(bytes32 dealId)",
  `function getDeal(bytes32 dealId) view returns (${tuple} terms, uint8 status, uint256 grantId)`,
  "function getGrant(uint256 grantId) view returns ((address token,address beneficiary,address custodian,uint256 allocation,uint64 start,uint64 cliff,uint64 end,uint256 claimed))",
  "function claim(uint256 grantId)",
  "event BrokerDealFunded(bytes32 indexed dealId,address indexed seller,address indexed broker)",
  "event BrokerDealSettled(bytes32 indexed dealId,address indexed buyer,uint256 buyerFee,uint256 sellerFee,uint256 brokerFee,uint256 treasuryFee,uint256 grantId)",
  "event BrokerDealRefunded(bytes32 indexed dealId)",
  "error InvalidTerms(string field)", "error WrongActor(address expected)", "error InvalidSignature(address expected)",
  "error NonceUsed(uint256 nonce)", "error WrongStatus(uint8 status)", "error DeliveryWindowClosed()",
]);
export const domainFor = (chainId, verifyingContract) => ({ name: "OTC.fam Broker Deals", version: "3", chainId, verifyingContract });
export const digest = (domain, terms) => TypedDataEncoder.hash(domain, types, terms);
export const signingPayload = (domain, terms) => TypedDataEncoder.getPayload(domain, types, terms);
export const isId = (text) => /^0x[0-9a-f]{64}$/.test(text);
const nonzero = (value) => typeof value === "string" && isAddress(value) && !/^0x0{40}$/.test(value);
const max64 = 2n ** 64n - 1n;
const max256 = 2n ** 256n - 1n;

export function fees(quote, brokerBps) {
  const buyerFee = quote * 50n / 10_000n, sellerFee = quote * 50n / 10_000n;
  const pool = buyerFee + sellerFee;
  const brokerFee = pool * brokerBps / 10_000n;
  return { buyerFee, sellerFee, pool, brokerFee, treasuryFee: pool - brokerFee, total: quote + buyerFee, net: quote - sellerFee };
}

export function unsigned(value, bits, field) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= 2n ** BigInt(bits)) {
    throw new Error(`${field} must be a whole number from 0 to ${2n ** BigInt(bits) - 1n}. Check the exact value and try again.`);
  }
  return BigInt(value);
}

export function normalize(values) {
  return Object.fromEntries(fields.map(([key, type], i) => {
    const value = values[i];
    if (type === "address") {
      if (!nonzero(value)) throw new Error(`${key} (${String(value).slice(0, 48)}) needs a nonzero token or wallet address.`);
      return [key, value.toLowerCase()];
    }
    return [key, unsigned(value, Number(type.slice(4)), key)];
  }));
}

const valueList = (terms) => fields.map(([key]) => String(terms[key]));

export function validateTerms(terms, contract) {
  const { seller, buyer, broker, baseToken, quoteToken, allocation, quote, expiry, delivery, fixedStart, cliffSeconds, durationSeconds, brokerBps } = terms;
  if (new Set([seller, buyer, broker, contract.toLowerCase()]).size !== 4) throw new Error("Seller, buyer and broker must be different wallets and cannot be the deal contract.");
  if (baseToken === quoteToken) throw new Error(`Quote token (${quoteToken}) must differ from the allocation token.`);
  if (allocation === 0n) throw new Error("Allocation (0) must be greater than zero.");
  if (quote === 0n || quote + quote / 200n > max256) throw new Error(`Quote (${quote} raw units) must be positive and leave room for the buyer fee.`);
  if (expiry === 0n) throw new Error("Deadline (0) needs a future chain timestamp.");
  if (brokerBps > 10_000n) throw new Error(`Broker share (${brokerBps} bps) must be between 0 and 10,000.`);
  if (delivery > 1n) throw new Error(`Delivery (${delivery}) must be immediate or a new vesting grant.`);
  if (delivery === 0n && (fixedStart || cliffSeconds || durationSeconds)) throw new Error("Immediate delivery requires a zero vesting schedule.");
  if (delivery === 1n && cliffSeconds >= durationSeconds) throw new Error(`Cliff (${cliffSeconds} seconds) must be shorter than duration (${durationSeconds} seconds).`);
  if (delivery === 1n && (fixedStart || expiry) + durationSeconds > max64) throw new Error("The vesting end exceeds the chain's timestamp range. Shorten the schedule.");
}

export function termsDecoded(data) {
  return normalize(Array.from(data, String));
}

export function pack(domain, terms) {
  return btoa(JSON.stringify([domain.chainId, domain.verifyingContract.toLowerCase(), ...valueList(terms)]))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unpack(encoded) {
  const bad = () => new Error("The terms link is incomplete or damaged. Ask the broker for the full link.");
  if (!/^[a-zA-Z0-9_-]{1,1600}$/.test(encoded)) throw bad();
  let data;
  try { data = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))); } catch { throw bad(); }
  if (!Array.isArray(data) || data.length !== fields.length + 2 || !Number.isSafeInteger(data[0]) || data[0] < 1 || !nonzero(data[1])) throw bad();
  const domain = domainFor(data[0], data[1].toLowerCase()), terms = normalize(data.slice(2));
  validateTerms(terms, domain.verifyingContract);
  return { domain, terms };
}

export function dealHash(domain, terms) {
  return `#/v3/d/${digest(domain, terms)}/${pack(domain, terms)}`;
}

export function expiration(terms, time) {
  if (BigInt(time) >= terms.expiry) return "The settlement deadline has passed.";
  if (terms.fixedStart && BigInt(time) > terms.fixedStart) return "The fixed vesting start has passed.";
  return "";
}

export function claimable(grant, time) {
  time = BigInt(time);
  const vested = time < grant.cliff ? 0n : time >= grant.end ? grant.allocation
    : grant.allocation * (time - grant.start) / (grant.end - grant.start);
  return vested - grant.claimed;
}

export function roleNames(terms, account) {
  return ["broker", "seller", "buyer"].filter((role) => terms[role] === account.toLowerCase());
}
