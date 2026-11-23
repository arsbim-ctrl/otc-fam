import { AppError, same } from "./eth.js";
import { quantity } from "./v2-chain.js";

const ZERO_VALUE = "0x0";
const MAX_REPLACEMENT_BLOCKS = 24;

export function tabStorage(key) {
  return {
    get() {
      try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
    },
    set(value) {
      try {
        if (value === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify(value));
      } catch { /* Reload recovery depends on browser storage. */ }
    },
  };
}

export async function sendV2({ chain, wallet, config }, { to = chain.contract, data, kind, from }) {
  const block = await chain.block();
  await chain.call(to, data, from, block.number);
  const hash = await wallet.send({ to, data }, config.chainId, from);
  return { kind, hash, to, data, from, firstBlock: block.number };
}

function matches(submission, transaction) {
  return same(submission.to, transaction.to) && same(submission.data, transaction.input)
    && BigInt(transaction.value ?? ZERO_VALUE) === 0n;
}

function outcome(receipt, replaced) {
  if (!receipt) return null;
  return { hash: receipt.transactionHash, receipt, status: receipt.status === "0x1" ? "confirmed" : "reverted", replaced };
}

/** Poll once, so an unconfirmed transaction can survive navigation or a temporary RPC error. */
export async function checkTransaction(chain, job, block) {
  const receipt = await chain.rpc("eth_getTransactionReceipt", [job.hash]);
  if (receipt) return outcome(receipt, false);

  if (job.replacement) {
    const replacementReceipt = await chain.rpc("eth_getTransactionReceipt", [job.replacement.hash]);
    if (replacementReceipt) return job.replacement.matches
      ? outcome(replacementReceipt, true)
      : { hash: job.replacement.hash, status: "replaced" };
  }

  if (job.nonce === undefined) {
    const original = await chain.rpc("eth_getTransactionByHash", [job.hash]);
    if (original && matches(job, original) && same(job.from, original.from)) job.nonce = original.nonce;
  }
  if (job.nonce === undefined) return null;

  const count = await chain.rpc("eth_getTransactionCount", [job.from, block.number]);
  if (BigInt(count) <= BigInt(job.nonce)) return null;

  const first = BigInt(job.firstBlock);
  const latest = BigInt(block.number);
  const windowStart = latest - BigInt(MAX_REPLACEMENT_BLOCKS) + 1n;
  const start = first > windowStart ? first : windowStart;
  for (let number = latest; number >= start; number--) {
    const candidate = await chain.rpc("eth_getBlockByNumber", [quantity(number), true]);
    const tx = candidate?.transactions.find((entry) => same(entry.from, job.from) && BigInt(entry.nonce) === BigInt(job.nonce));
    if (!tx) continue;
    if (!matches(job, tx)) return { hash: tx.hash, status: "replaced" };
    return outcome(await chain.rpc("eth_getTransactionReceipt", [tx.hash]), tx.hash !== job.hash);
  }
  // The nonce was used, but the RPC could no longer identify the mined transaction within the search window.
  job.uncertain = true;
  return null;
}

export async function identifyReplacement(chain, job, hash) {
  if (!/^0x[0-9a-f]{64}$/i.test(hash) || same(hash, job.hash)) {
    throw new AppError("Enter the new transaction hash from your wallet.");
  }
  await chain.verifyNetwork();
  const tx = await chain.rpc("eth_getTransactionByHash", [hash]);
  if (!tx || !same(tx.from, job.from)) throw new AppError("The new transaction was not found for this wallet on the configured network.");
  const sameAction = matches(job, tx);
  const sameNonce = job.nonce !== undefined && BigInt(job.nonce) === BigInt(tx.nonce);
  const oldBlock = tx.blockNumber !== null && tx.blockNumber !== undefined && BigInt(tx.blockNumber) < BigInt(job.firstBlock);
  if (oldBlock || (job.nonce === undefined ? !sameAction : !sameNonce)) {
    throw new AppError("The new transaction does not match this submission.");
  }
  return { hash: tx.hash, matches: sameAction };
}

export function transactionMessage(job, result) {
  if (result.status === "reverted") return { kind: "error", text: "The transaction reverted. No tokens moved. Review the current deal and try again." };
  if (result.status === "replaced") return { kind: "warn", text: "Your wallet replaced this transaction with a different action. Review the updated on-chain state." };
  const labels = {
    "reset-approval": "Previous token approval cleared. Approve the exact amount to continue.",
    approve: "Token approval confirmed.",
    fund: "Funding confirmed.",
    settle: "Settlement confirmed.",
    cancel: "Refund confirmed.",
    claim: "Claim confirmed.",
  };
  return { kind: "success", text: result.replaced ? `${labels[job.kind]} Your wallet changed the transaction hash.` : labels[job.kind] };
}
