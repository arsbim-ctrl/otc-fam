import { Interface, TypedDataEncoder, verifyTypedData, getAddress } from "./vendor/ethers.js";
import { same, say, ZERO_ADDRESS } from "./eth.js";

export const fields = [
  ["seller", "address"], ["buyer", "address"], ["baseToken", "address"], ["quoteToken", "address"],
  ["allocation", "uint256"], ["quote", "uint256"], ["expiry", "uint64"], ["nonce", "uint256"],
  ["delivery", "uint8"], ["fixedStart", "uint64"], ["cliffSeconds", "uint64"],
  ["durationSeconds", "uint64"], ["broker", "address"], ["brokerBps", "uint16"],
];

const types = { BrokerTerms: fields.map(([name, type]) => ({ name, type })) };
const tuple = "(" + fields.map(([name, type]) => type + " " + name).join(",") + ")";
const abi = new Interface([
  "function fund(" + tuple + " terms, bytes sellerSignature)",
  "function settle(bytes32 dealId,bytes buyerSignature)",
  "function refund(bytes32 dealId)",
  "function getDeal(bytes32 dealId) view returns (" + tuple + " terms,uint8 status,uint256 grantId)",
  "function getGrant(uint256 grantId) view returns ((address token,address beneficiary,address custodian,uint256 allocation,uint64 start,uint64 cliff,uint64 end,uint256 claimed))",
  "function claim(uint256 grantId)",
  "function vested(uint256 grantId) view returns (uint256)",
  "function treasury() view returns (address)",
  "function usedNonce(address seller,uint256 nonce) view returns (bool)",
  "event BrokerDealFunded(bytes32 indexed dealId,address indexed seller,address indexed broker)",
  "event BrokerDealSettled(bytes32 indexed dealId,address indexed buyer,uint256 buyerFee,uint256 sellerFee,uint256 brokerFee,uint256 treasuryFee,uint256 grantId)",
  "event BrokerDealRefunded(bytes32 indexed dealId)",
  "event BrokerGrantClaimed(uint256 indexed grantId,address indexed beneficiary,uint256 amount)",
  "error InvalidTerms()", "error InvalidSignature()", "error WrongActor()", "error NonceUsed()",
  "error NotFunded()", "error DealExpired()", "error StartPassed()", "error NothingToClaim()",
  "error InexactTransfer(address)", "error TransferFailed(address)",
]);

export function normalize(terms) {
  const result = {};
  for (const [key, type] of fields) {
    const value = terms[key];
    if (type === "address") {
      if (!/^0x[0-9a-f]{40}$/i.test(value)) throw say("Check the " + key + " address.");
      result[key] = getAddress(value.toLowerCase());
    } else {
      if (!/^\d{1,78}$/.test(String(value)) || BigInt(value) >= (1n << BigInt(type.slice(4)))) throw say("Check " + key + ".");
      result[key] = String(BigInt(value));
    }
  }
  const parties = [result.seller, result.buyer, result.broker];
  if (parties.includes(ZERO_ADDRESS) || new Set(parties).size !== 3 ||
      result.baseToken === result.quoteToken || [result.baseToken, result.quoteToken].includes(ZERO_ADDRESS)) {
    throw say("Use distinct seller, buyer and broker wallets, and two different token contracts.");
  }
  const { quote, buyerTotal } = fees(result);
  if (!quote || !BigInt(result.allocation) || buyerTotal >= (1n << 256n) || BigInt(result.brokerBps) > 10000n) {
    throw say("Enter positive amounts and a broker share between 0% and 100%.");
  }
  const { delivery, fixedStart, cliffSeconds, durationSeconds, expiry } = result;
  if (delivery === "0") {
    if ([fixedStart, cliffSeconds, durationSeconds].some((value) => value !== "0")) throw say("Immediate delivery has no schedule.");
  } else if (delivery !== "1" || BigInt(cliffSeconds) >= BigInt(durationSeconds) ||
      BigInt(durationSeconds) + (BigInt(fixedStart) || BigInt(expiry) - 1n) >= (1n << 64n)) {
    throw say("Use a positive vesting duration, with a shorter cliff and a valid start.");
  }
  return result;
}

export function fees(terms) {
  const quote = BigInt(terms.quote), fee = quote / 200n;
  const pool = 2n * fee, broker = pool * BigInt(terms.brokerBps) / 10000n;
  return { quote, fee, pool, broker, treasury: pool - broker, buyerTotal: quote + fee, sellerNet: quote - fee };
}

export const nonce = () => BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(16)),
  (byte) => byte.toString(16).padStart(2, "0")).join("")).toString();
const currencyOrder = fields.map(([key]) => key);
const hex = (number) => "0x" + number.toString(16);

