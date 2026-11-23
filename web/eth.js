// The chain, as the page uses it: reads by JSON-RPC at the config's rpcUrl (no wallet needed), transactions through
// the browser's wallet (window.ethereum, EIP-1193). The few ABI encodings the page needs are written by hand: every
// argument it sends is one 32-byte word, and every answer it reads is words, or a string for symbol().
import { formatAmount } from "./units.js";

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

export const word = (value) => BigInt(value).toString(16).padStart(64, "0");
export const encode = (selector, ...args) => selector + args.map(word).join("");
export const words = (hex) => (hex ?? "0x").slice(2).match(/.{64}/g) ?? [];
export const uint = (w) => BigInt(`0x${w}`);
export const address = (w) => `0x${w.slice(24)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const approveData = (spender, amount) => encode(SELECTOR.approve, spender, amount);
export const fillData = (id) => encode(SELECTOR.fill, id);
export const cancelData = (id) => encode(SELECTOR.cancel, id);
export const createDealData = ({ sellToken, sellAmount, buyToken, buyAmount, taker, expiry }) =>
  encode(SELECTOR.createDeal, sellToken, sellAmount, buyToken, buyAmount, taker, expiry);

/** The id of the deal a createDeal transaction made, from its DealCreated event. */
export function createdId(receipt, contract) {
  const log = receipt.logs.find((l) => same(l.address, contract) && l.topics[0] === DEAL_CREATED);
  if (!log) throw new Error("The deal was sent, but its receipt names no new deal.");
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

  async rpc(method, params) {
    let response;
    try {
      response = await fetch(this.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new Error("The network cannot be reached. Check your connection and try again.");
    }
    if (!response.ok) throw new Error(`The network answered with an error (HTTP ${response.status}). Try again in a moment.`);
    const { result, error } = await response.json();
    if (error) throw Object.assign(new Error(error.message), { code: error.code, data: error.data });
    return result;
  }

  /** eth_call: what `to` answers to `data`, sent by `from`; throws the contract's reason if it would revert. */
  call(to, data, from, block = "latest") {
    return this.rpc("eth_call", [{ to, data, ...(from && { from }) }, block]);
  }

  async deal(id) {
    const w = words(await this.call(this.contract, encode(SELECTOR.getDeal, id)));
    if (w.length !== 8) throw new Error(`There is no deal contract at ${this.contract} on this network: the site's config.json may be wrong.`);
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
        if (!/^0x0{62}[0-9a-f]{2}$/i.test(decimals)) throw new Error("no decimals");
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
      const receipt = await this.rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) return receipt;
      await sleep(pause);
    }
    throw new Error(`The transaction ${hash} is still not confirmed after 10 minutes. Check it in your wallet's activity.`);
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
      provider.request({ method: "eth_accounts" }).then((accounts) => (this.account = accounts[0]?.toLowerCase() ?? null)),
      this.readChain(),
    ]).catch(() => {});
  }

  async readChain() {
    this.chainId = Number(await this.provider.request({ method: "eth_chainId" }));
  }

  async connect() {
    const accounts = await this.provider.request({ method: "eth_requestAccounts" });
    this.account = accounts[0]?.toLowerCase() ?? null;
    await this.readChain();
  }

  async switchTo(chainId) {
    await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
    await this.readChain();
  }

  /** Sends `{ to, data }` from the connected account on chain `chainId`, and returns the transaction's hash. */
  async send(tx, chainId, account = this.account) {
    await this.readChain();
    if (this.chainId !== chainId) throw new Error("Your wallet changed network. Switch it back, then try again.");
    if (!account || !same(account, this.account)) throw new Error("Your wallet changed accounts. Check the address and try again.");
    return this.provider.request({ method: "eth_sendTransaction", params: [{ from: account, ...tx }] });
  }
}

/**
 * Sends `data` to `to` from the app's wallet, once a call has shown that the chain would take it, and waits until it
 * is mined. `stage(text)` tells the person where it stands. A transaction the chain would refuse is never sent.
 */
export async function transact({ chain, wallet, config, waitForReceipt }, to, data, stage, what, from = wallet.account) {
  const submittedAfter = waitForReceipt ? (await chain.snapshot()).block : undefined;
  if (!from || !same(wallet.account, from)) throw new Error("Your wallet changed accounts. Check the address and try again.");
  await chain.call(to, data, from);
  stage(`${what}. Confirm it in your wallet.`);
  const hash = await wallet.send({ to, data }, config.chainId, from);
  stage(`${what}. Sent: waiting for the network to confirm it.`);
  return waitForReceipt ? waitForReceipt({ hash, from, to, data, submittedAfter }) : checkReceipt(await chain.receipt(hash));
}

