import { digest, fees, isId, pack, roleNames, unpack, unsigned } from "./broker-terms.js";

const prefix = "otc-history:v3:";
const amounts = ["buyerFee", "sellerFee", "brokerFee", "treasuryFee", "grantId"];
export const historyKey = (domain, account) => `${prefix}${domain.chainId}:${domain.verifyingContract}:${account.toLowerCase()}`;
export const isHistoryKey = (key) => key?.startsWith(prefix);

function decodeReceipts(saved, terms, first, last) {
  if (!Array.isArray(saved) || saved.length < 1 || saved.length > 2) throw new Error("Invalid cached receipt list");
  let previous = first;
  return saved.map(({ kind, hash, block, units }, i) => {
    if (typeof hash !== "string" || !isId(hash) || !Number.isSafeInteger(block) || block < previous || block > last
        || (i === 0 ? kind !== "funded" : !["settled", "refunded"].includes(kind))) {
      throw new Error("Invalid cached receipt");
    }
    previous = block;
    const entry = { kind, hash, block };
    if (kind === "settled") {
      if (!Array.isArray(units) || units.length !== amounts.length) throw new Error("Invalid cached settlement amounts");
      const expected = fees(terms.quote, terms.brokerBps);
      for (const [index, name] of amounts.entries()) {
        entry[name] = unsigned(units[index], 256, name);
        if (name !== "grantId" && entry[name] !== expected[name]) throw new Error("Invalid cached fees");
      }
    }
    return entry;
  });
}

export function readHistory(storage, domain, account, first) {
  try {
    if (!Number.isSafeInteger(first) || first < 1) return null;
    const entry = JSON.parse(storage?.getItem(historyKey(domain, account)) ?? "null");
    if (entry?.fromBlock !== first || !Number.isSafeInteger(entry?.block?.number)
        || entry.block.number < first || typeof entry.block.hash !== "string" || !isId(entry.block.hash) || !Array.isArray(entry.records)) return null;
    const records = new Map();
    for (const saved of entry.records) {
      const { domain: scope, terms } = unpack(saved.terms);
      const { id } = saved;
      if (scope.chainId !== domain.chainId || scope.verifyingContract !== domain.verifyingContract
          || digest(domain, terms) !== id || !roleNames(terms, account).length || records.has(id)) return null;
      const receipts = decodeReceipts(saved.receipts, terms, first, entry.block.number);
      // Status and grant ID always come from getDeal at the current head.
      records.set(id, { deal: { id, terms }, receipts });
    }
    return { block: entry.block, records };
  } catch {
    return null;
  }
}

export function writeHistory(storage, domain, account, fromBlock, block, records) {
  if (!storage) return;
  try {
    const key = historyKey(domain, account);
    const saved = [...records.values()].map(({ deal, receipts }) => ({
      id: deal.id, terms: pack(domain, deal.terms),
      receipts: receipts.map(({ kind, hash, block, ...rest }) => ({
        kind, hash, block, ...(kind === "settled" && { units: amounts.map((name) => String(rest[name])) }),
      })),
    }));
    storage.setItem(key, JSON.stringify({ fromBlock, block: { number: block.number, hash: block.hash }, records: saved }));
  } catch {} // Blocked or full browser storage leaves the in-memory history usable.
}
