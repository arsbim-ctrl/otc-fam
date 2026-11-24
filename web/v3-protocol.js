import { Interface, TypedDataEncoder, verifyTypedData, getAddress, ZeroAddress } from "./ethers-v3.js";
import { explain, same, say, word } from "./eth.js";
import { money } from "./v2.js";

export const TYPES = { BrokerTerms: [
  ["seller", "address"], ["buyer", "address"], ["baseToken", "address"], ["quoteToken", "address"],
  ["allocation", "uint256"], ["quote", "uint256"], ["expiry", "uint64"], ["nonce", "uint256"],
  ["delivery", "uint8"], ["fixedStart", "uint64"], ["cliffSeconds", "uint64"], ["durationSeconds", "uint64"],
  ["broker", "address"], ["brokerBps", "uint16"],
].map(([name, type]) => ({ name, type })) };

const fields = TYPES.BrokerTerms;
const tuple = "(" + fields.map(({ name, type }) => `${type} ${name}`).join(",") + ")";
const ABI = new Interface([
  `function fund(${tuple} terms, bytes sellerSignature)`,
  "function settle(bytes32 dealId, bytes buyerSignature)",
  "function refund(bytes32 dealId)",
  "function claim(uint256 grantId)",
  "function treasury() view returns (address)",
  "function usedNonce(address seller, uint256 nonce) view returns (bool)",
  `function hashTerms(${tuple} terms) view returns (bytes32)`,
  `function getDeal(bytes32 dealId) view returns (${tuple} terms, uint8 status, uint256 grantId)`,
  "function getGrant(uint256 grantId) view returns ((address token,address beneficiary,address custodian,uint256 allocation,uint64 start,uint64 cliff,uint64 end,uint256 claimed) grant)",
  "function claimable(uint256 grantId) view returns (uint256)",
  "event BrokerDealFunded(bytes32 indexed dealId, address indexed seller, address indexed broker)",
  "event BrokerDealBuyer(bytes32 indexed dealId, address indexed buyer)",
  "event BrokerDealSettled(bytes32 indexed dealId, address indexed buyer, uint256 buyerFee, uint256 sellerFee, uint256 brokerFee, uint256 treasuryFee, uint256 grantId)",
  "event BrokerDealRefunded(bytes32 indexed dealId)",
  "event BrokerGrantClaimed(uint256 indexed grantId, address indexed beneficiary, uint256 amount)",
  "error InvalidSignature()",
  "error NonceUsed(address seller, uint256 nonce)",
  "error DealNotFunded(bytes32 dealId)",
  "error WrongCaller(address expected)",
  "error FixedStartPassed()",
  "error Expired()",
]);
const statuses = ["awaiting", "funded", "settled", "refunded"];
const kindOf = { BrokerDealFunded: "funded", BrokerDealSettled: "settled", BrokerDealRefunded: "refunded", BrokerGrantClaimed: "claimed" };
const MAX64 = 2n ** 64n - 1n;
const MAX256 = 2n ** 256n - 1n;

export const STAGE = {
  awaiting: "Awaiting funding", funded: "Funded", settled: "Settled", expired: "Expired", refunded: "Refunded", unavailable: "Nonce already used",
};
export const scope = ({ chainId, contractV3 }) => ({ name: "OTC.fam Broker Deals", version: "3", chainId, verifyingContract: contractV3.toLowerCase() });
export const txData = (name, ...args) => ABI.encodeFunctionData(name, args);
export const dealId = (domain, terms) => TypedDataEncoder.hash(domain, TYPES, terms);
export const feesFor = (terms) => {
  const payment = money(terms.quote);
  const brokerFee = payment.feePool * terms.brokerBps / 10_000n;
  return { ...payment, brokerFee, treasuryFee: payment.feePool - brokerFee };
};
export const percent = (bps) => `${bps / 100n}.${String(bps % 100n).padStart(2, "0")}%`;
export const roleFor = (terms, account) => ["seller", "buyer", "broker"].find((role) => same(terms[role], account));

