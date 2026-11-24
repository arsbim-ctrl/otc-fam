// The chain, as the page uses it: reads by JSON-RPC at the config's rpcUrl (no wallet needed), transactions through
// the browser's wallet (window.ethereum, EIP-1193). The few ABI encodings the page needs are written by hand: every
// argument it sends is one 32-byte word, and every answer it reads is words, or a string for symbol().
import { formatAmount } from "./units.js";

export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

// keccak256 of each signature, first 4 bytes (test/abi.test.mjs checks them against the compiled contract).
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

/** An error whose message is already a sentence for the person: explain() shows it as it is. */
export const say = (message, more) => Object.assign(new Error(message), { plain: true }, more);

export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const approveData = (spender, amount) => encode(SELECTOR.approve, spender, amount);
export const fillData = (id) => encode(SELECTOR.fill, id);
export const cancelData = (id) => encode(SELECTOR.cancel, id);
export const createDealData = ({ sellToken, sellAmount, buyToken, buyAmount, taker, expiry }) =>
  encode(SELECTOR.createDeal, sellToken, sellAmount, buyToken, buyAmount, taker, expiry);

/** The id of the deal a createDeal transaction made, from its DealCreated event. */
export function createdId(receipt, contract) {
  const log = receipt.logs.find((l) => same(l.address, contract) && l.topics[0] === DEAL_CREATED);
  if (!log) throw say("The deal was sent, but its receipt names no new deal.");
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

/** Reads the chain at `rpcUrl`, where the round 1 deal contract is `contract`. */
export class Chain {
  constructor(rpcUrl, contract) {
    this.rpcUrl = rpcUrl;
    this.contract = contract;
    this.tokens = new Map();
  }

  async rpc(method, params) {
    let response;
    try {
      response = await fetch(this.rpcUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    } catch {
      throw say("The network cannot be reached. Check your connection and try again.");
    }
    if (!response.ok) throw say(`The network answered with an error (HTTP ${response.status}). Try again in a moment.`);
    const { result, error } = await response.json();
    if (error) throw Object.assign(new Error(error.message), { code: error.code, data: error.data });
    return result;
  }

  /** eth_call: what `to` answers to `data`, sent by `from`; throws the contract's reason if it would revert. */
  call(to, data, from) {
    return this.rpc("eth_call", [{ to, data, ...(from && { from }) }, "latest"]);
  }

  async deal(id) {
    const w = words(await this.call(this.contract, encode(SELECTOR.getDeal, id)));
    if (w.length !== 8) throw say(`There is no deal contract at ${this.contract} on this network: the site's config.json may be wrong.`);
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
        if (!/^0x0{62}[0-9a-f]{2}$/i.test(decimals)) throw say(`No token answers at ${key} on this network.`);
        return { address: key, decimals: Number(decimals), symbol: symbol ? decodeText(symbol) : "" };
      });
      info.catch(() => this.tokens.delete(key)); // a failed look-up is tried again next time
      this.tokens.set(key, info);
    }
    return this.tokens.get(key);
  }

  async balanceOf(token, owner, block = "latest") {
    const data = encode(SELECTOR.balanceOf, owner);
    return uint(words(await this.rpc("eth_call", [{ to: token, data }, block]))[0] ?? "0");
  }

  /** What `owner` lets `spender` (the round 1 deal contract unless given) take of `token`. */
  async allowance(token, owner, spender = this.contract) {
    return uint(words(await this.call(token, encode(SELECTOR.allowance, owner, spender)))[0] ?? "0");
  }

  /** The latest block, including its hash and its time in unix seconds. */
  async block() {
    const { number, timestamp, hash } = await this.rpc("eth_getBlockByNumber", ["latest", false]);
    return { number: Number(number), time: Number(timestamp), hash };
  }

  /** The time of the latest block, in unix seconds. */
  async now() {
    return (await this.block()).time;
  }

  /**
   * The receipt of transaction `hash`, once it is in a block. `from` and `nonce` (the sender, and the number the
   * transaction was sent with) let it notice a transaction that the wallet replaced: it fails then, with `replaced`.
   * A replacement is said only after three looks in a row found one, over a second at least: a node that lags
   * behind another for a moment is not one.
   */
  async receipt(hash, from, nonce = null) {
    for (let waited = 0, pause = 250, gone = 0; waited < 600_000; waited += pause, pause = Math.min(pause * 2, 3000)) {
      const receipt = await this.rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) return receipt;
      gone = from && (await this.overtaken(hash, from, nonce)) ? gone + 1 : 0;
      if (gone >= 3) {
        throw say("Your wallet replaced this transaction (it was sped up or cancelled), so this page cannot follow it. "
          + "The page has read the chain again: what it shows now is what happened.", { replaced: true });
      }
      await sleep(pause);
    }
    throw say(`The transaction ${hash} is still not confirmed after 10 minutes. Check it in your wallet's activity.`);
  }

  /** Whether `from` has sent a later transaction into a block while `hash` is still in none: another one took its place. */
  async overtaken(hash, from, nonce) {
    try {
      const [sent, count] = await Promise.all([this.rpc("eth_getTransactionByHash", [hash]), this.rpc("eth_getTransactionCount", [from, "latest"])]);
      if (sent?.blockNumber) return false; // it is in a block: its receipt is next
      const used = sent ? BigInt(sent.nonce) : nonce;
      return used !== null && BigInt(count) > used;
    } catch {
      return false;
    }
  }

  /** The receipt of `hash` once it is in a block and succeeded; fails, in words, if it failed there or was replaced. */
  async confirmed(hash, from, nonce) {
    const receipt = await this.receipt(hash, from, nonce);
    if (receipt.status !== "0x1") throw say("The transaction failed on the chain, and nothing moved. Try again.", { reverted: true });
    return receipt;
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
  async send(tx, chainId) {
    await this.readChain();
    if (this.chainId !== chainId) throw say("Your wallet changed network. Switch it back, then try again.");
    return this.provider.request({ method: "eth_sendTransaction", params: [{ from: this.account, ...tx }] });
  }

  /** The number (nonce) transaction `hash` was sent with, as the wallet's own node knows it; null if it does not say. */
  nonceOf(hash) {
    return this.provider.request({ method: "eth_getTransactionByHash", params: [hash] }).then((sent) => (sent?.nonce == null ? null : BigInt(sent.nonce)), () => null);
  }
}

