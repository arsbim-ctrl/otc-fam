// The receipts of a v2 deal, as a card of its page: which network, contract and deal they are of, the transaction
// just confirmed in this browser, and every event the contract emitted about the deal, each with what moved (the exact
// payment and both fees come from the event itself), when, how deep in the chain it is, and its transaction's hash,
// which links to the network's block explorer where there is one. It only draws: v2-deal-page.js reads the chain.
import { amount, card, fact, h, networkName, short, transaction, utc } from "./ui.js";

/**
 * The receipts' card. `s` is the deal page's state: the deal, its tokens (`base`, `quote`), the latest `block`, the
 * `receipt` of the press just confirmed, and `history`: undefined until the deal's events are read, null when the
 * node would not give them, else the list (v2.js, history).
 */
export function receiptsCard({ config, v2, explorer }, s, idText) {
  const d = s.deal, q = s.quote, t = s.base, r = s.receipt, give = amount(d.allocation, t);
  const words = {
    funded: () => `Funded. The seller, ${short(d.seller)}, put ${give} into the deal contract.`,
    settled: (e) => `Settled. The buyer, ${short(d.buyer)}, paid ${amount(d.quote + e.buyerFee, q)}: the price, ${amount(d.quote, q)}, and a buyer fee of ${amount(e.buyerFee, q)}. `
      + `The seller received ${amount(d.quote - e.sellerFee, q)}, after a seller fee of ${amount(e.sellerFee, q)}. The treasury received ${amount(e.buyerFee + e.sellerFee, q)}. `
      + (d.delivery === "vesting" ? `All ${give} moved into the grant's vault.` : `All ${give} went to the buyer.`),
    granted: () => `Grant #${idText} created for the buyer${s.grant ? `, with its vault at ${short(s.grant.custodian)}` : ""}.`, // a deal's grant has the deal's number
    claimed: (e) => `Claimed. The grant's vault paid ${amount(e.amount, t)} to the beneficiary, ${short(d.buyer)}. No fee.`,
    cancelled: () => `Cancelled. ${give} went back to the seller, ${short(d.seller)}. No fee.`,
  };
  const depth = (block) => {
    const blocks = s.block.number - block + 1;
    return blocks > 0 ? `confirmed, ${blocks.toLocaleString("en")} block${blocks === 1 ? "" : "s"} deep` : "confirmed";
  };
  return card(
    h("h2", {}, "Receipts"),
    h("dl", { class: "facts" },
      fact("Network", h("span", { testid: "receipt-network" }, `${networkName(config.chainId)}, chain ${config.chainId}`)),
      fact("Deal contract, v2", h("span", { class: "mono", testid: "receipt-contract" }, v2.contract)),
      fact("Deal", `#${idText}`)),
    r && h("p", { class: "success", testid: "last-receipt", "data-tx": r.hash },
      `${r.what}: confirmed in block ${r.block}, using ${r.gas.toLocaleString("en")} gas. Transaction `, transaction(r.hash, explorer)),
    s.history === undefined && h("p", { class: "hint" }, "Reading this deal's transactions…"),
    s.history === null && h("p", { class: "hint" }, "This network's node did not give this deal's past transactions. Everything else on this page is still read from the chain."),
    s.history && h("ol", { class: "receipts", testid: "receipts" }, s.history.map((e) => h("li", { "data-kind": e.kind, "data-tx": e.hash },
      h("span", { class: "what" }, words[e.kind](e)),
      h("span", { class: "when" }, `${utc(e.time)}, block ${e.block}: ${depth(e.block)}`),
      transaction(e.hash, explorer)))));
}