function normalize(values) {
  if (values.length !== fields.length) throw say("This proposal is incomplete.");
  const terms = Object.fromEntries(fields.map(({ name, type }, i) => {
    const value = values[i];
    if (type === "address") {
      try { return [name, getAddress(value).toLowerCase()]; }
      catch { throw say(`Check the ${name} address in the deal terms.`); }
    }
    if (!/^\d{1,78}$/.test(String(value))) throw say("The proposal contains an invalid raw amount or time.");
    const number = BigInt(value);
    if (number >= 2n ** BigInt(type.slice(4))) throw say("A value in the proposal exceeds the contract's limit.");
    return [name, number];
  }));
  if (new Set([terms.seller, terms.buyer, terms.broker, ZeroAddress]).size !== 4) throw say("Enter three distinct seller, buyer and broker addresses.");
  if (new Set([terms.baseToken, terms.quoteToken, ZeroAddress]).size !== 3) throw say("Enter two distinct token contract addresses.");
  if (!terms.allocation || !terms.quote || feesFor(terms).buyerTotal > MAX256) throw say("Enter positive token amounts within the contract's limits.");
  if (terms.brokerBps > 10_000n) throw say("The broker share must be between 0% and 100% of the fee pool.");
  if (terms.expiry === 0n) throw say("Enter a deal deadline.");
  if (terms.delivery === 0n && (terms.fixedStart || terms.cliffSeconds || terms.durationSeconds)) throw say("Immediate delivery has no vesting schedule.");
  if (terms.delivery > 1n || (terms.delivery === 1n && (
    terms.cliffSeconds >= terms.durationSeconds || (terms.fixedStart || terms.expiry) + terms.durationSeconds > MAX64
  ))) throw say("Enter a valid vesting schedule with a cliff shorter than the duration.");
  return terms;
}

export const termsFrom = (input) => normalize(fields.map(({ name }) => input[name]));

export function proposalPath(domain, terms) {
  const values = fields.map(({ name }) => String(terms[name]));
  const payload = [3, domain.chainId, domain.verifyingContract, dealId(domain, terms), ...values];
  return "#/v3/p/" + btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function readProposal(domain, payload) {
  if (!/^[\w-]{1,2400}$/.test(payload)) throw say("This v3 proposal link is incomplete or malformed.");
  let envelope;
  try {
    envelope = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    throw say("This v3 proposal link is incomplete or malformed.");
  }
  if (!Array.isArray(envelope)) throw say("This v3 proposal link is malformed.");
  const [version, chainId, contract, id, ...values] = envelope;
  if (version !== 3 || chainId !== domain.chainId || !same(contract, domain.verifyingContract)) {
    throw say("This proposal names another chain or BrokerDeals contract. Open it on the site configured for that deployment.");
  }
  if (!values.every((value) => typeof value === "string")) throw say("This v3 proposal link is malformed.");
  const terms = normalize(values);
  if (dealId(domain, terms) !== id) throw say("The terms do not match the deal ID in this link. Ask for the original link.");
  return { id, terms };
}

export async function signTerms(provider, account, domain, terms) {
  const typedData = TypedDataEncoder.getPayload(domain, TYPES, terms);
  const signature = await provider.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typedData)] });
  const signer = (() => {
    try { return verifyTypedData(domain, TYPES, terms, signature); } catch { return null; }
  })();
  if (!same(signer, account)) throw say("The wallet did not return a valid signature for these exact terms.");
  return signature;
}

export function brokerError(error) {
  const data = [error?.data, error?.data?.data, error?.data?.originalError?.data].find((v) => typeof v === "string");
  let reason;
  try { reason = data && ABI.parseError(data)?.name; } catch {}
  return ({
    InvalidSignature: "The signature does not authorize these terms on this chain and contract.",
    NonceUsed: "The seller has already used this nonce. Ask the broker for a new proposal.",
    DealNotFunded: "This deal is no longer available for that action. Check the current status and receipt.",
    WrongCaller: "The connected wallet is not authorized for this action.",
    FixedStartPassed: "The fixed vesting start has passed. The seller can refund the allocation.",
    Expired: "The deal deadline has passed. Only the seller can refund a funded allocation.",
  })[reason] ?? explain(error);
}

export class BrokerChain {
  constructor(chain, config) {
    this.chain = chain;
    this.domain = scope(config);
    this.contract = this.domain.verifyingContract;
    this.fromBlock = Number.isSafeInteger(config.fromBlockV3) && config.fromBlockV3 >= 0 ? config.fromBlockV3 : 0;
  }

  async checkNetwork() {
    if (BigInt(await this.chain.rpc("eth_chainId", [])) !== BigInt(this.domain.chainId)) {
      throw say("The site's RPC is connected to a different chain. This deal cannot be used here.");
    }
  }

  async read(name, args, block = "latest") {
    const result = await this.chain.rpc("eth_call", [{ to: this.contract, data: txData(name, ...args) }, block]);
    if (result === "0x") throw say("No BrokerDeals contract answered at the address in the site configuration.");
    return ABI.decodeFunctionResult(name, result);
  }

