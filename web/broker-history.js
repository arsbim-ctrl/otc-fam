import { amount, card, fact, h, notice, short, show, transaction, utc } from "./ui.js";
import { claimable, dealHash, digest, expiration, fees, roleNames } from "./broker-terms.js";
import { isHistoryKey } from "./broker-history-cache.js";
import { localDeals, rememberDeal } from "./broker-store.js";
import { brokerButton, brokerNav, copyDeal, errorText, heading, shareText, statusChip } from "./broker-ui.js";

const filters = ["All roles", "broker", "seller", "buyer"];
export function brokerHistory(app, api) {
  document.title = "Broker deal history · otc.fam";
  let active = true, serial = 0, account, records, error, info, busy = false, role = "All roles";
  const content = h("div", { class: "broker-history" });
  app.main.replaceChildren(h("div", { class: "broker-view" }, brokerNav(),
    heading("Deal history", "Review the deals tied to your wallet, from prepared links to onchain receipts."), content));

  function roleFacts(role, deal, terms, status, base, quote, last, vesting) {
    const settled = deal.status === "settled", refunded = deal.status === "refunded";
    const proposed = fees(terms.quote, terms.brokerBps);
    const allocation = amount(terms.allocation, base);
    const settlement = last?.kind === "settled" ? last : proposed;
    const pay = terms.quote + settlement.buyerFee, net = terms.quote - settlement.sellerFee;
    const closed = refunded || status === "expired";
    if (role === "buyer") return [
      fact(closed || settled ? "Buyer paid" : "Buyer pays", amount(closed ? 0n : pay, quote)),
      ...(settled && terms.delivery === 1n
        ? vesting ? [
          fact("Funded into grant vault", amount(vesting.allocation, base)),
          fact("Still in grant vault", vesting.held === null ? "Vault balance unavailable" : amount(vesting.held, base)),
          fact("Vested", amount(vesting.vested, base)),
          fact("Claimed", amount(vesting.claimed, base)),
          fact("Claimable", amount(vesting.available, base)),
        ] : [fact("Grant vault", "Vault details unavailable")]
        : [fact(closed || settled ? "Buyer received" : "Buyer receives", closed ? "No delivery" : allocation)]),
    ];
    if (role === "seller") return [
      fact(closed || settled ? "Seller received" : "Seller net", amount(closed ? 0n : net, quote)),
      deal.status === "funded" && status === "expired"
        ? fact("Allocation in escrow", `${allocation} · Refund available`)
        : fact(refunded ? "Allocation refunded" : settled ? "Allocation delivered" : "Allocation", allocation),
    ];
    return [
      fact(closed || settled ? "Broker paid" : "Proposed broker fee", amount(closed ? 0n : settlement.brokerFee, quote)),
      fact("Broker share", shareText(terms.brokerBps)),
    ];
  }

  function row({ deal, terms, roles, status, base, quote, receipts, vesting }) {
    const hash = dealHash(api.domain, terms), link = new URL(hash, location.href).href;
    const last = receipts?.at(-1), ownRole = roles[0];
    const delivery = deal.grantId ? `Vesting grant #${deal.grantId}` : terms.delivery === 1n ? "New vesting grant" : "Immediate delivery";
    return h("article", { class: "card broker-history-row", "data-deal-id": deal.id, "data-status": status, "data-roles": roles.join(" ") },
      h("header", {}, h("div", {}, h("h2", {}, `${base.symbol} / ${quote.symbol}`),
        h("p", { class: "hint" }, h("span", { class: "broker-role" }, ownRole), ` · ${delivery}`),
        h("p", { class: "hint" }, "Deal ", h("span", { class: "mono", title: deal.id }, short(deal.id)))), statusChip(status)),
      h("dl", { class: "facts broker-money" },
        fact("Quote", amount(terms.quote, quote)),
        ...roleFacts(ownRole, deal, terms, status, base, quote, last, vesting),
        Boolean(deal.grantId) && ownRole !== "buyer" && fact("Claimable by buyer",
          vesting ? amount(vesting.available, base) : "Vault details unavailable"),
        fact("Deadline", utc(terms.expiry))),
      last && h("p", { class: "hint" }, `${last.kind === "settled" ? "Settlement" : last.kind === "refunded" ? "Refund" : "Funding"} confirmed · block ${last.block}`),
      last && h("p", { class: "broker-history-tx" }, transaction(last.hash, app.explorer)),
      !last && deal.status !== "unfunded" && h("p", { class: "hint" }, "Receipt unavailable. Refresh history to retry."),
      h("div", { class: "broker-row-actions" },
        h("a", { class: "button primary", href: hash }, last ? "Open deal & receipts" : "Open terms"),
        copyDeal(link, (ok) => {
          if (ok) rememberDeal(api.domain, terms, "shared");
          info = { kind: ok ? "success" : "error", text: ok ? "Deal link copied." : "Clipboard unavailable. Open the deal and copy its address." };
          if (ok && status === "created") {
            const record = records?.find((item) => item.deal.id === deal.id);
            if (record) record.status = "unfunded";
          }
          render();
        }),
        ownRole === "broker" && h("a", { class: "button secondary", href: hash.replace("#/v3/d/", "#/v3/new/") }, "Duplicate terms")));
  }

  function render() {
    if (!active) return;
    const current = (records ?? []).filter((item) => role === "All roles" || item.roles.includes(role));
    show(content, h("div", { class: "broker-history-content" },
      !account ? card(h("h2", {}, "See your deals"), h("p", { class: "hint" },
        app.wallet ? "Connect a wallet to see its broker, seller and buyer activity." : "Open this page in a browser with a wallet to see your deals."),
      app.wallet && brokerButton(busy ? "Connecting…" : "Connect wallet", busy ? null : async () => {
        busy = true;
        error = null;
        render();
        try { await app.wallet.connect(); } catch (e) { error = errorText(e); }
        busy = false;
        update();
      }, "history-connect")) : h("div", { class: "broker-history-tools" },
        fieldSelect(role, (value) => { role = value; render(); }),
        brokerButton("Refresh history", update, "history-refresh", "secondary")),
      error && notice({ kind: "error", text: error }), info && notice(info),
      account && !records && !error && h("p", { role: "status", class: "hint" }, "Reading wallet history from the chain…"),
      account && records && (current.length ? h("div", { class: "broker-history-grid" }, current.map(row))
        : card(h("p", { class: "hint" }, "No deals for this wallet and role. Prepared links appear after they are saved in this browser.")))));
  }

  async function update() {
    const run = ++serial, who = app.wallet?.account;
    if (who !== account) {
      account = who;
      records = error = info = null;
    }
    render();
    if (!account) return;
    try {
      const { block, entries, error: readError } = await api.activity(who);
      if (!active || run !== serial) return;
      const locals = new Map(localDeals(api.domain, who).map((record) => [record.id, record]));
      const onchain = new Map(entries.map((entry) => [entry.deal.id, entry]));
      const all = [...new Set([...onchain.keys(), ...locals.keys()])];
      const result = await Promise.all(all.map(async (id) => {
        const { deal, receipts } = onchain.get(id) ?? { deal: { id, status: "unfunded" }, receipts: [] };
        const local = locals.get(id), terms = deal.terms ?? local?.terms;
        if (!terms || digest(api.domain, terms) !== id) return null;
        const roles = roleNames(terms, who);
        if (!roles.length) return null;
        let status = deal.status;
        if (["unfunded", "funded"].includes(status) && expiration(terms, block.time)) status = "expired";
        if (status === "unfunded" && local?.stage === "created" && roles.includes("broker")) status = "created";
        const raw = (address) => ({ address, decimals: 0, symbol: "raw units" });
        const [base, quote, grant] = await Promise.all([
          app.chain.token(terms.baseToken).catch(() => raw(terms.baseToken)), app.chain.token(terms.quoteToken).catch(() => raw(terms.quoteToken)),
          deal.grantId ? api.grant(deal.grantId, block.number).catch(() => null) : null,
        ]);
        const available = grant && claimable(grant, block.time);
        const vesting = grant && { ...grant, available, vested: available + grant.claimed };
        return { deal, terms, roles, status: readError ? "unverified" : status, base, quote, receipts, vesting };
      }));
      if (!active || run !== serial) return;
      records = result.filter(Boolean);
      error = readError ? `Chain history is incomplete. ${errorText(readError)}` : null;
    } catch (e) {
      if (!active || run !== serial) return;
      records = null;
      error = errorText(e);
    }
    render();
  }
  addEventListener("focus", update);
  const storageChanged = (event) => { if (!isHistoryKey(event.key)) update(); };
  addEventListener("storage", storageChanged);
  update();
  return { update, stop() { active = false; removeEventListener("focus", update); removeEventListener("storage", storageChanged); } };
}

function fieldSelect(role, changed) {
  return h("label", { class: "broker-field" }, h("span", {}, "Role"),
    h("select", { testid: "history-role", onchange: (event) => changed(event.target.value) },
      filters.map((value) => h("option", { value, selected: value === role }, value === "All roles" ? value : value[0].toUpperCase() + value.slice(1)))));
}
