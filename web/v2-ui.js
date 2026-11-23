import { DELIVERY, feeBreakdown } from "./eth-v2.js";
import { amount, fact, h } from "./ui.js";

export const displayDelivery = (delivery) => delivery === DELIVERY.vesting ? "New vesting grant" : "Immediate delivery";
export const v2Link = ({ chainId, contract }, id) => `#/v2/d/${chainId}/${contract.toLowerCase()}/${id}`;
export const utc = (time) => time <= 253_402_300_799n
  ? new Date(Number(time) * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC"
  : `${time} Unix seconds (beyond year 9999)`;
export const spanAddress = (address) => h("span", { class: "mono" }, address);
export const version = () => h("span", { class: "v2-version" }, "V2");

export const tokenWarning = () => h("p", { class: "notice warn v2-token-warning" },
  "Verify both token contract addresses. Symbols can be copied. Use test tokens with standard balances and exact transfers.");

export function replaceIfChanged(parent, ...children) {
  const next = document.createDocumentFragment();
  next.append(...children.filter(Boolean));
  const previous = parent.childNodes;
  const upcoming = next.childNodes;
  if (previous.length !== upcoming.length || !Array.from(previous).every((node, i) => node.isEqualNode(upcoming[i]))) {
    parent.replaceChildren(next);
  }
}

export function economics(quote, token, treasury) {
  const { fee, sellerNet, buyerTotal, feePool } = feeBreakdown(quote);
  const line = (label, units, id) => h("div", {}, h("dt", {}, label), h("dd", { testid: id }, amount(units, token)));
  return h("dl", { class: "v2-ledger" },
    line("Agreed price", quote, "quote"),
    line("Buyer fee · 0.5%", fee, "buyer-fee"),
    line("Seller fee · 0.5%", fee, "seller-fee"),
    line("Buyer pays", buyerTotal, "buyer-total"),
    line("Seller receives", sellerNet, "seller-net"),
    line("Treasury receives", feePool, "fee-pool"),
    treasury && fact("Treasury address", spanAddress(treasury)));
}

export function lengthInSeconds(seconds) {
  return seconds % 86_400n === 0n && seconds > 0n ? `${seconds / 86_400n} days` : `${seconds} seconds`;
}

export function schedule(terms) {
  if (terms.delivery !== DELIVERY.vesting) return null;
  return h("dl", { class: "facts" },
    fact("Start", terms.fixedStart ? utc(terms.fixedStart) : "Settlement block"),
    fact("Cliff", lengthInSeconds(terms.cliffSeconds), terms.fixedStart ? ` · ${utc(terms.fixedStart + terms.cliffSeconds)}` : " after start"),
    fact("End", lengthInSeconds(terms.durationSeconds), terms.fixedStart ? ` · ${utc(terms.fixedStart + terms.durationSeconds)}` : " after start"));
}

export function txReference(chainId, hash) {
  const explorer = { 84532: "https://sepolia.basescan.org/tx/", 11155111: "https://sepolia.etherscan.io/tx/" }[chainId];
  return explorer && /^0x[\da-f]{64}$/i.test(hash)
    ? h("a", { href: explorer + hash, class: "mono v2-tx", target: "_blank", rel: "noopener noreferrer" }, hash)
    : h("code", { class: "mono v2-tx" }, hash);
}

export function txDetails(label, hash, chainId) {
  return hash && h("p", { class: "hint v2-receipt" }, h("strong", {}, label), txReference(chainId, hash));
}
