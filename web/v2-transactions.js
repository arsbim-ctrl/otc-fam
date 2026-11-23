import { checkReceipt, same } from "./eth.js";
import { hexQuantity } from "./eth-v2.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRACK_SECONDS = 18;
const RECENT_BLOCKS = 24n;

/** Tracks the wallet submission on the read-only chain, including a same-nonce speed-up or cancellation. */
export function transactionTracker({ chain, config, wallet }, scope) {
  const key = `otc-v2:${config.chainId}:${config.contract}:${scope}`;
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(key));
  } catch {
    // Wallet webviews can disable storage. Tracking still works until the page is closed.
  }

  function store(record) {
    pending = record;
    try {
      if (record) sessionStorage.setItem(key, JSON.stringify(record));
      else sessionStorage.removeItem(key);
    } catch {}
  }

  async function withNonce(tx) {
    const method = "eth_getTransactionByHash", params = [tx.hash];
    const original = await chain.rpc(method, params).catch(() => null);
    const walletCopy = original ?? (wallet?.chainId === config.chainId
      ? await Promise.race([wallet.provider.request({ method, params }).catch(() => null), pause(500)])
      : null);
    if (walletCopy?.nonce && same(walletCopy.from, tx.from)) store({ ...tx, nonce: walletCopy.nonce });
  }

  async function replacement(tx) {
    if (!tx.nonce) return null;
    const { block } = await chain.snapshot();
    const nextNonce = await chain.rpc("eth_getTransactionCount", [tx.from, block]);
    if (BigInt(nextNonce) <= BigInt(tx.nonce)) return null;
    // Recheck the original after the nonce advanced to avoid racing a newly mined receipt.
    const original = await chain.rpc("eth_getTransactionReceipt", [tx.hash]);
    if (original) return original;
    const latest = BigInt(block), submitted = BigInt(tx.submittedAfter);
    const floor = submitted > latest - RECENT_BLOCKS ? submitted : latest - RECENT_BLOCKS;
    for (let n = latest; n >= floor && n >= 0n; n--) {
      const mined = await chain.rpc("eth_getBlockByNumber", [hexQuantity(n), true]);
      const match = mined?.transactions.find((entry) => same(entry.from, tx.from) && BigInt(entry.nonce) === BigInt(tx.nonce));
      if (!match) continue;
      if (same(match.to, tx.to) && same(match.input, tx.data) && BigInt(match.value) === 0n) {
        return chain.rpc("eth_getTransactionReceipt", [match.hash]);
      }
      throw Object.assign(new Error("The wallet replaced or cancelled this request. Review the current on-chain terms before retrying."), {
        transactionHash: match.hash,
      });
    }
    throw Object.assign(new Error("The wallet nonce has advanced. Check your wallet activity and the current on-chain status."), {
      transactionHash: tx.hash,
    });
  }

  async function check(seconds = TRACK_SECONDS) {
    const until = Date.now() + seconds * 1000;
    try {
      do {
        const receipt = await chain.rpc("eth_getTransactionReceipt", [pending.hash]);
        if (receipt) {
          store(null);
          return checkReceipt(receipt);
        }
        if (!pending.nonce) await withNonce(pending);
        const mined = await replacement(pending);
        if (mined) {
          store(null);
          return checkReceipt(mined);
        }
        if (Date.now() >= until) break;
        await pause(1500);
      } while (Date.now() < until);
    } catch (error) {
      if (error.transactionHash) store(null);
      throw error;
    }
    return null;
  }

  return {
    get pending() { return pending; },
    check,
    async waitForReceipt(tx, action) {
      store({ ...tx, action });
      const receipt = await check();
      if (!receipt) throw new Error("Confirmation is pending. Check this transaction before sending another.");
      return receipt;
    },
  };
}