export function checkReceipt(receipt) {
  if (receipt.status !== "0x1") {
    throw Object.assign(new Error("The transaction failed on the chain, and nothing moved. Try again."), {
      transactionHash: receipt.transactionHash,
    });
  }
  return receipt;
}

/** Approves the deal contract for exactly `units` of `token`, the amount of one deal and never more. */
export async function approveExactly(app, token, units, allowance, stage) {
  const from = app.wallet.account;
  const data = approveData(app.config.contract, units);
  // Some tokens (USDT among them) refuse to change an approval that is not zero: it is set to zero first.
  if (allowance > 0n && (await app.chain.call(token.address, data, from).then(() => false, () => true))) {
    await transact(app, token.address, approveData(app.config.contract, 0n), stage, `Setting your ${token.symbol} approval to zero first`, from);
  }
  return transact(app, token.address, data, stage, `Approving ${formatAmount(units, token.decimals)} ${token.symbol}`, from);
}

// Why the deal contract refused a call, in words: its errors by selector, with their arguments' words.
const REASONS = {
  "0x1f2a2005": () => "Both amounts must be more than zero.", // ZeroAmount()
  "0x201b580a": () => "The token you give and the token you get must be different.", // SameToken()
  "0xed8adeb1": () => "The deal must end in the future.", // ExpiryNotInFuture()
  "0xf0ae59ab": ([token]) => `${address(token)} is not a token contract on this network.`, // NotAToken(address)
  "0x48a4274a": ([token]) => `The token ${address(token)} does not move exactly the amount asked (it keeps a fee, or charges one on top), so deals in it cannot go through.`, // InexactTransfer(address)
  "0x341b372a": () => "This deal is no longer open: it was filled or cancelled.", // NotOpen(uint256)
  "0x4877925c": () => "This deal has expired: it can no longer be filled.", // DealExpired(uint256)
  "0x64c4c47b": ([, taker]) => `This deal is reserved for ${address(taker)}: only that address can fill it.`, // NotYourDeal(uint256,address)
  "0x9f220883": () => "Only the maker of this deal can cancel it.", // NotMaker(uint256)
  "0x39f1c8d9": ([token]) => `The token ${address(token)} refused the transfer: check the balance and the approval.`, // TransferFailed(address)
  "0xb5dfd9e5": () => "A token tried to call the deal contract back during its transfer: refused.", // Reentered()
  "0xb1df0e06": () => "Enter a different, nonzero buyer address.", // InvalidBuyer()
  "0xdba16ce8": () => "The vesting schedule is outside the supported range.", // InvalidSchedule()
  "0xab36a7f4": () => "The fixed start has arrived. A funded deal with this start can only be refunded.", // FixedStartReached()
  "0xe4614c8a": () => "The quote plus the buyer fee is too large.", // QuoteTooLarge()
  "0xc7ad864e": () => "The contract's token balance is below its reserved allocation.", // InsufficientBacking(address)
  "0x969bf728": () => "There are no new units available to claim.", // NothingToClaim()
};

/** Revert data in an error, wherever the node (geth: data; Hardhat: data.data) or the wallet put it. */
function revertData(error) {
  const places = [error?.data, error?.data?.data, error?.data?.originalError?.data, error?.error?.data, error?.info?.error?.data];
  return places.find((value) => typeof value === "string" && /^0x[0-9a-f]{8}/i.test(value)) ?? null;
}

/** What went wrong, for the person: a refusal in their wallet, the deal contract's reason, or the error's own words. */
export function explain(error) {
  if (Number(error?.code) === 4001) return "You declined in your wallet. Nothing was sent.";
  if (Number(error?.code) === 4902) return "Your wallet does not know this network yet. Add it in your wallet, then try again.";
  if (error?.code === "INSUFFICIENT_FUNDS" || /insufficient funds|cannot afford|enough (ether|eth) to pay/i.test(error?.message ?? "")) {
    return "This wallet needs more native currency to pay the network fee.";
  }
  const data = revertData(error);
  if (data) {
    const reason = REASONS[data.slice(0, 10)];
    if (reason) return reason(words(`0x${data.slice(10)}`));
    if (data.startsWith("0x08c379a0")) return `The transaction would fail: ${decodeText(`0x${data.slice(10)}`)}.`; // Error(string)
    return "The transaction would fail on the chain, so it was not sent.";
  }
  if (Number.isInteger(Number(error?.code))) return "The network or wallet could not complete the request. Check your wallet and try again.";
  return String(error?.message ?? error).split("\n")[0];
}