  async deal(id, block = "latest") {
    const [result, state, grantId] = await this.read("getDeal", [id], block);
    const status = statuses[Number(state)];
    if (!status) throw say("The broker contract returned an unknown status.");
    const terms = status === "awaiting" ? null : termsFrom(result.toObject());
    if (terms && dealId(this.domain, terms) !== id) throw say("The onchain terms do not match this deal ID.");
    return { id, terms, status, grantId };
  }

  async grant(id, block) {
    const [[result], [claimable]] = await Promise.all([
      this.read("getGrant", [id], block), this.read("claimable", [id], block),
    ]);
    const grant = result.toObject();
    const held = await this.chain.rpc("eth_call", [{ to: grant.token, data: "0x70a08231" + word(grant.custodian) }, block]);
    return { ...grant, id, claimable, held: BigInt(held) };
  }

  // Limit each request's block span and bisect further if the RPC has a smaller log limit.
  async logs(topics, latest) {
    const readRange = async (from, to) => {
      try {
        return await this.chain.rpc("eth_getLogs", [{ address: this.contract, topics, fromBlock: toHex(from), toBlock: toHex(to) }]);
      } catch (error) {
        if (to === from || !/range|limit|too many|more than|response size/i.test(error.message)) throw error;
        const mid = Math.floor((from + to) / 2);
        return [...await readRange(from, mid), ...await readRange(mid + 1, to)];
      }
    };
    const logs = [];
    for (let to = latest; to >= this.fromBlock; to -= 25_000) {
      logs.push(...await readRange(Math.max(this.fromBlock, to - 24_999), to));
    }
    return logs;
  }

  async history(account, latest) {
    const party = "0x" + word(account);
    const funded = ABI.getEvent("BrokerDealFunded").topicHash;
    const invited = ABI.getEvent("BrokerDealBuyer").topicHash;
    const invites = await Promise.all([
      this.logs([funded, null, party], latest),
      this.logs([funded, null, null, party], latest),
      this.logs([invited, null, party], latest),
    ]);
    return [...new Set(invites.flat().map((log) => log.topics[1]))];
  }

  async receipts(id, grantId, latest) {
    const types = Object.keys(kindOf).filter((name) => name !== "BrokerGrantClaimed").map((name) => ABI.getEvent(name).topicHash);
    const events = await this.logs([types, id], latest);
    if (grantId) {
      events.push(...await this.logs([ABI.getEvent("BrokerGrantClaimed").topicHash, "0x" + word(grantId)], latest));
    }
    const receipts = new Map();
    return Promise.all(events.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex))
      .map(async (log) => {
        const parsed = ABI.parseLog(log);
        if (!receipts.has(log.transactionHash)) receipts.set(log.transactionHash,
          this.chain.rpc("eth_getTransactionReceipt", [log.transactionHash]).catch(() => null));
        const receipt = await receipts.get(log.transactionHash);
        const confirmed = receipt?.status === "0x1" && receipt.blockHash === log.blockHash;
        return { kind: kindOf[parsed.name], hash: log.transactionHash, block: Number(log.blockNumber), confirmed, ...parsed.args.toObject() };
      }));
  }
}

export const toHex = (value) => "0x" + value.toString(16);
export const ended = (terms, time) => BigInt(time) >= terms.expiry
  || (terms.fixedStart !== 0n && BigInt(time) > terms.fixedStart);

export function effectiveStatus(deal, time) {
  if (["settled", "refunded"].includes(deal.status)) return deal.status;
  if (ended(deal.terms, time) || (deal.status === "awaiting" && deal.terms.fixedStart !== 0n && BigInt(time) === deal.terms.fixedStart)) return "expired";
  if (deal.nonceUsed) return "unavailable";
  return deal.status;
}

export function directory(domain) {
  const prefix = `otcfam:v3:${domain.chainId}:${domain.verifyingContract}:`;
  const pathFor = (id) => `#/v3/d/${id}`;
  return {
    pathFor,
    save(account, id, path, created = false) {
      const key = `${prefix}${account.toLowerCase()}:${id}`;
      try {
        const prior = JSON.parse(localStorage.getItem(key));
        localStorage.setItem(key, JSON.stringify({ id, path, created: prior?.created || created }));
        return true;
      } catch { return false; }
    },
    list(account) {
      const owner = `${prefix}${account.toLowerCase()}:`;
      try {
        return Object.keys(localStorage).filter((key) => key.startsWith(owner))
          .map((key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } })
          .filter((row) => row && /^0x[0-9a-f]{64}$/.test(row.id) && typeof row.path === "string").reverse();
      } catch { return []; }
    },
  };
}
