import { verifyTypedData } from "ethers";
import { readHistory, writeHistory } from "./broker-history-cache.js";
import { same, say, ZERO_ADDRESS } from "./eth.js";
import { abi, digest, domainFor, roleNames, signingPayload, termsDecoded, types } from "./broker-terms.js";

const funded = abi.getEvent("BrokerDealFunded").topicHash;
const settled = abi.getEvent("BrokerDealSettled").topicHash;
const refunded = abi.getEvent("BrokerDealRefunded").topicHash;
const events = [funded, settled, refunded];
const statuses = ["unfunded", "funded", "settled", "refunded"];
const quantity = (value) => `0x${value.toString(16)}`;
function receiptFrom(log) {
  return {
    kind: log.topics[0] === funded ? "funded" : log.topics[0] === settled ? "settled" : "refunded",
    hash: log.transactionHash, block: Number(log.blockNumber), ...abi.parseLog(log).args.toObject(),
  };
}

export class BrokerChain {
  #history = new Map();
  #storage;
  #historyQueue = Promise.resolve();

  constructor(chain, { chainId, contractBroker, fromBlockBroker }, storage) {
    this.chain = chain;
    this.contract = contractBroker.toLowerCase();
    this.domain = domainFor(chainId, this.contract);
    this.fromBlock = fromBlockBroker;
    try { this.#storage = storage === undefined ? globalThis.localStorage : storage; } catch {}
  }

  async block() {
    const [id, block] = await Promise.all([this.chain.rpc("eth_chainId", []), this.chain.block()]);
    if (Number(id) !== this.domain.chainId) throw say(`The read network is on chain ${Number(id)}. Use a node for chain ${this.domain.chainId} before continuing.`);
    return block;
  }

  async read(name, arg, block) {
    const data = abi.encodeFunctionData(name, [arg]);
    const result = await this.chain.rpc("eth_call", [{ to: this.contract, data }, quantity(block)]);
    if (result === "0x") throw say(`BrokerDeals is unavailable at ${this.contract} on this chain. Check the deployment configuration.`);
    return abi.decodeFunctionResult(name, result);
  }

  async deal(id, block) {
    const [data, code, grantId] = await this.read("getDeal", id, block);
    const status = statuses[Number(code)];
    if (!status) throw say("The contract returned an unknown deal status. Check the broker deployment.");
    if (code === 0n) return { id, status, grantId, terms: null };
    const terms = termsDecoded(data);
    if (digest(this.domain, terms) !== id) throw say("The onchain terms did not match the deal ID. Check the broker deployment.");
    return { id, terms, status, grantId };
  }

  async grant(id, block) {
    const [grant] = await this.read("getGrant", id, block);
    if (same(grant.custodian, ZERO_ADDRESS)) throw say(`Vesting grant ${id} was not found at the deal contract. Refresh the chain view.`);
    const held = await this.chain.balanceOf(grant.token, grant.custodian, quantity(block)).catch(() => null);
    return { ...grant.toObject(), held };
  }

  async logs(topics, latest, expected = Infinity, earliest = this.fromBlock) {
    if (!Number.isSafeInteger(this.fromBlock) || this.fromBlock < 1) {
      throw say("Set fromBlockBroker to the BrokerDeals deployment block to read receipts and history.");
    }
    const floor = Math.max(this.fromBlock, earliest);
    const logs = [];
    for (let end = latest; end >= floor && logs.length < expected;) {
      const start = Math.max(floor, end - 1999);
      const batch = await this.chain.rpc("eth_getLogs", [{
        address: this.contract, fromBlock: quantity(start), toBlock: quantity(end), topics,
      }]);
      logs.push(...batch.filter((entry) => !entry.removed && same(entry.address, this.contract)));
      end = start - 1;
    }
    return logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  }

  async receipts(deal, block) {
    const expected = deal.status === "funded" ? 1 : 2;
    const all = await this.logs([events, deal.id], block, expected);
    if (all.length !== expected) throw say("The node did not return all confirmed deal events. Refresh to retry.");
    return all.map(receiptFrom);
  }

  activity(account) {
    // Read the head inside the queue so overlapping focus and storage events cannot move the cursor backward.
    const task = this.#historyQueue.then(async () => {
      const block = await this.block();
      try {
        const records = await this.#scanHistory(account.toLowerCase(), block);
        const entries = [...records.values()];
        entries.sort((a, b) => b.receipts[0].block - a.receipts[0].block);
        return { block, entries };
      } catch (error) {
        return { block, entries: [], error };
      }
    });
    this.#historyQueue = task.catch(() => {});
    return task;
  }

  async #scanHistory(account, block) {
    if (!block.hash) throw say("The node did not identify the history block. Refresh history to retry.");
    const memory = this.#history.get(account);
    const stored = memory ? null : readHistory(this.#storage, this.domain, account, this.fromBlock);
    const previous = memory ?? stored;
    const sameHead = previous?.block.hash === block.hash && previous.block.number === block.number;
    if (memory && sameHead) return memory.records;
    const blockHash = async (number) => (await this.chain.rpc("eth_getBlockByNumber", [quantity(number), false]))?.hash;
    const extendsHistory = previous && previous.block.number < block.number
      && await blockHash(previous.block.number) === previous.block.hash;
    const canonical = sameHead || extendsHistory;
    const records = canonical ? previous.records : new Map();
    const first = canonical ? previous.block.number + 1 : this.fromBlock;
    // On reload, verify every saved deal at this head even if the cursor did not move.
    const changed = stored && canonical
      ? new Map([...records].map(([id, { receipts }]) => [id, [...receipts]])) : new Map();
    if (!sameHead) {
      for (const log of await this.logs([events], block.number, Infinity, first)) {
        const entry = receiptFrom(log);
        if (!changed.has(entry.dealId)) changed.set(entry.dealId, [...(records.get(entry.dealId)?.receipts ?? [])]);
        changed.get(entry.dealId).push(entry);
      }
    }
    const updates = new Map();
    const ids = [...changed.keys()];
    for (let i = 0; i < ids.length; i += 16) {
      await Promise.all(ids.slice(i, i + 16).map(async (id) => {
        const deal = await this.deal(id, block.number);
        if (!deal.terms || !roleNames(deal.terms, account).length) {
          updates.set(id, null);
          return;
        }
        let receipts = changed.get(id);
        const last = receipts.at(-1);
        if (receipts[0]?.kind !== "funded" || last?.kind !== deal.status
            || receipts.length !== (deal.status === "funded" ? 1 : 2)
            || (last.kind === "settled" && last.grantId !== deal.grantId)) {
          receipts = await this.receipts(deal, block.number);
        }
        updates.set(id, { deal, receipts });
      }));
    }
    // Commit the new cache only after all reads agree on the same head.
    if (await blockHash(block.number) !== block.hash) throw say("The chain changed while reading history. Refresh history to retry.");
    for (const [id, entry] of updates) {
      if (entry) records.set(id, entry);
      else records.delete(id);
    }
    this.#history.set(account, { block, records });
    if (block.number >= this.fromBlock) writeHistory(this.#storage, this.domain, account, this.fromBlock, block, records);
    return records;
  }
}

