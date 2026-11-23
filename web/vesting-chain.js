import { approveData, Chain, encode, explain, same, words, uint, address } from "./eth.js";

export const MAX_UINT = (1n << 256n) - 1n;
export const MAX_TIME = (1n << 64n) - 1n;
export const IMMEDIATE = 0;
export const NEW_VESTING = 1;

const STATUS = ["none", "funded", "settled", "cancelled"];
const FIELDS = ["baseToken", "quoteToken", "buyer", "allocation", "quote", "expiry", "delivery",
  "fixedStart", "cliffSeconds", "durationSeconds"];
const EVENTS = {
  "0x9294fa05cf234497458b8dc9e3cd8aaffbbc119a49d43f18739c7ebefc5ab81f": "Deal funded",
  "0xcc81a8771776afbb9e09d2740010d6c455c87cf93b32b0d7464effae6511af64": "Deal settled",
  "0x31b0c01e8429f81903c3f8adc204767b8efa7cfca91a00f3b4bb40ce63c8a206": "Allocation refunded",
  "0x55ce46f2fdb7a9f0f6cc90970ee0b6b9c91a80586e15ea8c6fa8cfba9d7fe359": "Grant created",
  "0x617847aec64ffd2e4a19d71c3e0062f744212a6f13486fec81d004b3a5c8fb2e": "Grant claimed",
};
const FUNDED_EVENT = Object.keys(EVENTS)[0];
const hex = (n) => "0x" + n.toString(16);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reasons = {
  "0x0256965f": "Check the buyer, amounts, tokens and expiry. The exact buyer total must fit in 256 bits.",
  "0xdba16ce8": "The cliff must be shorter than the duration, and the schedule must fit on-chain.",
  "0x85e05e45": "The fixed start has passed. The seller can refund this deal and create a new one.",
  "0xd5ef09ba": "This deal is no longer funded. Check its current on-chain status.",
  "0x269fad92": "This deal expired. The seller can still refund the escrow.",
  "0x472e017e": "Only the designated buyer can settle this deal.",
  "0x5ec82351": "Only the seller who funded this deal can refund it.",
  "0x969bf728": "Nothing is claimable at the latest block.",
};

export function v2Reason(error) {
  return reasons[error?.data?.data?.slice?.(0, 10) ?? error?.data?.slice?.(0, 10)] ?? explain(error);
}

export function economics(quote) {
  const fee = quote / 200n;
  return { fee, buyerTotal: quote + fee, sellerNet: quote - fee, feePool: 2n * fee };
}

export const createV2Data = (terms) => encode("0x54695758", ...FIELDS.map((field) => terms[field]));
export const claimData = (id) => encode("0x379607f5", id);

export function fundedId(receipt, contract) {
  const log = receipt.logs.find((event) => same(event.address, contract) && event.topics[0] === FUNDED_EVENT);
  if (!log) throw new Error("The receipt contains no funding event. Check your wallet activity before trying again.");
  return BigInt(log.topics[1]);
}

export class VestingChain extends Chain {
  constructor(rpcUrl, contract, deploymentBlock) {
    super(rpcUrl, contract);
    this.deploymentBlock = deploymentBlock ?? "earliest";
  }

  block() {
    return this.rpc("eth_getBlockByNumber", ["latest", false]);
  }

  async deal(id, block) {
    const w = words(await this.call(this.contract, encode("0x82fd5bac", id), undefined, block));
    if (w.length !== 13 || !STATUS[Number(uint(w[11]))]) {
      throw new Error("The configured contract does not answer the V2 interface on this network.");
    }
    return {
      seller: address(w[0]), baseToken: address(w[1]), quoteToken: address(w[2]), buyer: address(w[3]),
      allocation: uint(w[4]), quote: uint(w[5]), expiry: uint(w[6]), delivery: Number(uint(w[7])),
      fixedStart: uint(w[8]), cliffSeconds: uint(w[9]), durationSeconds: uint(w[10]),
      status: STATUS[Number(uint(w[11]))], grantId: uint(w[12]),
    };
  }

