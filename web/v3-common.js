import { h, card, fact, networkName, notice, show, TOKEN_WARNING, utc, amount, span } from "./ui.js";
import { same } from "./eth.js";
import { labels, pack, unpack } from "./v3.js";

export const mono = (text, testid) => h("span", { class: "mono", testid }, String(text));
export const statePill = (state) => h("span", { class: `status ${state}`, testid: "broker-status", "data-status": state, role: "status" }, labels[state]);
export const dealHref = (domain, terms) => new URL(`#/v3/d/${pack(domain, terms)}`, location.href).href;
export const createHref = (domain, terms) => `#/v3/new/${pack(domain, terms)}`;
export const valueOf = (units, token) => token.decimals == null ? `${units} raw units` : amount(units, token);
export const percent = (bps) => `${bps / 100n}.${String(bps % 100n).padStart(2, "0")}%`;
export const roleWallets = ["broker", "seller", "buyer"];
export const nav = () => h("nav", { class: "broker-nav", "aria-label": "Broker deals" },
  h("a", { href: "#/v3/new" }, "Prepare a deal"), h("a", { href: "#/v3/history" }, "Deal history"));
export const problem = (text) => notice({ kind: "error", text });
export const tokenWarning = () => h("p", { class: "warning" }, TOKEN_WARNING);
export const displayNetwork = (chainId) => `${networkName(Number(chainId))} · chain ${chainId}`;
export const actionButton = (id, text, run, disabled = false, style = "primary") => h("button",
  { class: style, type: "button", testid: id, onclick: run, disabled }, text);
export const section = (title, ...children) => card(h("h2", {}, title), ...children);
export const heading = (title) => h("h1", { tabindex: "-1", class: "broker-heading" }, title);

// A refreshed list can move a deal to a different row. Restore the focused control by its identity.
export function showBroker(container, view, fallback) {
  const active = document.activeElement;
  const id = container.contains(active) && active.getAttribute("data-testid");
  show(container, view);
  if (!id || document.activeElement.getAttribute("data-testid") === id) return;
  const current = container.querySelector(`[data-testid="${CSS.escape(id)}"]`);
  if (!current) fallback?.()?.focus({ preventScroll: true });
  else if (!current.disabled) current.focus({ preventScroll: true });
}

export function readTokens(chain, { baseToken, quoteToken }) {
  return Promise.all([baseToken, quoteToken].map(address => chain.token(address).catch(() => ({ address, decimals: null, symbol: "" }))));
}

export function feeFacts(fees, quote, treasury) {
  const row = (label, key, id = key) => fact(label, h("span", { testid: id }, valueOf(fees[key], quote)));
  return h("dl", { class: "facts broker-fees" },
    row("Buyer pays", "buyerTotal"), row("Seller receives", "sellerNet"),
    row("Agreed quote", "quote"), row("Buyer fee · 0.50%", "buyerFee"), row("Seller fee · 0.50%", "sellerFee"),
    row("Combined fee pool", "feePool"), row("Broker receives", "brokerFee"), row("Treasury receives", "treasuryFee"),
    treasury && fact("Treasury wallet", mono(treasury, "broker-treasury")));
}

export function deliveryText(t) {
  if (t.delivery === 0n) return "Immediate delivery to the buyer at settlement.";
  const start = t.fixedStart === 0n ? "starts at settlement" : `starts ${utc(t.fixedStart)}`;
  return `New funded vesting grant for the buyer. It ${start}, runs for ${span(t.durationSeconds)}, and has a ${span(t.cliffSeconds)} cliff.`;
}

export const rawTerms = (domain, terms) => h("details", { class: "broker-disclosure", testid: "broker-raw" },
  h("summary", {}, "Exact signed values in raw units"),
  h("dl", { class: "facts" },
    fact("Domain", domain.name),
    fact("Version", domain.version),
    fact("Chain ID", mono(domain.chainId)),
    fact("Verifying contract", mono(domain.verifyingContract)),
    ...Object.entries(terms).map(([name, value]) => fact(name, mono(value)))));

export function copyLink(link, id = "broker-copy") {
  const status = h("span", { class: "hint", role: "status" });
  return h("div", { class: "broker-copy" }, actionButton(id, "Copy link", async (e) => {
    const note = e.currentTarget.nextElementSibling;
    try {
      await navigator.clipboard.writeText(link);
      note.replaceChildren("Link copied.");
    } catch {
      const input = h("input", { "aria-label": "Link to copy", readonly: true, value: link });
      note.replaceChildren(input);
      input.focus();
      input.select();
    }
  }, false, "secondary"), status);
}

const keyFor = (domain) => `otcfam:v3:${domain.chainId}:${domain.verifyingContract.toLowerCase()}`;
export function keepLink(domain, id, packed) {
  try {
    localStorage.setItem(`${keyFor(domain)}:${id}`, packed);
    return true;
  } catch {
    return false;
  }
}

export function savedLinks(domain, role, account) {
  const prefix = `${keyFor(domain)}:`;
  try {
    return Object.keys(localStorage).filter(key => key.startsWith(prefix)).reverse().flatMap(key => {
      try {
        const proposal = unpack(localStorage.getItem(key));
        if (key === prefix + proposal.id && proposal.domain.chainId === domain.chainId
            && same(proposal.domain.verifyingContract, domain.verifyingContract) && same(proposal.terms[role], account)) return [proposal];
      } catch { /* An invalid local record does not prevent discovering onchain history. */ }
      return [];
    });
  } catch {
    return [];
  }
}

export function listenForUpdates(update, period = 5_000) {
  const onVisible = () => { if (!document.hidden) update(); };
  const timer = setInterval(onVisible, period);
  addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export const emptyPage = { update() {}, stop() {} };
