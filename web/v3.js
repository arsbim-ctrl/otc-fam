import { AbiCoder, Interface, TypedDataEncoder, getAddress, getBytes, hexlify, toQuantity } from "ethers";
import { encode, same, say } from "./eth.js";
import { money } from "./v2.js";

const fields = [
  ["seller", "address"], ["buyer", "address"], ["baseToken", "address"], ["quoteToken", "address"],
  ["allocation", "uint256"], ["quote", "uint256"], ["expiry", "uint64"], ["nonce", "uint256"],
  ["delivery", "uint8"], ["fixedStart", "uint64"], ["cliffSeconds", "uint64"], ["durationSeconds", "uint64"],
  ["broker", "address"], ["brokerBps", "uint16"],
];
const types = { BrokerTerms: fields.map(([name, type]) => ({ name, type })) };
const tuple = `(${fields.map(([name, type]) => `${type} ${name}`).join(",")})`;
const linkTypes = ["uint256", "address", tuple];
const linkLength = Math.ceil((fields.length + 2) * 32 * 4 / 3);
const codec = AbiCoder.defaultAbiCoder();
const zero = "0x" + "0".repeat(40);
const max64 = 2n ** 64n - 1n;
const max256 = 2n ** 256n - 1n;

export const abi = new Interface([
  `function hashTerms(${tuple} terms) view returns (bytes32)`,
  `function fund(${tuple} terms, bytes sellerSignature)`,
  "function settle(bytes32 dealId, bytes buyerSignature)",
  "function refund(bytes32 dealId)",
  "function claim(uint256 grantId)",
  `function getDeal(bytes32 dealId) view returns (${tuple} terms, uint8 status, uint256 grantId)`,
  "function getGrant(uint256 grantId) view returns ((address token,address beneficiary,address custodian,uint256 allocation,uint64 start,uint64 cliff,uint64 end,uint256 claimed))",
  "function claimable(uint256 grantId) view returns (uint256)",
  "function nonces(address seller, uint256 nonce) view returns (bool)",
  "function treasury() view returns (address)",
  "event BrokerDealFunded(bytes32 indexed dealId, address indexed seller, address indexed broker)",
  "event BrokerDealBuyer(bytes32 indexed dealId, address indexed buyer)",
  "event BrokerDealSettled(bytes32 indexed dealId, address indexed buyer, uint256 buyerFee, uint256 sellerFee, uint256 brokerFee, uint256 treasuryFee, uint256 grantId)",
  "event BrokerDealRefunded(bytes32 indexed dealId)",
  "event BrokerGrantClaimed(uint256 indexed grantId, address indexed beneficiary, uint256 amount)",
  ...[
    "BadParties()", "BadBroker()", "BadTokens()", "BadAmounts()", "BadSchedule()", "DealExpired()",
    "StartPassed()", "NonceUsed()", "NotFunded()", "NotSeller()", "NotBuyer()", "InvalidAuthorization()",
  ].map(error => `error ${error}`),
]);

export const domainOf = (chainId, verifyingContract) => ({ name: "OTC.fam Broker Deals", version: "3", chainId, verifyingContract });
export const dealIdOf = (domain, terms) => TypedDataEncoder.hash(domain, types, terms);
const plainTerms = (tupleValue) => Object.fromEntries(fields.map(([name]) => [name, tupleValue[name]]));