export async function signTerms(wallet, domain, terms, expected) {
  const payload = JSON.stringify(signingPayload(domain, terms));
  const signature = await wallet.provider.request({ method: "eth_signTypedData_v4", params: [expected, payload] });
  let signer;
  try { signer = verifyTypedData(domain, types, terms, signature); } catch {}
  if (!same(signer, expected)) throw say(`The signature does not match ${expected} and these exact terms. Switch to that wallet and retry.`);
  return signature;
}

export function brokerError(error, terms) {
  const raw = error?.data?.data ?? error?.data?.originalError?.data ?? error?.data ?? error?.error?.data;
  let parsed;
  try { parsed = abi.parseError(raw); } catch {}
  if (!parsed) return error;
  const messages = {
    NonceUsed: () => `Seller nonce ${parsed.args[0]} has already been used. Ask the broker to duplicate the terms with a new nonce.`,
    InvalidTerms: () => {
      const field = parsed.args[0];
      return `The contract refused ${field}${terms[field] === undefined ? "" : ` (${terms[field]})`}. Ask the broker for corrected terms.`;
    },
    InvalidSignature: () => `The contract needs a signature from ${parsed.args[0]} over these exact terms. Check the wallet and try again.`,
    WrongActor: () => `This step requires wallet ${parsed.args[0]}. Switch accounts and try again.`,
    WrongStatus: () => `The chain shows this deal as ${statuses[Number(parsed.args[0])]}. Refresh before choosing the next step.`,
    DeliveryWindowClosed: () => "The settlement window onchain has closed. The seller can refund the allocation.",
  };
  return messages[parsed.name] ? say(messages[parsed.name]()) : error;
}
