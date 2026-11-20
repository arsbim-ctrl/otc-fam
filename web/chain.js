export const ZERO_ADDRESS = "0x" + "0".repeat(40);
export const MAX_UINT = 2n ** 256n - 1n;
export const isAddress = (value) => typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
export const isHash = (value) => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
export const quantity = (value) => "0x" + value.toString(16);

// Selectors for IOtcDeals and the ERC-20 functions used by the page.
const GET_DEAL = "0x82fd5bac";
const FILL = "0x3fda5389";
const CREATE_DEAL = "0x706f50dc";
const DEAL_CREATED = "0x1c07d8ea6e5c6ec1eccadc84e71fb9989193eb338ddddea20f1445943761ff9c";
const BALANCE = "0x70a08231";
const ALLOWANCE = "0xdd62ed3e";
const APPROVE = "0x095ea7b3";
const DECIMALS = "0x313ce567";
const SYMBOL = "0x95d89b41";

const calldata = (selector, ...args) =>
  selector + args.map((arg) => BigInt(arg).toString(16).padStart(64, "0")).join("");

function words(hex) {
  if (typeof hex !== "string" || !/^0x(?:[\da-f]{64})+$/i.test(hex)) {
    throw new Error("The contract returned an unexpected response.");
  }
  return hex.slice(2).match(/.{64}/g);
}

const asUint = (word) => BigInt("0x" + word);
const asAddress = (word) => "0x" + word.slice(24).toLowerCase();
const uint = (hex) => asUint(words(hex)[0]);

function decodeSymbol(hex) {
  const values = words(hex);
  let data;
  if (values.length === 1) {
    // Older ERC-20s may return a zero-padded bytes32 symbol.
    data = values[0].replace(/(?:00)+$/, "");
  } else {
    const length = asUint(values[1]);
    const payload = values.slice(2).join("");
    if (asUint(values[0]) !== 32n || length > BigInt(payload.length / 2)) {
      throw new Error("The token returned an invalid symbol.");
    }
    data = payload.slice(0, Number(length) * 2);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(data.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)),
  );
}

export function formatAmount(amount, decimals) {
  const digits = amount.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return digits;
  const fractional = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fractional ? "." + fractional : "");
}

export function parseAmount(text, decimals, label) {
  if (text.length > 335 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    throw new Error(label + " must be a positive decimal number.");
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(decimals === 0 ? label + " must be a whole number." :
      label + " supports at most " + decimals + " decimal places.");
  }
  const units = BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
  if (units < 1n || units > MAX_UINT) throw new Error(label + " is outside the supported range.");
  return units;
}

