import { getAddress, Interface, ZeroAddress } from "./ethers.min.js";

export const anyone = ZeroAddress;
const maxAmount = (1n << 256n) - 1n;
const deals = new Interface([
  "function getDeal(uint256 id) view returns (tuple(address maker, address taker, address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, uint64 expiry, uint8 status))",
  "function createDeal(address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, address taker, uint64 expiry) returns (uint256)",
  "function fill(uint256 id)",
  "event DealCreated(uint256 indexed id, address indexed maker, address indexed taker)",
]);
const token = new Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export class UserError extends Error {}

export function address(value, label, allowZero = false) {
  try {
    const normalized = getAddress(value.trim());
    if (!allowZero && normalized === anyone) throw new Error();
    return normalized;
  } catch {
    throw new UserError(`Enter a valid ${label} address.`);
  }
}

export function dealId(hash) {
  const digits = /^#\/d\/(\d+)$/.exec(hash)?.[1];
  if (!digits || digits.length > 78) return null;
  const id = BigInt(digits);
  return id > 0n && id <= maxAmount ? id : null;
}

export function formatAmount(value, decimals) {
  if (!decimals) return String(value);
  const digits = String(value).padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${digits.slice(0, -decimals)}.${fraction}` : digits.slice(0, -decimals);
}

function decimalParts(value, label) {
  const trimmed = value.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) throw new UserError(`Enter a valid ${label}.`);
  const [whole, fraction = ""] = trimmed.split(".");
  return [whole || "0", fraction];
}

export function parseAmount(value, { decimals, symbol }, label) {
  const [whole, fraction] = decimalParts(value, label);
  if (fraction.length > decimals) {
    const precision = decimals === 0 ? "only allows whole tokens" : `allows up to ${decimals} decimal places`;
    throw new UserError(`${symbol} ${precision}. Check the ${label}.`);
  }
  const amount = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (amount === 0n || amount > maxAmount) throw new UserError(`Enter a positive ${label} within the token’s range.`);
  return amount;
}

export function parseDuration(value) {
  const [whole, fraction] = decimalParts(value, "expiry in hours");
  const base = 10n ** BigInt(fraction.length);
  const scaled = BigInt(whole + fraction) * 3600n;
  if (scaled === 0n || scaled % base !== 0n || scaled / base > 8_640_000_000_000n) {
    throw new UserError("Enter a positive expiry in hours that works out to whole seconds.");
  }
  return scaled / base;
}

function calldata(iface, method, args) {
  return iface.encodeFunctionData(method, args);
}

export async function connectChain() {
  const response = await fetch("./config.json", { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new UserError("Couldn’t load this site’s network settings.");
  const config = await response.json();
  if (config.contract?.toLowerCase() === anyone) throw new UserError("This site hasn’t configured a deal contract yet.");
  const contract = address(config.contract, "deal contract");
  const url = new URL(config.rpcUrl, location.href);
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0 || !["https:", "http:"].includes(url.protocol)) {
    throw new UserError("This site’s network settings are invalid.");
  }

  let requestId = 0;
  async function rpc(method, params = []) {
    const reply = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    if (!reply.ok) throw new Error("RPC request failed");
    const message = await reply.json();
    if (message.error || !Object.hasOwn(message, "result")) throw new Error("RPC method failed");
    return message.result;
  }

  if (BigInt(await rpc("eth_chainId")) !== BigInt(config.chainId)) {
    throw new UserError("The read endpoint is on a different network from this site’s settings.");
  }

  async function read(iface, to, method, args = []) {
    const result = await rpc("eth_call", [{ to, data: calldata(iface, method, args) }, "latest"]);
    return iface.decodeFunctionResult(method, result)[0];
  }

  const metadata = new Map();
  function tokenInfo(to) {
    if (!metadata.has(to)) {
      metadata.set(to, Promise.all([
        read(token, to, "decimals"),
        read(token, to, "symbol"),
      ]).then(([decimals, symbol]) => {
        if (!symbol.trim()) throw new Error("Empty symbol");
        return { decimals: Number(decimals), symbol };
      }).catch(() => {
        metadata.delete(to);
        throw new UserError("Couldn’t read that token’s symbol and decimals. Check the address and network.");
      }));
    }
    return metadata.get(to);
  }

  return {
    contract,
    chainId: config.chainId,
    deal: (id) => read(deals, contract, "getDeal", [id]),
    async time() {
      return BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
    },
    tokenInfo,
    funds: (to, owner) => Promise.all([
      read(token, to, "balanceOf", [owner]),
      read(token, to, "allowance", [owner, contract]),
    ]),
    async simulate(tx, from) {
      let result;
      try {
        result = await rpc("eth_call", [{ ...tx, from }, "latest"]);
      } catch {
        throw new UserError("The network couldn’t simulate this transaction. Check the deal and balances, then try again.");
      }
      if (tx.to !== contract && result !== "0x" && result !== `0x${"0".repeat(63)}1`) {
        throw new UserError("The token refused the approval. Check the token and try again.");
      }
    },
    approval: (to, value) => ({ to, data: calldata(token, "approve", [contract, value]) }),
    fill: (id) => ({ to: contract, data: calldata(deals, "fill", [id]) }),
    create: (args) => ({ to: contract, data: calldata(deals, "createDeal", args) }),
    receipt: (hash) => rpc("eth_getTransactionReceipt", [hash]),
    createdId(receipt, account) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== contract.toLowerCase() || log.topics[0] !== deals.getEvent("DealCreated").topicHash) continue;
        const event = deals.parseLog(log);
        if (event.args.maker === account) return event.args.id;
      }
      return null;
    },
  };
}