const NO_FEE = "This wallet has too little of the network's own coin (ETH) to pay the network fee. Add some to it, then try again. Nothing was sent.";

/**
 * Sends `data` to `to` from the app's wallet, once a call has shown that the chain would take it, and waits until it
 * is mined. `stage(text)` tells the person where it stands, and `sent(hash, nonce)`, if given, runs as soon as the
 * wallet has sent it. A transaction the chain would refuse is never sent. Whether the wallet can pay the network
 * fee is the wallet's to say (some have it paid for them): its refusal is worded by explain().
 */
export async function transact({ chain, wallet, config }, to, data, stage, what, sent) {
  await chain.call(to, data, wallet.account);
  const count = await chain.rpc("eth_getTransactionCount", [wallet.account, "latest"]).then(BigInt, () => null);
  stage(`${what}. Confirm it in your wallet.`);
  const hash = await wallet.send({ to, data }, config.chainId);
  // The wallet's node knows the number it gave the transaction; failing that, the account's count before it was sent.
  const nonce = (await wallet.nonceOf(hash)) ?? count;
  sent?.(hash, nonce, wallet.account);
  stage(`${what}. Sent: waiting for the network to confirm it.`);
  return chain.confirmed(hash, wallet.account, nonce);
}

/** Approves `spender` (the round 1 deal contract unless given) for exactly `units` of `token`: one deal's amount, never more. */
export async function approveExactly(app, token, units, allowance, stage, spender = app.config.contract) {
  const data = approveData(spender, units);
  // Some tokens (USDT among them) refuse to change an approval that is not zero: it is set to zero first.
  if (allowance > 0n && (await app.chain.call(token.address, data, app.wallet.account).then(() => false, () => true))) {
    await transact(app, token.address, approveData(spender, 0n), stage, `Setting your ${token.symbol} approval to zero first`);
  }
  await transact(app, token.address, data, stage, `Approving ${formatAmount(units, token.decimals)} ${token.symbol}`);
}