export async function loadChain() {
  const response = await fetch("./config.json", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("Could not load the site's network configuration.");
  const { chainId, contract, rpcUrl } = await response.json();
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !isAddress(contract) ||
      contract.toLowerCase() === ZERO_ADDRESS || typeof rpcUrl !== "string" || !rpcUrl.trim()) {
    throw new Error("This site needs a deployed deal contract and a valid network configuration.");
  }
  const endpoint = new URL(rpcUrl, document.baseURI);
  if (!["https:", "http:"].includes(endpoint.protocol)) throw new Error("The RPC URL must use HTTP or HTTPS.");

  let requestId = 0;
  async function rpc(method, params = []) {
    const id = ++requestId;
    let reply;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error();
      reply = await response.json();
    } catch {
      throw new Error("Could not reach the deal network. Try again.");
    }
    if (!reply || reply.id !== id) throw new Error("The deal network returned an unexpected response.");
    if (reply.error) {
      throw Object.assign(new Error("The deal network could not complete the request."), {
        rpcError: true,
        data: reply.error.data,
      });
    }
    if (!Object.hasOwn(reply, "result")) throw new Error("The deal network returned no result.");
    return reply.result;
  }

  if (BigInt(await rpc("eth_chainId")) !== BigInt(chainId)) {
    throw new Error("The configured RPC endpoint is on a different network.");
  }

  const call = (to, data, from) => rpc("eth_call", [from ? { to, data, from } : { to, data }, "latest"]);
  const tx = (to, data) => ({ to, data });
  const tokens = new Map();
  return {
    chainId,
    contract: contract.toLowerCase(),
    async deal(id) {
      const values = words(await call(contract, calldata(GET_DEAL, id)));
      if (values.length !== 8 || asUint(values[7]) > 3n) throw new Error("Could not read this deal.");
      const [maker, taker, sell, sellAmount, buy, buyAmount, expiry, status] = values;
      return {
        maker: asAddress(maker), taker: asAddress(taker),
        sell: asAddress(sell), sellAmount: asUint(sellAmount),
        buy: asAddress(buy), buyAmount: asUint(buyAmount),
        expiry: asUint(expiry), status: Number(asUint(status)),
      };
    },
    async blockTime() {
      const block = await rpc("eth_getBlockByNumber", ["latest", false]);
      return BigInt(block.timestamp);
    },
    token(address) {
      if (!tokens.has(address)) {
        const metadata = Promise.all([call(address, DECIMALS), call(address, SYMBOL)])
          .then(([rawDecimals, rawSymbol]) => {
            const decimals = uint(rawDecimals);
            if (decimals > 255n) throw new Error("This token returned invalid decimals.");
            return { decimals: Number(decimals), symbol: decodeSymbol(rawSymbol) };
          })
          .catch((error) => {
            tokens.delete(address);
            if (!error.rpcError && error.message.startsWith("Could not reach")) throw error;
            throw new Error("Could not read token metadata for " + address + ".");
          });
        tokens.set(address, metadata);
      }
      return tokens.get(address);
    },
    async funding(token, account) {
      const [balance, allowance] = await Promise.all([
        call(token, calldata(BALANCE, account)),
        call(token, calldata(ALLOWANCE, account, contract)),
      ]);
      return { balance: uint(balance), allowance: uint(allowance) };
    },
    approval: (token, amount) => tx(token, calldata(APPROVE, contract, amount)),
    fill: (id) => tx(contract, calldata(FILL, id)),
    create: ({ sell, sellAmount, buy, buyAmount, taker, expiry }) =>
      tx(contract, calldata(CREATE_DEAL, sell, sellAmount, buy, buyAmount, taker, expiry)),
    async simulate(transaction, from) {
      const result = await call(transaction.to, transaction.data, from);
      if (transaction.data.startsWith(APPROVE) && result !== "0x" && uint(result) !== 1n) {
        throw new Error("The token refused this approval.");
      }
    },
    async receipt(hash, { attempts = 16, signal } = {}) {
      for (let attempt = 0; attempt < attempts && !signal?.aborted; attempt++) {
        const receipt = await rpc("eth_getTransactionReceipt", [hash]);
        if (receipt) return receipt;
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return null;
    },
    async hasTransaction(hash) {
      return await rpc("eth_getTransactionByHash", [hash]) !== null;
    },
    createdId(receipt, hash) {
      if (!isHash(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== hash ||
          !isHash(receipt.blockHash) || !isAddress(receipt.from) ||
          !isAddress(receipt.to) || receipt.to.toLowerCase() !== contract.toLowerCase()) {
        throw new Error("Could not verify the receipt for this transaction.");
      }
      if (receipt.status === "0x0") return null;
      if (receipt.status !== "0x1" || !Array.isArray(receipt.logs)) {
        throw new Error("Could not read the transaction status.");
      }
      const makerTopic = calldata("0x", receipt.from);
      const events = receipt.logs.filter((log) =>
        log?.removed !== true && isAddress(log?.address) && log.address.toLowerCase() === contract.toLowerCase() &&
        isHash(log.transactionHash) && log.transactionHash.toLowerCase() === hash && log.data === "0x" &&
        Array.isArray(log.topics) && log.topics.length === 4 && log.topics.every(isHash) &&
        log.topics[0].toLowerCase() === DEAL_CREATED && log.topics[2].toLowerCase() === makerTopic &&
        /^0x0{24}[\da-f]{40}$/i.test(log.topics[3]),
      );
      if (events.length !== 1 || BigInt(events[0].topics[1]) === 0n) {
        throw new Error("The receipt did not verify a deal creation.");
      }
      return BigInt(events[0].topics[1]).toString();
    },
  };
}

const swapErrors = {
  "0x7df175fd": "This deal is no longer open.",
  "0x269fad92": "The deal has expired.",
  "0x9ce45e3c": "This wallet is not the deal's reserved taker.",
  "0x642faafa": "A party no longer has enough tokens to fill this deal.",
  "0x48a4274a": "A token would change the agreed amounts. This deal cannot settle.",
  "0x39f1c8d9": "A token refused the transfer. Check your balance and token approval.",
  "0xaff1242f": "The token balance in escrow is below the amount reserved. This deal cannot settle right now.",
};

export function explain(error, fallback) {
  if (Number(error.code) === 4001) return "You declined the wallet request. You can try again.";
  if (Number(error.code) === 4902) return "Add the deal’s network in your wallet, then switch to it.";
  const data = typeof error.data === "string" ? error.data : error.data?.data;
  const reason = typeof data === "string" ? swapErrors[data.slice(0, 10).toLowerCase()] : null;
  if (reason) return reason;
  if (error.rpcError || typeof error.code === "number") return fallback;
  return error.message || fallback;
}
