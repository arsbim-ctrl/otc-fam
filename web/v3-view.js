import { same } from "./eth.js";
import { linkPayload } from "./v3.js";
import { amount, fact, h, networkName, short, span, TOKEN_WARNING, utc } from "./ui.js";

const STATES = {
  unfunded: "Awaiting funding", funded: "Funded", settled: "Settled",
  expired: "Expired", refunded: "Refunded", "nonce-used": "Nonce used",
};

export const statusPill = (phase) => h("span", {
  class: `status broker-status ${phase}`, "data-status": phase, testid: "broker-status",
}, STATES[phase]);
export const addressText = (value) => h("span", { class: "mono" }, value);
export const quoteAmount = (units, token) => token ? amount(units, token) : `${units} raw units`;
export const shareLabel = (bps) => {
  const value = BigInt(bps);
  return `${value / 100n}${value % 100n ? `.${String(value % 100n).padStart(2, "0").replace(/0$/, "")}` : ""}%`;
};
export const deliveryLabel = (terms) => terms.delivery ? "New vesting grant" : "Immediate delivery";

export function nav(active) {
  return h("nav", { "aria-label": "Broker deals", class: "broker-nav" },
    h("a", { href: "#/v3/new", "aria-current": active === "new" ? "page" : null }, "Prepare deal"),
    h("a", { href: "#/v3/history", "aria-current": active === "history" ? "page" : null }, "Deal history"));
}

export const brokerView = (active, ...children) => h("div", { class: "broker-view" }, nav(active), ...children);

export const panel = (...children) => h("section", { class: "broker-panel" }, ...children);

export function domainLabel(domain) {
  return `${networkName(domain.chainId)} · Chain ${domain.chainId}`;
}

export function compare(terms, base, quote) {
  return h("div", { class: "broker-pair" },
    h("div", {}, h("span", { class: "eyeline" }, "Base allocation"),
      h("strong", {}, quoteAmount(terms.allocation, base)), addressText(terms.baseToken)),
    h("div", {}, h("span", { class: "eyeline" }, "Agreed quote"),
      h("strong", {}, quoteAmount(terms.quote, quote)), addressText(terms.quoteToken)));
}

export function feeFacts(fees, quote, terms, treasury) {
  const fee = (label, units, id) => fact(label, h("span", { testid: id }, quoteAmount(units, quote)));
  return h("dl", { class: "broker-facts broker-fees" },
    fee("Buyer pays", fees.buyerTotal, "broker-buyer-total"),
    fee("Seller receives", fees.sellerNet, "broker-seller-net"),
    fee("Buyer fee · 0.5%", fees.buyerFee, "broker-buyer-fee"),
    fee("Seller fee · 0.5%", fees.sellerFee, "broker-seller-fee"),
    fee(`Broker · ${shareLabel(terms.brokerBps)} of fee pool`, fees.brokerFee, "broker-cut"),
    fee("Treasury share", fees.treasuryFee, "broker-treasury-fee"),
    treasury && fact("Treasury wallet", addressText(treasury)));
}

export function exactTerms(terms, domain, id) {
  return h("dl", { class: "broker-facts" },
    fact("Seller wallet", addressText(terms.seller)),
    fact("Designated buyer wallet", addressText(terms.buyer)),
    fact("Broker recipient", addressText(terms.broker)),
    fact("Share in basis points", String(terms.brokerBps)),
    fact("Expiry", utc(terms.expiry), h("span", { class: "block mono" }, `${terms.expiry} Unix seconds`)),
    fact("Seller nonce", addressText(String(terms.nonce))),
    fact("Allocation · raw units", addressText(String(terms.allocation))),
    fact("Quote · raw units", addressText(String(terms.quote))),
    fact("Delivery", deliveryLabel(terms)),
    fact("Start", terms.delivery ? (terms.fixedStart ? utc(terms.fixedStart) : "At settlement") : "Immediate",
      h("span", { class: "block mono" }, `Fixed start ${terms.fixedStart} (Unix seconds)`)),
    fact("Cliff / duration", terms.delivery ? `${span(terms.cliffSeconds)} / ${span(terms.durationSeconds)}` : "No schedule",
      h("span", { class: "block mono" }, `${terms.cliffSeconds} / ${terms.durationSeconds} seconds`)),
    fact("Signing domain", `OTC.fam Broker Deals · v3 · ${domainLabel(domain)}`),
    fact("Verifying contract", addressText(domain.verifyingContract)),
    id && fact("Deal ID", addressText(id)));
}

export const tokenWarning = () => h("p", { class: "warning" }, TOKEN_WARNING);
export const linkFor = (domain, terms) => `#/v3/d/${linkPayload(domain, terms)}`;
export const duplicateFor = (domain, terms) => `#/v3/new/${linkPayload(domain, terms)}`;

export function copyDealLink(hash, id = "copy-broker-link") {
  return h("button", { type: "button", class: "secondary", testid: id, onclick: async (e) => {
    const status = e.currentTarget.nextElementSibling;
    const url = new URL(hash, location.href).href;
    try {
      await navigator.clipboard.writeText(url);
      status.textContent = "Link copied.";
    } catch {
      const share = status.parentElement.querySelector("input");
      share.value = url;
      share.hidden = false;
      share.focus();
      share.select();
      status.textContent = "Copy the selected address to share this deal.";
    }
  } }, "Copy link");
}

export function copyControls(hash, id) {
  return h("div", { class: "broker-copy" }, copyDealLink(hash, id), h("span", { role: "status", class: "hint" }),
    h("input", { hidden: true, readonly: true, value: new URL(hash, location.href).href, "aria-label": "Private deal link" }));
}

export function walletButton(app, refresh, report, busy = false) {
  const { wallet, config } = app;
  if (!wallet) return null;
  const switching = wallet.account && wallet.chainId !== config.chainId;
  if (wallet.account && !switching) return null;
  return h("button", { class: "secondary", type: "button", testid: "broker-wallet", disabled: busy, onclick: async (event) => {
    const button = event.currentTarget;
    report(null);
    button.disabled = true;
    try {
      if (switching) await wallet.switchTo(config.chainId);
      else await wallet.connect();
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      button.disabled = false;
    }
  } }, switching ? `Switch to ${networkName(config.chainId)}` : "Connect wallet");
}

export function walletSummary(app, required) {
  const wallet = app.wallet;
  if (!wallet) return "Open this link in a browser with a wallet to take onchain actions.";
  if (!wallet.account) return "Connect your wallet to see actions available to your address.";
  if (wallet.chainId !== app.config.chainId) return `Your wallet is on chain ${wallet.chainId}. Switch to ${domainLabel(app.v3.domain)} to act.`;
  if (required && !same(wallet.account, required)) return `Your connected wallet ${short(wallet.account)} cannot take this step.`;
  return null;
}