// Why a deal contract refused a call, in words: its errors by selector, with their arguments' words. The first eleven
// are the round 1 contract's; the v2 contract shares five of them and adds the rest.
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
  "0xe4614c8a": () => "That price is too large for the fee to be added to it.", // QuoteTooLarge()
  "0xf7a5e3f8": () => "A deal needs the buyer's address: only that address can settle it.", // NoBuyer()
  "0x61835059": () => "The buyer must be another address than the seller's.", // BuyerIsSeller()
  "0xe7ebb51b": () => "Immediate delivery takes no vesting schedule.", // ScheduleOnImmediate()
  "0xd868b83a": () => "The vesting must last more than zero seconds, and its cliff must be shorter than the whole vesting.", // BadSchedule()
  "0xe8d4723a": () => "A fixed vesting start must be in the future.", // StartNotInFuture()
  "0x15a7d4e1": () => "That vesting schedule ends too far in the future to be written on the chain.", // ScheduleTooLong()
  "0x6a06b652": () => "This deal is not waiting for settlement: it was settled or cancelled, or it does not exist.", // NotFunded(uint256)
  "0x038b4585": () => "This deal's fixed vesting start has passed, so it can no longer be settled. Its seller can cancel it and take the tokens back.", // StartPassed(uint256)
  "0x8f1e0b3a": ([, buyer]) => `This deal is for ${address(buyer)}: only that address can settle it.`, // NotBuyer(uint256,address)
  "0xa7e67778": () => "Only the seller of this deal can cancel it.", // NotSeller(uint256)
  "0xc8e7093a": () => "Only the grant's beneficiary can claim it.", // NotBeneficiary(uint256)
  "0xf9489585": () => "Nothing has vested since the last claim: there is nothing to claim yet.", // NothingToClaim(uint256)
};

// What a wallet or a node says in its own words when it refuses, and the sentence the page says instead.
const REFUSALS = [
  [/insufficient funds|enough funds|insufficient balance|gas required exceeds|exceeds (the )?balance/i, NO_FEE],
  [/user (rejected|denied|cancel)|request rejected|rejected by user/i, "You declined in your wallet. Nothing was sent."],
  [/nonce too low|underpriced|already known|already (pending|imported)/i, "Your wallet already has a transaction waiting for the network. Let it finish, or cancel it in your wallet, then try again."],
  [/already processing|request of type .* already pending/i, "Your wallet already has a request open. Answer it there, then try again."],
  [/^(?:execution reverted|revert|transaction reverted)(?:[.!])?$/i, "The transaction would fail on the chain, so it was not sent."],
  [/timed? ?out|failed to fetch|fetch failed|network ?error|disconnect|unreachable|econn/i, "The network cannot be reached. Check your connection and try again."],
  [/unauthori[sz]ed|not connected|locked/i, "Your wallet is locked or not connected to this page. Unlock it, connect, then try again."],
];

/** Revert data in an error, wherever the node (geth: data; Hardhat: data.data) or the wallet put it. */
function revertData(error) {
  const places = [error?.data, error?.data?.data, error?.data?.originalError?.data, error?.error?.data, error?.info?.error?.data];
  return places.find((value) => typeof value === "string" && /^0x[0-9a-f]{8}/i.test(value)) ?? null;
}

/**
 * What went wrong, for the person: always a plain sentence. A refusal in their wallet, a deal contract's reason, the
 * page's own words, a known refusal, or the message returned by the node.
 */
export function explain(error) {
  if (error?.plain) return error.message;
  if (error?.code === 4001) return "You declined in your wallet. Nothing was sent.";
  if (error?.code === 4902) return "Your wallet does not know this network yet. Add it in your wallet, then try again.";
  const data = revertData(error);
  if (data) {
    const reason = REASONS[data.slice(0, 10)];
    if (reason) return reason(words(`0x${data.slice(10)}`));
    if (data.startsWith("0x08c379a0")) return `The transaction would fail: ${decodeText(`0x${data.slice(10)}`)}.`; // Error(string)
  }
  const raw = String(error?.message ?? error ?? "");
  return REFUSALS.find(([pattern]) => pattern.test(raw))?.[1] ?? (raw || "The wallet or network refused this request. Try again in a moment.");
}
