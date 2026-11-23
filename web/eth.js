// The chain, as the page uses it: reads by JSON-RPC at the config's rpcUrl (no wallet needed), transactions through
// the browser's wallet (window.ethereum, EIP-1193). The few ABI encodings the page needs are written by hand: every
// argument it sends is one 32-byte word, and every answer it reads is words, or a string for symbol().
import { formatAmount } from "./units.js";

export class AppError extends Error {}

class ProviderError extends Error {
  constructor(source, cause) {
    super("Provider request failed.", { cause });
    this.source = source;
  }
}

export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

// keccak256 of each signature, first 4 bytes (test/page.test.mjs checks them against the compiled contract).
const SELECTOR = {
  getDeal: "0x82fd5bac", // getDeal(uint256)
  createDeal: "0x706f50dc", // createDeal(address,uint256,address,uint256,address,uint64)
  fill: "0x3fda5389", // fill(uint256)
  cancel: "0x40e58ee5", // cancel(uint256)
  symbol: "0x95d89b41", // symbol()
  decimals: "0x313ce567", // decimals()
  balanceOf: "0x70a08231", // balanceOf(address)
  allowance: "0xdd62ed3e", // allowance(address,address)
  approve: "0x095ea7b3", // approve(address,uint256)
};
const DEAL_CREATED = "0x1c07d8ea6e5c6ec1eccadc84e71fb9989193eb338ddddea20f1445943761ff9c"; // DealCreated(uint256,address,address)
const STATUS = ["none", "open", "filled", "cancelled"];

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
export const encode = (selector, ...args) => selector + args.map(word).join("");
export const words = (hex) => (hex ?? "0x").slice(2).match(/.{64}/g) ?? [];
export const uint = (w) => BigInt(`0x${w}`);
export const address = (w) => `0x${w.slice(24)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const approveData = (spender, amount) => encode(SELECTOR.approve, spender, amount);
export const fillData = (id) => encode(SELECTOR.fill, id);
export const cancelData = (id) => encode(SELECTOR.cancel, id);
export const createDealData = ({ sellToken, sellAmount, buyToken, buyAmount, taker, expiry }) =>
  encode(SELECTOR.createDeal, sellToken, sellAmount, buyToken, buyAmount, taker, expiry);

/** The id of the deal a createDeal transaction made, from its DealCreated event. */
export function createdId(receipt, contract) {
  const log = receipt.logs.find((l) => same(l.address, contract) && l.topics[0] === DEAL_CREATED);
  if (!log) throw new AppError("The deal was sent, but its receipt names no new deal. Check your wallet activity.");
  return BigInt(log.topics[1]);
}

/** Text a token returned (an ABI string, or bytes32 as some old tokens do), without control or direction characters. */
function decodeText(hex) {
  const all = words(hex);
  let bytes;
  if (all.length === 1) bytes = all[0].replace(/(00)+$/, "");
  else {
    const at = Number(uint(all[0])) * 2;
    const length = Number(uint(hex.slice(2 + at, 2 + at + 64) || "0"));
    bytes = hex.slice(2 + at + 64, 2 + at + 64 + length * 2);
  }
  const text = new TextDecoder().decode(Uint8Array.from(bytes.match(/../g) ?? [], (b) => parseInt(b, 16)));
  return text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "");
}

/** Reads the chain at `rpcUrl`, where the deal contract is `contract`. */
export class Chain {
  constructor(rpcUrl, contract) {
    this.rpcUrl = rpcUrl;
    this.contract = contract;
    this.tokens = new Map();
  }

  async rpc(method, params, source = "read") {
    let payload;
    try {
      const response = await fetch(this.rpcUrl, { method: "POST", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (response.ok) payload = await response.json();
    } catch (error) {
      throw new ProviderError(source, error);
    }
    if (payload?.error || !payload || !Object.hasOwn(payload, "result")) {
      throw new ProviderError(source, payload?.error);
    }
    return payload.result;
  }

  /** Simulates a transaction when `from` is supplied. Otherwise reads contract state. */
  call(to, data, from, block = "latest") {
    return this.rpc("eth_call", [{ to, data, ...(from && { from }) }, block], from ? "preflight" : "read");
  }

  async deal(id) {
    const w = words(await this.call(this.contract, encode(SELECTOR.getDeal, id)));
    if (w.length !== 8) throw new AppError("The deal contract did not respond as expected. Verify that this site uses the deal’s network.");
    return {
      id, maker: address(w[0]), taker: address(w[1]), sellToken: address(w[2]), sellAmount: uint(w[3]),
      buyToken: address(w[4]), buyAmount: uint(w[5]), expiry: uint(w[6]), status: STATUS[Number(uint(w[7]))],
    };
  }

  /** `{ address, symbol, decimals }` of the token at `token`; throws if no token answers there. */
  token(token) {
    const key = token.toLowerCase();
    if (!this.tokens.has(key)) {
      const info = Promise.all([this.call(key, SELECTOR.decimals), this.call(key, SELECTOR.symbol).catch(() => null)]).then(([decimals, symbol]) => {
        if (!/^0x0{62}[0-9a-f]{2}$/i.test(decimals)) throw new AppError("A token did not return its decimals. Verify the token contracts on this network.");
        return { address: key, decimals: Number(decimals), symbol: symbol ? decodeText(symbol) : "" };
      });
      info.catch(() => this.tokens.delete(key)); // a failed look-up is tried again next time
      this.tokens.set(key, info);
    }
    return this.tokens.get(key);
  }

  async balanceOf(token, owner, block) {
    return uint(words(await this.call(token, encode(SELECTOR.balanceOf, owner), undefined, block))[0] ?? "0");
  }

  async allowance(token, owner, block) {
    return uint(words(await this.call(token, encode(SELECTOR.allowance, owner, this.contract), undefined, block))[0] ?? "0");
  }

  /** The time of the latest block, in unix seconds. */
  async now() {
    return Number((await this.rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  }

  /** The receipt of transaction `hash`, once it is in a block. */
  async receipt(hash) {
    for (let waited = 0, pause = 250; waited < 600_000; waited += pause, pause = Math.min(pause * 2, 3000)) {
      const receipt = await this.rpc("eth_getTransactionReceipt", [hash], "receipt");
      if (receipt) return receipt;
      await sleep(pause);
    }
    throw new AppError("The transaction is still unconfirmed. Check your wallet activity before trying again.");
  }
}

/** The browser's wallet. `onChange` runs when its account or its network changes. */
export class Wallet {
  constructor(provider, onChange) {
    this.provider = provider;
    this.account = null;
    this.chainId = null;
    provider.on?.("accountsChanged", (accounts) => {
      this.account = accounts[0]?.toLowerCase() ?? null;
      onChange();
    });
    provider.on?.("chainChanged", (chainId) => {
      this.chainId = Number(chainId);
      onChange();
    });
    this.ready = Promise.all([
      this.request({ method: "eth_accounts" }).then((accounts) => (this.account = accounts[0]?.toLowerCase() ?? null)),
      this.readChain(),
    ]).catch(() => {});
  }

  async request(request) {
    try {
      return await this.provider.request(request);
    } catch (error) {
      throw new ProviderError("wallet", error);
    }
  }

  async readChain() {
    this.chainId = Number(await this.request({ method: "eth_chainId" }));
  }

  async connect() {
    const accounts = await this.request({ method: "eth_requestAccounts" });
    this.account = accounts[0]?.toLowerCase() ?? null;
    await this.readChain();
  }

  async switchTo(chainId) {
    await this.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
    await this.readChain();
  }

  /** Sends `{ to, data }` from the connected account on chain `chainId`, and returns the transaction's hash. */
  async send(tx, chainId, from = this.account) {
    const [accounts] = await Promise.all([this.request({ method: "eth_accounts" }), this.readChain()]);
    if (this.chainId !== chainId) throw new AppError("Your wallet changed network. Switch it back, then try again.");
    if (!from || !same(from, accounts[0]) || !same(from, this.account)) {
      throw new AppError("Your wallet account changed. Check the connected address and try again.");
    }
    return this.request({ method: "eth_sendTransaction", params: [{ from, ...tx }] });
  }
}

/**
 * Sends `data` to `to` from the app's wallet, once a call has shown that the chain would take it, and waits until it
 * is mined. `stage(text)` tells the person where it stands. A transaction the chain would refuse is never sent.
 */
export async function transact({ chain, wallet, config }, to, data, stage, what) {
  const from = wallet.account;
  await chain.call(to, data, from);
  stage(`${what}. Confirm it in your wallet.`);
  const hash = await wallet.send({ to, data }, config.chainId, from);
  stage(`${what}. Sent: waiting for the network to confirm it.`);
  const receipt = await chain.receipt(hash);
  if (receipt.status !== "0x1") throw new AppError("The transaction failed on the chain, and nothing moved. Try again.");
  return receipt;
}

/** Approves the deal contract for exactly `units` of `token`, the amount of one deal and never more. */
export async function approveExactly(app, token, units, allowance, stage) {
  const data = approveData(app.config.contract, units);
  // Some tokens (USDT among them) refuse to change an approval that is not zero: it is set to zero first.
  if (allowance > 0n && (await app.chain.call(token.address, data, app.wallet.account).then(() => false, () => true))) {
    await transact(app, token.address, approveData(app.config.contract, 0n), stage, `Setting your ${token.symbol} approval to zero first`);
  }
  await transact(app, token.address, data, stage, `Approving ${formatAmount(units, token.decimals)} ${token.symbol}`);
}

// Known contract error selectors map to app-authored messages.
const REASONS = {
  "0x1f2a2005": "Both amounts must be more than zero.", // ZeroAmount()
  "0x201b580a": "The token you give and the token you get must be different.", // SameToken()
  "0xed8adeb1": "The deal must end in the future.", // ExpiryNotInFuture()
  "0xf0ae59ab": "Verify both token contract addresses on this network.", // NotAToken(address)
  "0x48a4274a": "A token does not move exactly the amount asked. Check whether either token charges a transfer fee.", // InexactTransfer(address)
  "0x341b372a": "This deal is no longer open: it was filled or cancelled.", // NotOpen(uint256)
  "0x4877925c": "This deal has expired: it can no longer be filled.", // DealExpired(uint256)
  "0x64c4c47b": "Only the reserved wallet can fill this deal. Check the address shown in the deal terms.", // NotYourDeal(uint256,address)
  "0x9f220883": "Only the maker of this deal can cancel it.", // NotMaker(uint256)
  "0x39f1c8d9": "A token refused the transfer. Check the balance and approval.", // TransferFailed(address)
  "0xb1df0e06": "Enter a designated buyer address different from the seller or escrow.",
  "0xdba16ce8": "The vesting schedule is out of range. The duration must be greater than the cliff.",
  "0x85e05e45": "The fixed UTC start must still be in the future at settlement.",
  "0xd5ef09ba": "The deal has already been settled or cancelled.",
  "0x472e017e": "Only the designated buyer can settle this deal.",
  "0x5ec82351": "Only the seller can reclaim this allocation.",
  "0xe4614c8a": "The quote plus the buyer fee exceeds the maximum raw token amount.",
  "0x969bf728": "No additional tokens are currently claimable.",
  "0xb5dfd9e5": "A token tried to call the deal contract back during its transfer: refused.", // Reentered()
};

/** Translate provider failures without displaying provider-supplied text or revert arguments. */
export function explain(error, fallback = "action") {
  if (error instanceof AppError) return error.message;
  const source = error instanceof ProviderError ? error.source : fallback;
  if (source === "read") return "Could not read the network. Check your connection and try again.";
  if (source === "receipt") return "Could not confirm the transaction. Check your wallet activity before trying again.";
  const cause = error instanceof ProviderError ? error.cause : error;
  const details = [cause, cause?.data?.originalError, cause?.error, cause?.info?.error];
  const codes = details.flatMap((entry) => entry?.code === undefined ? [] : [String(entry.code)]);

  if (codes.includes("4001") || codes.includes("ACTION_REJECTED")) return "You declined in your wallet. Nothing was sent.";
  if (codes.includes("4902")) return "Your wallet does not know this network yet. Add it in your wallet, then try again.";
  if (codes.includes("4900") || codes.includes("4901")) return "Reconnect your wallet to the deal’s network and try again.";
  if (codes.includes("4100")) return "Allow this site to use the correct account in your wallet, then try again.";
  if (source === "wallet" && codes.includes("-32002")) return "Open your wallet and complete the pending request before trying again.";

  const revert = details.flatMap((entry) => [entry?.data, entry?.data?.data])
    .find((value) => typeof value === "string" && /^0x[0-9a-f]{8}/i.test(value));
  const known = REASONS[revert?.slice(0, 10).toLowerCase()];
  if (known) return known;
  const outOfGasFunds = details.some((entry) => typeof entry?.message === "string"
    && /insufficient funds|insufficient balance for (?:gas|transfer)|doesn.t have enough funds|gas required exceeds allowance/i.test(entry.message));
  if (codes.includes("INSUFFICIENT_FUNDS") || outOfGasFunds) {
    return "This wallet needs more of the network’s gas token. Add gas funds and try again.";
  }
  if (revert || codes.includes("3")) return "The transaction would fail on the chain. Review the deal and try again.";
  if (source === "wallet") return "Your wallet could not complete the request. Check its network and activity before trying again.";
  if (source === "preflight") return "The network could not check this transaction. Refresh the deal and try again.";
  return "Something went wrong. Check the current deal and try again.";
}