export function pack(domain, terms) {
  const bytes = getBytes(codec.encode(linkTypes, [domain.chainId, domain.verifyingContract, terms]));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unpack(key) {
  try {
    if (key.length !== linkLength || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error();
    const bytes = Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    const [chainId, contract, values] = codec.decode(linkTypes, hexlify(bytes));
    const domain = domainOf(chainId, contract);
    const terms = plainTerms(values);
    validateTerms(terms, contract);
    if (chainId === 0n || contract === zero || pack(domain, terms) !== key) throw new Error();
    return { domain, terms, id: dealIdOf(domain, terms) };
  } catch {
    throw say("This broker deal link is incomplete or malformed. Ask the broker for the full link.");
  }
}

export function payment(terms, recorded) {
  const fees = money(terms.quote);
  const brokerFee = fees.feePool * terms.brokerBps / 10_000n;
  if (!recorded) return { ...fees, brokerFee, treasuryFee: fees.feePool - brokerFee };
  return {
    quote: terms.quote, buyerFee: recorded.buyerFee, sellerFee: recorded.sellerFee,
    buyerTotal: terms.quote + recorded.buyerFee, sellerNet: terms.quote - recorded.sellerFee,
    feePool: recorded.buyerFee + recorded.sellerFee, brokerFee: recorded.brokerFee, treasuryFee: recorded.treasuryFee,
  };
}

export function validateTerms(t, contract, now) {
  if (new Set([t.seller, t.buyer, t.broker].map(a => a.toLowerCase())).size !== 3
      || [t.seller, t.buyer, t.broker].some(a => same(a, zero) || same(a, contract))) {
    throw say("Use three different wallet addresses for seller, buyer and broker.");
  }
  if (same(t.baseToken, t.quoteToken) || [t.baseToken, t.quoteToken].some(a => same(a, zero))) {
    throw say("Enter two different token contract addresses.");
  }
  if (t.allocation <= 0n || t.quote <= 0n || payment(t).buyerTotal > max256) throw say("Check both amounts. The quote plus the buyer fee must fit onchain.");
  if (t.brokerBps < 0n || t.brokerBps > 10_000n) throw say("Enter a broker share between 0% and 100%.");
  if (t.expiry <= (now ?? 0n)) throw say("Set the deadline after the latest chain block.");
  if (t.delivery === 0n && t.fixedStart === 0n && t.cliffSeconds === 0n && t.durationSeconds === 0n) return;
  if (t.delivery !== 1n || t.cliffSeconds >= t.durationSeconds || (t.fixedStart || t.expiry) + t.durationSeconds > max64) {
    throw say("Use a vesting duration greater than its cliff and a schedule that fits onchain.");
  }
  if (now != null && t.fixedStart !== 0n && t.fixedStart <= now) throw say("Set the fixed start after the latest chain block.");
}

export function checkedAddress(text, label) {
  try {
    return getAddress(text.trim());
  } catch {
    throw say(`Enter a valid ${label.toLowerCase()} address.`);
  }
}

export async function authorize(wallet, domain, terms, signer) {
  await wallet.readChain();
  if (BigInt(wallet.chainId) !== BigInt(domain.chainId)) throw say("Switch to the deal's network before signing.");
  if (!same(wallet.account, signer)) throw say("Connect the designated wallet before signing.");
  const payload = TypedDataEncoder.getPayload(domain, types, terms);
  return wallet.provider.request({ method: "eth_signTypedData_v4", params: [signer, JSON.stringify(payload)] });
}

const status = ["awaiting", "funded", "settled", "refunded"];
export const labels = {
  awaiting: "Awaiting funding", funded: "Funded", settled: "Settled", expired: "Expired", refunded: "Refunded", unavailable: "Unavailable",
};
export function dealState(chainStatus, terms, time, used = false) {
  if (chainStatus >= 2) return status[chainStatus];
  const now = BigInt(time);
  if (now >= terms.expiry || (terms.fixedStart !== 0n && (chainStatus === 0 ? now >= terms.fixedStart : now > terms.fixedStart))) {
    return "expired";
  }
  return chainStatus === 0 && used ? "unavailable" : status[chainStatus];
}

const dealEvents = ["BrokerDealFunded", "BrokerDealSettled", "BrokerDealRefunded"];
const eventTopics = (names) => names.map(name => abi.getEvent(name).topicHash);
const resultOrder = (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex);
const scopedTopics = {
  broker: (account) => abi.encodeFilterTopics("BrokerDealFunded", [null, null, account]),
  seller: (account) => abi.encodeFilterTopics("BrokerDealFunded", [null, account]),
  buyer: (account) => abi.encodeFilterTopics("BrokerDealBuyer", [null, account]),
};

export class BrokerChain {
  constructor(chain, chainId, contract, fromBlock) {
    this.chain = chain;
    this.contract = getAddress(contract);
    this.domain = domainOf(BigInt(chainId), this.contract);
    this.fromBlock = fromBlock;
  }

  async ask(method, args, block) {
    const request = { to: this.contract, data: abi.encodeFunctionData(method, args) };
    const result = await this.chain.rpc("eth_call", [request, toQuantity(block)]);
    if (result === "0x") throw say("The V3 deal contract is unavailable on this network.");
    return abi.decodeFunctionResult(method, result);
  }

  async block() {
    const [network, block] = await Promise.all([this.chain.rpc("eth_chainId", []), this.chain.block()]);
    if (BigInt(network) !== this.domain.chainId) throw say("The site's read-only RPC is on a different network. Try again when the deployment is reachable.");
    return block;
  }

  async deal(id, block) {
    const [terms, status, grantId] = await this.ask("getDeal", [id], block);
    return { terms: plainTerms(terms), status: Number(status), grantId };
  }

  async grant(id, block) {
    const [[grant], [claimable]] = await Promise.all([
      this.ask("getGrant", [id], block), this.ask("claimable", [id], block),
    ]);
    const balance = await this.chain.rpc("eth_call", [
      { to: grant.token, data: encode("0x70a08231", grant.custodian) }, toQuantity(block),
    ]).then(BigInt, () => null);
    return { ...grant.toObject(), claimable, held: balance };
  }

  async readProposal({ id, terms }, block) {
    const [deal, [digest], [treasury]] = await Promise.all([
      this.deal(id, block), this.ask("hashTerms", [terms], block), this.ask("treasury", [], block),
    ]);
    if (id !== digest || (deal.status && id !== dealIdOf(this.domain, deal.terms))) {
      throw say("The link's signed terms could not be verified against this deployment.");
    }
    const used = deal.status === 0 && (await this.ask("nonces", [terms.seller, terms.nonce], block))[0];
    return { ...deal, terms: deal.status ? deal.terms : terms, treasury, used };
  }

  async logs(topics, from, to) {
    if (to < from) return [];
    try {
      return await this.chain.rpc("eth_getLogs", [{ address: this.contract, topics, fromBlock: toQuantity(from), toBlock: toQuantity(to) }]);
    } catch (error) {
      if (from === to || !(error.code === -32005 || /range|too many|limit|response size/i.test(error.message))) throw error;
      const halfway = Math.floor((from + to) / 2);
      return (await this.logs(topics, from, halfway)).concat(await this.logs(topics, halfway + 1, to));
    }
  }

  async receipts(id, block, grantId = 0n) {
    const [dealLogs, claims] = await Promise.all([
      this.logs([eventTopics(dealEvents), id], this.fromBlock, block),
      grantId === 0n ? [] : this.logs(abi.encodeFilterTopics("BrokerGrantClaimed", [grantId]), this.fromBlock, block),
    ]);
    return [...dealLogs, ...claims].filter(log => !log.removed).sort(resultOrder).map(log => {
      const parsed = abi.parseLog(log);
      return { name: parsed.name, ...parsed.args.toObject(), hash: log.transactionHash, block: Number(log.blockNumber) };
    });
  }

  async discover(role, account, from, to) {
    const logs = await this.logs(scopedTopics[role](account), from, to);
    return logs.filter(log => !log.removed).sort(resultOrder).reverse().map(log => log.topics[1]);
  }
}