  async treasury(block) {
    const w = words(await this.call(this.contract, "0x61d027b3", undefined, block));
    if (w.length !== 1) throw new Error("The V2 treasury could not be read.");
    return address(w[0]);
  }

  async grant(id, block) {
    const read = (selector) => this.call(this.contract, encode(selector, id), undefined, block);
    const [grant, vested, claimable] = await Promise.all([read("0xb8cc6c93"), read("0x968fb8ba"), read("0xd1d58b25")]);
    const w = words(grant);
    if (w.length !== 9) throw new Error("The grant could not be read.");
    return {
      dealId: uint(w[0]), token: address(w[1]), beneficiary: address(w[2]), custodian: address(w[3]),
      allocation: uint(w[4]), start: uint(w[5]), cliff: uint(w[6]), end: uint(w[7]), claimed: uint(w[8]),
      vested: BigInt(vested), claimable: BigInt(claimable),
    };
  }

  async events(id, block) {
    const topics = [Object.keys(EVENTS), encode("0x", id)];
    const logs = await this.rpc("eth_getLogs", [{
      address: this.contract, fromBlock: this.deploymentBlock, toBlock: block, topics,
    }]);
    return logs.map((log) => ({
      name: EVENTS[log.topics[0]], hash: log.transactionHash,
      quantity: EVENTS[log.topics[0]] === "Grant claimed" ? BigInt(log.data) : null,
    }));
  }
}

/** Wallet approvals remain exact, including tokens that require a separate reset. */
export async function v2Approval(app, token, units, allowance) {
  const data = approveData(app.config.contract, units);
  if (!allowance) return data;
  const canSet = await app.chain.call(token.address, data, app.wallet.account).then(() => true, () => false);
  return canSet ? data : approveData(app.config.contract, 0n);
}

export async function sendV2(app, to, data, stage) {
  const { chain, wallet, config } = app;
  const from = wallet.account;
  if (!from) throw new Error("Connect a wallet first.");
  await chain.call(to, data, from);
  const [block, nonce] = await Promise.all([chain.block(), chain.rpc("eth_getTransactionCount", [from, "pending"])]);
  stage("Confirm the transaction in your wallet.");
  const hash = await wallet.send({ to, data }, config.chainId, from);
  return { hash, from, to, data, nonce, block: block.number };
}

/** Checks the original hash, then the sender's nonce for a mined replacement. */
export async function findReceipt(chain, pending) {
  const end = Date.now() + 12_000;
  let nonce = pending.nonce;
  do {
    const receipt = await chain.rpc("eth_getTransactionReceipt", [pending.hash]);
    if (receipt) return { receipt };
    const minedNonce = await chain.rpc("eth_getTransactionCount", [pending.from, "latest"]);
    const original = await chain.rpc("eth_getTransactionByHash", [pending.hash]);
    if (original) nonce = original.nonce;
    if (BigInt(minedNonce) > BigInt(nonce)) {
      const latest = await chain.block();
      const floor = BigInt(pending.block);
      for (let i = BigInt(latest.number), count = 0; i >= floor && count < 24; i--, count++) {
        const block = await chain.rpc("eth_getBlockByNumber", [hex(i), true]);
        const replacement = block?.transactions.find((tx) => same(tx.from, pending.from) && BigInt(tx.nonce) === BigInt(nonce));
        if (!replacement) continue;
        if (!same(replacement.to, pending.to) || !same(replacement.input, pending.data) ||
            BigInt(replacement.value ?? 0) !== 0n) {
          return { replaced: replacement.hash };
        }
        const replacementReceipt = await chain.rpc("eth_getTransactionReceipt", [replacement.hash]);
        if (replacementReceipt) return { receipt: replacementReceipt };
        break;
      }
    }
    await pause(500);
  } while (Date.now() < end);
  return {};
}