export class BrokerChain {
  constructor(chain, config) {
    this.chain = chain;
    this.contract = getAddress(config.contractV3.toLowerCase());
    this.fromBlock = hex(config.fromBlockV3 ?? 0);
    this.domain = { name: "OTC.fam Broker Deals", version: "3", chainId: config.chainId, verifyingContract: this.contract };
  }

  id(terms) {
    return TypedDataEncoder.hash(this.domain, types, terms);
  }

  link(terms) {
    const data = [String(this.domain.chainId), this.contract, ...currencyOrder.map((key) => terms[key])];
    return new URL("#/v3/d/" + btoa(JSON.stringify(data)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""), location.href).href;
  }

  decode(payload) {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(payload)) throw say("This broker deal link is incomplete.");
    const data = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
    if (!Array.isArray(data) || data.length !== 2 + fields.length) throw say("This broker deal link is incomplete.");
    if (data[0] !== String(this.domain.chainId) || !same(data[1], this.contract)) {
      throw say("This link belongs to a different network or V3 contract.");
    }
    return normalize(Object.fromEntries(currencyOrder.map((key, index) => [key, data[index + 2]])));
  }

  async read(fn, args = [], block = "latest") {
    const call = abi.encodeFunctionData(fn, args);
    const result = await this.chain.rpc("eth_call", [{ to: this.contract, data: call }, block]);
    return abi.decodeFunctionResult(fn, result);
  }

  data(fn, args) {
    return abi.encodeFunctionData(fn, args);
  }

  async sign(wallet, terms, actor) {
    await wallet.readChain();
    if (wallet.chainId !== this.domain.chainId || !same(wallet.account, actor)) throw say("Select the required wallet and network first.");
    const payload = TypedDataEncoder.getPayload(this.domain, types, terms);
    const signature = await wallet.provider.request({ method: "eth_signTypedData_v4", params: [wallet.account, JSON.stringify(payload)] });
    if (!same(verifyTypedData(this.domain, types, terms, signature), actor)) throw say("The signature came from a different wallet.");
    if (!same(wallet.account, actor)) throw say("The active wallet changed. Review the deal again.");
    return signature;
  }

  async logs(name, values, toBlock = "latest") {
    const topics = abi.encodeFilterTopics(name, values);
    const logs = await this.chain.rpc("eth_getLogs", [{ address: this.contract, topics, fromBlock: this.fromBlock, toBlock }]);
    return logs.filter((log) => !log.removed).map((log) => ({
      args: abi.parseLog(log).args, hash: log.transactionHash, block: Number(log.blockNumber), index: Number(log.logIndex),
    }));
  }

  async inspect(terms) {
    const id = this.id(terms), block = await this.chain.block(), tag = hex(block.number);
    const [[, status, grantId], [treasury], [used], base, quote] = await Promise.all([
      this.read("getDeal", [id], tag), this.read("treasury", [], tag), this.read("usedNonce", [terms.seller, terms.nonce], tag),
      this.chain.token(terms.baseToken), this.chain.token(terms.quoteToken),
    ]);
    const grant = grantId ? (await this.read("getGrant", [grantId], tag))[0] : null;
    const vested = grant ? (await this.read("vested", [grantId], tag))[0] : 0n;
    return { id, status: Number(status), treasury, used, base, quote, block, grantId, grant, vested };
  }
}

export function stageName(terms, state) {
  if (state.status === 2) return "Settled";
  if (state.status === 3) return "Refunded";
  if (BigInt(terms.expiry) <= BigInt(state.block.time)) return "Expired";
  if (terms.fixedStart !== "0" && BigInt(terms.fixedStart) < BigInt(state.block.time) + (state.status === 0 ? 1n : 0n)) {
    return "Fixed start passed";
  }
  if (!state.status && state.used) return "Nonce used";
  return state.status === 1 ? "Funded" : "Awaiting funding";
}

export function transactionError(error) {
  const data = error?.data?.data ?? error?.data;
  if (typeof data !== "string") return error;
  try {
    const reason = abi.parseError(data)?.name;
    const message = {
      InvalidTerms: "The contract refused these terms.",
      InvalidSignature: "The signature does not authorize these terms on this network.",
      WrongActor: "The connected wallet cannot act for this deal.",
      NonceUsed: "The seller already used this nonce. Duplicate the terms to create a new deal.",
      NotFunded: "The current deal state does not allow that action.",
      DealExpired: "This deal expired.",
      StartPassed: "The fixed start passed. The seller can refund a funded deal.",
      NothingToClaim: "No more tokens are claimable at the latest block.",
      InexactTransfer: "The token did not transfer the agreed amount. The transaction cannot proceed.",
      TransferFailed: "A token refused the transfer. Check balances and approvals.",
    }[reason];
    return message ? say(message) : error;
  } catch {
    return error;
  }
}
