import { fundedId } from "./vesting.js";
import { same } from "./eth.js";

const hashPattern = /^0x[0-9a-f]{64}$/i;
const memory = new Set();
const prefix = (config, account) => `otc:funding:${config.chainId}:${config.contract.toLowerCase()}:${account.toLowerCase()}:`;

// One storage key per broadcast, so two tabs never overwrite each other's link.
export function rememberFunding(config, account, hash) {
  if (!hashPattern.test(hash)) throw new Error("The wallet returned an invalid transaction hash.");
  const key = prefix(config, account) + hash;
  memory.add(key);
  try { localStorage.setItem(key, hash); } catch { /* The receipt URL also works without storage. */ }
}

export function fundingHistory(config, account) {
  if (!account) return [];
  const scope = prefix(config, account);
  const hashes = new Set();
  function collect(key) {
    if (key?.startsWith(scope) && hashPattern.test(key.slice(scope.length))) hashes.add(key.slice(scope.length));
  }
  for (const key of memory) collect(key);
  try {
    for (let i = 0; i < localStorage.length; i++) collect(localStorage.key(i));
  } catch { /* Use this page's broadcasts when storage is unavailable. */ }
  return [...hashes];
}

export async function fundingReceipt(chain, hash) {
  if (!hashPattern.test(hash)) throw new Error("Check the funding transaction hash.");
  const receipt = await chain.rpc("eth_getTransactionReceipt", [hash]);
  if (!receipt) return { state: "Pending" };
  if (!same(receipt.to, chain.contract) || !same(receipt.transactionHash, hash))
    throw new Error("This receipt does not match the funding transaction and contract.");
  if (BigInt(receipt.status) === 0n) return { state: "Failed" };
  return { state: "Funded", id: fundedId(receipt, chain.contract) };
}
