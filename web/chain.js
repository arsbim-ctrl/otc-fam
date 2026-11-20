export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
export const MAX_AMOUNT = (1n << 256n) - 1n;
const READ_TIMEOUT = 10_000;

// The fixed OtcDeals interface and the ERC-20 methods used by the page. Each
// selector is the first four bytes of the keccak256 hash of its signature.
const GET_DEAL = "82fd5bac"; // getDeal(uint256)
const FILL = "3fda5389"; // fill(uint256)
const CREATE = "706f50dc"; // createDeal(address,uint256,address,uint256,address,uint64)
const BALANCE = "70a08231"; // balanceOf(address)
const ALLOWANCE = "dd62ed3e"; // allowance(address,address)
const APPROVE = "095ea7b3"; // approve(address,uint256)
const SYMBOL = "95d89b41"; // symbol()
const DECIMALS = "313ce567"; // decimals()
const CREATED = "0x1c07d8ea6e5c6ec1eccadc84e71fb9989193eb338ddddea20f1445943761ff9c"; // DealCreated(uint256,address,address)

export function address(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function quantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("Invalid chain quantity");
  return BigInt(value);
}

function encode(selector, ...args) {
  return `0x${selector}${args.map((arg) => {
    if (typeof arg === "bigint" && arg >= 0n && arg <= MAX_AMOUNT) return arg.toString(16).padStart(64, "0");
    const account = address(arg);
    if (!account) throw new Error("Invalid transaction argument");
    return account.slice(2).padStart(64, "0");
  }).join("")}`;
}

function word(data, index) {
  const offset = 2 + index * 64;
  const value = data.slice(offset, offset + 64);
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("Incomplete ABI result");
  return value;
}

function uint(data, index = 0) {
  return BigInt(`0x${word(data, index)}`);
}

function readAddress(data, index) {
  const value = word(data, index);
  if (!value.startsWith("0".repeat(24))) throw new Error("Invalid ABI address");
  return `0x${value.slice(24).toLowerCase()}`;
}

function tokenSymbol(data) {
  // A legacy token may report a bytes32 symbol instead of a string.
  let hex = word(data, 0);
  if (data.length === 66) hex = hex.replace(/(?:00)+$/, "");
  else {
    const length = uint(data, 1);
    if (uint(data) !== 32n || length > 128n) throw new Error("Invalid token symbol");
    hex = data.slice(130, 130 + 2 * Number(length));
    if (hex.length !== 2 * Number(length)) throw new Error("Incomplete token symbol");
  }
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("Invalid token symbol");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16)));
  if (!text.trim() || /[\p{Cc}\p{Cf}]/u.test(text)) throw new Error("Invalid token symbol");
  return text;
}

export async function loadChain() {
  const response = await fetch(new URL("./config.json", import.meta.url), {
    cache: "no-store", signal: AbortSignal.timeout(READ_TIMEOUT),
  });
  if (!response.ok) throw new Error("The site’s network settings could not be loaded.");
  const config = await response.json();
  const contract = address(config?.contract);
  if (!contract || contract === ZERO_ADDRESS) throw new Error("This site has no deal contract configured yet.");
  const chainId = config.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || typeof config.rpcUrl !== "string" || !config.rpcUrl.trim()) {
    throw new Error("This site’s network settings are incomplete.");
  }
  const rpcUrl = new URL(config.rpcUrl, location.href);
  if (!["http:", "https:"].includes(rpcUrl.protocol) || rpcUrl.username || rpcUrl.password) {
    throw new Error("This site has an invalid network URL.");
  }

  let requestId = 0;
  async function rpc(method, params = []) {
    const id = ++requestId;
    const response = await fetch(rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(READ_TIMEOUT),
    });
    if (!response.ok) throw new Error("Network request failed");
    const body = await response.json();
    if (!body || body.id !== id) throw new Error("Unexpected network response");
    if (body.error) throw Object.assign(new Error("The network rejected the request"), { code: body.error.code });
    if (!("result" in body)) throw new Error("Missing network result");
    return body.result;
  }
  if (quantity(await rpc("eth_chainId")) !== BigInt(chainId)) throw new Error("The site’s network URL is connected to a different chain.");
  const code = await rpc("eth_getCode", [contract, "latest"]);
  if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) {
    throw new Error("No deal contract was found at the site’s configured address.");
  }

  async function call(to, data, { from, provider } = {}) {
    const params = [{ to, data, ...(from ? { from } : {}) }, "latest"];
    const result = await (provider ? walletCall(provider, params) : rpc("eth_call", params));
    if (typeof result !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(result)) throw new Error("Invalid contract result");
    return result;
  }

  async function tokenPrecision(token, provider) {
    const precision = uint(await call(token, encode(DECIMALS), { provider }));
    if (precision > 255n) throw new Error("Invalid token decimals");
    return Number(precision);
  }

  return {
    chainId,
    contract,
    async latestTime() {
      return quantity((await rpc("eth_getBlockByNumber", ["latest", false]))?.timestamp);
    },
    async deal(id, provider) {
      const data = await call(contract, encode(GET_DEAL, id), { provider });
      const status = ["not-found", "open", "filled", "cancelled"][Number(uint(data, 7))];
      if (!status) throw new Error("Unrecognized deal status");
      return {
        id, status, maker: readAddress(data, 0), taker: readAddress(data, 1),
        sellToken: readAddress(data, 2), sellAmount: uint(data, 3),
        buyToken: readAddress(data, 4), buyAmount: uint(data, 5), expiry: uint(data, 6),
      };
    },
    async token(token) {
      const [precision, symbol] = await Promise.all([tokenPrecision(token), call(token, encode(SYMBOL))]);
      return { precision, symbol: tokenSymbol(symbol) };
    },
    tokenPrecision,
    async funds(token, account) {
      const [balance, allowance] = await Promise.all([
        call(token, encode(BALANCE, account)), call(token, encode(ALLOWANCE, account, contract)),
      ]);
      return { balance: uint(balance), allowance: uint(allowance) };
    },
    approval(token, amount) {
      return { to: token, data: encode(APPROVE, contract, amount) };
    },
    fill(id) {
      return { to: contract, data: encode(FILL, id) };
    },
    create({ sellToken, sellAmount, buyToken, buyAmount, taker, expiry }) {
      return { to: contract, data: encode(CREATE, sellToken, sellAmount, buyToken, buyAmount, taker, expiry) };
    },
    async simulate({ to, data }, account, approval) {
      const result = await call(to, data, { from: account });
      if (approval && result !== "0x" && uint(result) !== 1n) throw new Error("Token refused approval");
    },
    receipt(hash) {
      return rpc("eth_getTransactionReceipt", [hash]);
    },
    createdId(receipt, maker, taker) {
      const event = receipt.logs?.find((log) => address(log.address) === contract && log.topics?.length === 4
        && log.topics[0].toLowerCase() === CREATED && readAddress(log.topics[2], 0) === maker
        && readAddress(log.topics[3], 0) === taker);
      return event ? uint(event.topics[1]) : null;
    },
  };
}

async function walletCall(provider, params) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Wallet verification timed out")), READ_TIMEOUT);
  });
  try {
    return await Promise.race([provider.request({ method: "eth_call", params }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function walletState(wallet, method = "eth_accounts") {
  if (!wallet) return { account: null, chainId: null };
  const accounts = await wallet.request({ method });
  const account = address(accounts?.[0]);
  if (!account || account === ZERO_ADDRESS) return { account: null, chainId: null };
  return { account, chainId: quantity(await wallet.request({ method: "eth_chainId" })) };
}

export async function switchNetwork(wallet, chainId) {
  await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
}
