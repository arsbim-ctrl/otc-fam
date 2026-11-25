// The receipt of a broker deal, as a card of its page. It names the network, the contract and the deal's ID; for a
// settled deal it lists who paid and who received what, to the token's smallest unit, with the two fees, the broker's
// and the treasury's share, and how the tokens were delivered; and it lists every transaction of the deal with its
// time, how deep in the chain it is, and its hash, which links to the network's block explorer where there is one.
// The amounts of a settlement are the ones the contract wrote in its event, not the page's own arithmetic.
// It only draws: v3-deal-page.js reads the chain.
import { amount, card, fact, h, networkName, short, transaction, utc } from "./ui.js";
import { formatAmount } from "./units.js";
import { percent } from "./v3.js";

/**
 * The receipt's card. `s` is the deal page's state: the terms `t`, the tokens (`base`, `quote`), the latest `block`,
 * the `receipt` of the press just confirmed in this browser, the `treasury`, the `grant` if there is one, and
 * `history`: undefined until the deal's events are read, null when the node would not give them, else the list.
 */
export function receiptCard({ config, v3, explorer }, s) {
  const t = s.t, q = s.quote, b = s.base, r = s.receipt, give = amount(t.allocation, b);
  const settled = s.history?.find((e) => e.kind === "settled");
  const depth = (block) => {
    const blocks = s.block.number - block + 1;
    return blocks > 0 ? `confirmed, ${blocks.toLocaleString("en")} block${blocks === 1 ? "" : "s"} deep` : "confirmed";
  };
  const words = {
    funded: () => `Funded. The seller, ${short(t.seller)}, put ${give} into the deal contract. No fee, and nothing for the broker.`,
    settled: (e) => `Settled. The buyer, ${short(t.buyer)}, paid ${amount(t.quote + e.buyerFee, q)}; the seller received ${amount(t.quote - e.sellerFee, q)}; `
      + `the broker received ${amount(e.brokerFee, q)}; the treasury received ${amount(e.treasuryFee, q)}. `
      + (e.grantId ? `All ${give} moved into the vault of grant #${e.grantId}.` : `All ${give} went to the buyer.`),
    refunded: () => `Refunded. ${give} went back to the seller, ${short(t.seller)}. No fee, and nothing for the broker.`,
    claimed: (e) => `Claimed. The grant's vault paid ${amount(e.amount, b)} to the beneficiary, ${short(t.buyer)}. No fee, and nothing for the broker.`,
  };
  const sum = (label, testid, units, who) => fact(label, h("span", { testid }, formatAmount(units, q.decimals)), ` ${q.symbol}`, who && h("span", { class: "mono block" }, who));
  return card(
    h("h2", {}, "Receipt"),
    h("dl", { class: "facts" },
      fact("Network", h("span", { testid: "receipt-network" }, `${networkName(config.chainId)}, chain ${config.chainId}`)),
      fact("Deal contract, v3", h("span", { class: "mono", testid: "receipt-contract" }, v3.contract)),
      fact("Deal ID", h("span", { class: "mono", testid: "receipt-deal" }, s.id))),
    r && h("p", { class: "success", testid: "last-receipt", "data-tx": r.hash },
      `${r.what}: confirmed in block ${r.block}, using ${r.gas.toLocaleString("en")} gas. Transaction `, transaction(r.hash, explorer)),
    settled && h("dl", { class: "facts settlement", testid: "settlement", "data-tx": settled.hash },
      fact("Settlement transaction", h("span", { testid: "receipt-tx" }, transaction(settled.hash, explorer))),
      fact("Status", h("span", { testid: "receipt-status", "data-block": String(settled.block) }, depth(settled.block)), `: block ${settled.block}, ${utc(settled.time)}`),
      sum("Buyer paid: the price and the buyer fee", "receipt-paid", t.quote + settled.buyerFee, t.buyer),
      sum("Seller received: the price less the seller fee", "receipt-seller-net", t.quote - settled.sellerFee, t.seller),
      sum("Buyer fee", "receipt-buyer-fee", settled.buyerFee),
      sum("Seller fee", "receipt-seller-fee", settled.sellerFee),
      sum(`Broker received: ${percent(t.brokerBps)} of both fees`, "receipt-broker-fee", settled.brokerFee, t.broker),
      sum("Treasury received: the rest of the fees", "receipt-treasury-fee", settled.treasuryFee, s.treasury),
      fact("Delivered", h("span", { testid: "receipt-delivery", "data-grant": String(settled.grantId) }, settled.grantId
        ? `All ${give} into the vault of grant #${settled.grantId}, which pays the buyer as it vests` : `All ${give} to the buyer's wallet`),
      settled.grantId && s.grant ? h("span", { class: "mono block", testid: "receipt-vault" }, s.grant.custodian) : null)),
    s.history === undefined && h("p", { class: "hint" }, "Reading this deal's transactions…"),
    s.history === null && h("p", { class: "hint" }, "This network's node did not give this deal's past transactions. Everything else on this page is still read from the chain."),
    s.history?.length === 0 && h("p", { class: "hint", testid: "no-receipts" }, "No transaction yet: nothing has been deposited or paid for this deal."),
    s.history?.length > 0 && h("ol", { class: "receipts", testid: "receipts" }, s.history.map((e) => h("li", { "data-kind": e.kind, "data-tx": e.hash },
      h("span", { class: "what" }, words[e.kind](e)),
      h("span", { class: "when" }, `${utc(e.time)}, block ${e.block}: ${depth(e.block)}`),
      transaction(e.hash, explorer)))));
}
