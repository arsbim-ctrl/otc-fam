import { amount, fact, h } from "./ui.js";
import { fees } from "./vesting.js";
export const utc = seconds => Number(seconds) > 253402300799 ? `Unix ${seconds} seconds UTC (after year 9999)` : new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
export const tokenWarning = () => h("p", { class: "notice warn" }, "Verify both token contract addresses. Symbols can be copied. Fee-taking, rebasing or frozen tokens may fail or become stuck. Use local or testnet assets only.");
export function economics(quote, token) {
  const f = fees(quote);
  return h("dl", { class: "facts", testid: "fees" },
    fact("Payment before fees", amount(quote, token)), fact("Buyer fee · 0.5%", amount(f.buyerFee, token)),
    fact("Buyer total", amount(f.buyerTotal, token)), fact("Seller fee · 0.5%", amount(f.sellerFee, token)),
    fact("Seller receives", amount(f.sellerNet, token)), fact("Treasury receives", amount(f.feePool, token)));
}
// Preserve action nodes during read polling; each handler reads current page state.
export function updateArea(area, next) {
  if (!area.firstElementChild?.isEqualNode(next)) area.replaceChildren(next);
}
export function receiptView(receipt) {
  return h("p", { class: "success", testid: "transaction-receipt" }, `Confirmed transaction ${receipt.transactionHash} · block ${BigInt(receipt.blockNumber)}. Receipt status: success.`);
}
