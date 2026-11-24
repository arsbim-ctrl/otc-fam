import { explain, same, ZERO_ADDRESS } from "./eth.js";
import { amount, fact, h, span, utc } from "./ui.js";
import { fees } from "./broker-terms.js";

const labels = { loading: "Checking chain", created: "Created", unverified: "Status unavailable", unfunded: "Awaiting funding", funded: "Funded", settled: "Settled", expired: "Expired", refunded: "Refunded" };
export const statusChip = (status) => h("span", { class: `broker-status broker-${status}`, testid: "deal-status", "data-status": status, role: "status" }, labels[status]);
export const mono = (text) => h("span", { class: "mono" }, text);
export const brokerButton = (label, run, testid, kind = "primary") =>
  h("button", { type: "button", class: kind, testid, onclick: run, disabled: !run }, label);
export const brokerNav = () => h("nav", { class: "broker-nav", "aria-label": "Deal versions" },
  h("a", { href: "#/v3/new" }, "Prepare broker deal"), h("a", { href: "#/v3/history" }, "Deal history"),
  h("a", { href: "#/v2/new" }, "Seller deals · v2"), h("a", { href: "#/new" }, "Plain swaps · v1"));
export const heading = (title, sub, status) => h("header", { class: "broker-heading" },
  h("div", {}, h("p", { class: "broker-version" }, "Broker deals · v3"), h("h1", {}, title), h("p", { class: "lead" }, sub)),
  status && statusChip(status));
export const field = (label, input, hint) => h("label", { class: "broker-field" }, h("span", {}, label), input, hint && h("small", {}, hint));

export function deliveryText(terms) {
  if (terms.delivery === 0n) return "Immediate · full allocation to the buyer";
  return `New vesting grant · ${span(terms.cliffSeconds)} cliff · ${span(terms.durationSeconds)} total`;
}
export const startText = (terms) => terms.fixedStart ? utc(terms.fixedStart) : "When settlement confirms";
export const shareText = (bps) => `${bps / 100n}${bps % 100n ? `.${(bps % 100n).toString().padStart(2, "0").replace(/0$/, "")}` : ""}% of the fee pool`;

export function moneyFacts(terms, quote, event) {
  const { buyerFee, sellerFee, brokerFee, treasuryFee } = event ?? fees(terms.quote, terms.brokerBps);
  const line = (name, value, id) => fact(name, h("span", { testid: id }, amount(value, quote)));
  return h("dl", { class: "facts broker-money" },
    line("Agreed quote", terms.quote, "agreed-quote"), line("Fee pool", buyerFee + sellerFee, "fee-pool"),
    line(event ? "Buyer paid" : "Buyer pays", terms.quote + buyerFee, "buyer-total"), line("Buyer fee · 0.5%", buyerFee, "buyer-fee"),
    line(event ? "Seller received" : "Seller receives", terms.quote - sellerFee, "seller-net"), line("Seller fee · 0.5%", sellerFee, "seller-fee"),
    line(event ? "Broker received" : "Broker receives", brokerFee, "broker-fee"),
    line(event ? "Treasury received" : "Treasury receives", treasuryFee, "treasury-fee"));
}
export function tokenFacts(terms, base, quote) {
  return [
    fact("Allocation token", mono(terms.baseToken)), fact("Allocation, raw units", mono(String(terms.allocation))),
    fact("Quote token", mono(terms.quoteToken)), fact("Quote, raw units", mono(String(terms.quote))),
    base && fact("Allocation", amount(terms.allocation, base)), quote && fact("Quote", amount(terms.quote, quote)),
  ];
}

export function treasuryFact(config) {
  return fact("Treasury", config.treasuryBroker && !same(config.treasuryBroker, ZERO_ADDRESS)
    ? mono(config.treasuryBroker) : "Address unavailable in site configuration");
}

export function copyDeal(text, copied) {
  return brokerButton("Copy link", async (event) => {
    const button = event.currentTarget;
    if (!navigator.clipboard) return copied(false);
    button.setAttribute("aria-busy", "true");
    const ok = await navigator.clipboard.writeText(text).then(() => true, () => false);
    button.removeAttribute("aria-busy");
    copied(ok);
  }, undefined, "secondary");
}
export const errorText = (error) => explain(error);
