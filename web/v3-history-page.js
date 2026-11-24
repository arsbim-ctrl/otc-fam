import { explain, same } from "./eth.js";
import { fact, h, notice, show, transaction, utc } from "./ui.js";
import { blockTag, brokerMoney, dealPhase, readPayload } from "./v3.js";
import { savedDrafts } from "./v3-drafts.js";
import {
  brokerView, copyControls, deliveryLabel, domainLabel, duplicateFor, linkFor, panel,
  quoteAmount, shareLabel, statusPill, walletButton, walletSummary,
} from "./v3-view.js";

const ROLES = { broker: "Broker", seller: "Seller", buyer: "Buyer" };
const shortToken = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function brokerHistoryPage(app) {
  const { v3, chain } = app;
  document.title = "Broker deal history · otc.fam";
  let stopped = false;
  let role = "broker";
  let scope;
  let activeScope;
  let entries = [];
  let loading = false;
  let readError = "";
  let walletError = "";
  let revision = 0;

  function card({ id, terms, phase, chainStatus, draft, base, quote, receipt }) {
    const fees = brokerMoney(terms.quote, terms.brokerBps);
    const href = linkFor(v3.domain, terms);
    const pair = `${base?.symbol || shortToken(terms.baseToken)} / ${quote?.symbol || shortToken(terms.quoteToken)}`;
    return h("li", { class: "broker-history-item", testid: "broker-history-entry" },
      h("div", { class: "card-head" }, h("h2", {}, h("a", { href }, pair)), statusPill(phase)),
      h("p", { class: "hint" }, draft && chainStatus === "unfunded" ? "Created in this browser · " : "", deliveryLabel(terms)),
      h("dl", { class: "broker-facts" },
        fact("Quote", quoteAmount(terms.quote, quote)),
        fact("Broker share on settlement", `${shareLabel(terms.brokerBps)} · ${quoteAmount(fees.brokerFee, quote)}`),
        fact("Expires", utc(terms.expiry))),
      receipt && h("p", { class: "broker-tx" }, h("a", { href }, "Settlement receipt"), transaction(receipt.hash, app.explorer)),
      chainStatus === "settled" && !receipt && h("a", { href }, "Open deal to check receipt"),
      h("div", { class: "broker-history-actions" },
        copyControls(href, `copy-${id}`), h("a", { href: duplicateFor(v3.domain, terms), class: "button secondary" }, "Duplicate terms")));
  }

  function render() {
    if (stopped) return;
    const { account } = app.wallet ?? {};
    const walletNote = walletSummary(app);
    show(app.main, brokerView("history",
      panel(h("span", { class: "eyeline" }, domainLabel(v3.domain)), h("h1", {}, "Deal history"),
        h("p", { class: "lead" }, "Funded deals follow your address onchain. Proposals you create appear in the broker view of this browser."),
        account && h("p", { class: "mono broker-history-address" }, account),
        walletNote && h("p", { class: "hint" }, walletNote),
        walletError && notice({ kind: "error", text: walletError }),
        walletButton(app, refresh, (error) => { walletError = error ? explain(error) : ""; render(); }),
        h("div", { class: "broker-tabs", "aria-label": "View deals by role" },
          Object.entries(ROLES).map(([key, label]) => h("button", {
            type: "button", class: "secondary", testid: `broker-role-${key}`, "aria-pressed": key === role ? "true" : "false",
            onclick: () => {
              if (role === key) return;
              role = key;
              void refresh();
            },
          }, label))),
        account && h("button", { class: "secondary broker-history-refresh", type: "button", onclick: () => refresh() }, "Refresh history")),
      account && h("div", { class: "broker-stack" },
        readError && notice({ kind: "error", text: readError }),
        loading && h("p", { class: "hint", role: "status" }, "Checking deal history onchain…"),
        !loading && !readError && !entries.length && panel(h("h2", {}, `No ${role} deals yet`),
          h("p", { class: "lead" }, role === "broker" ? "New links and deals funded with this broker recipient will appear here." : "Deals appear here once the seller has funded them.")),
        entries.length > 0 && h("ul", { class: "broker-history", "aria-label": `${ROLES[role]} deals` }, entries.map(card)))));
  }

  async function refresh() {
    if (stopped) return;
    const account = app.wallet?.account;
    const view = role;
    const nextScope = account && `${view}:${account}`;
    if (account && activeScope === nextScope) return;
    activeScope = nextScope;
    const attempt = ++revision;
    if (scope !== nextScope) entries = [];
    scope = nextScope;
    loading = Boolean(account) && entries.length === 0;
    readError = "";
    render();
    if (!account) return;

    try {
      await v3.setup();
      const block = await chain.block();
      const tag = blockTag(block.number);
      const onchain = await v3.roleDeals(view, account, block.number);
      const local = new Map();
      if (view === "broker") {
        for (const draft of savedDrafts(v3.domain)) {
          try {
            const terms = readPayload(draft.payload, v3.domain);
            if (same(terms.broker, account)) local.set(draft.id, terms);
          } catch {}
        }
      }
      const ids = [...new Set([...local.keys(), ...onchain])];
      const found = [];
      // Bound simultaneous RPCs in busy histories without dropping older deals.
      for (let offset = 0; offset < ids.length; offset += 6) {
        if (stopped || revision !== attempt) return;
        const batch = await Promise.all(ids.slice(offset, offset + 6).map(async (id) => {
          const deal = await v3.deal(id, tag);
          const draft = local.get(id);
          if (!deal.status || (deal.status === "unfunded" && !draft)) return null;
          const terms = deal.status === "unfunded" ? draft : deal.terms;
          if (!same(terms[view], account)) return null;
          if (deal.status === "unfunded" && await v3.id(terms) !== id) return null;
          const used = deal.status === "unfunded" && await v3.used(terms, tag);
          const phase = dealPhase(deal.status, terms, block.time, used);
          const [base, quote, receipt] = await Promise.all([
            chain.token(terms.baseToken).catch(() => null),
            chain.token(terms.quoteToken).catch(() => null),
            deal.status === "settled" ? v3.receipts(id, block.number).then((events) => events.find((event) => event.kind === "settled")).catch(() => null) : null,
          ]);
          return { id, terms, phase, chainStatus: deal.status, draft, base, quote, receipt };
        }));
        found.push(...batch.filter(Boolean));
      }
      if (revision === attempt) entries = found;
    } catch (error) {
      if (revision === attempt) readError = `History could not be refreshed. ${explain(error)}`;
    } finally {
      if (revision === attempt) {
        activeScope = null;
        loading = false;
        render();
      }
    }
  }

  void refresh();
  addEventListener("focus", refresh);
  const timer = setInterval(refresh, 15_000);
  return { update() { void refresh(); }, stop() {
    stopped = true;
    clearInterval(timer);
    removeEventListener("focus", refresh);
  } };
}
