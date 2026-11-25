// #/v3/deals: the broker deals of one person, by role. The list has two sources. This browser's own: the links a
// broker prepared here and the deals opened here, kept in the browser's storage, which is the only place a deal that
// is not funded yet can be known from. And the chain's: every deal that names one address as seller or broker, and
// every deal that address settled as buyer, found by the contract's events, so the list is the same in any browser.
// The address is the connected wallet's, or one typed in (reading needs no wallet). Whatever the source, each deal's
// state is read from the chain now: awaiting funding, funded, settled, refunded or expired, with its pair, its price,
// the broker's share, its deadline and its receipt, and with the two things a list is for: the link, and a way to
// start a new deal from the same terms.
import { explain, same } from "./eth.js";
import { amount, card, copyButton, fact, fromNow, h, networkName, notice, secondary, short, show, transaction, utc } from "./ui.js";
import { isAddress } from "./units.js";
import { book, linkOf, money, packTerms, percent, settleBy, stateOf, VESTING } from "./v3.js";

const ROLES = { all: "All", broker: "As broker", seller: "As seller", buyer: "As buyer", here: "Others in this browser" };
const ROLE_WORDS = { broker: "Broker: you receive the share", seller: "Seller: you fund", buyer: "Buyer: you settle", here: "None: this browser prepared or opened the deal, which names other addresses" };
const WORDS = { awaiting: "Awaiting funding", funded: "Funded", settled: "Settled", refunded: "Refunded", expired: "Expired" };
const DEADLINE = { awaiting: "Can be funded and settled until", funded: "Can be settled until", expired: "Expired", settled: "Was open until", refunded: "Was open until" };

export function historyPageV3(app) {
  const { config, chain, wallet, v3, explorer } = app;
  if (!v3) {
    app.main.replaceChildren(card(h("h1", {}, "Broker deals are not set up here"),
      h("p", { class: "lead" }, "This site's config.json names no broker deals contract (contractV3), so there are no broker deals to list here."),
      h("a", { class: "button secondary", href: "#/" }, "Back to the start")));
    return { update() {}, stop() {} };
  }
  const key = `otcfam:v3:who:${config.chainId}:${v3.contract}`;
  const stored = () => {
    try {
      const text = localStorage.getItem(key) ?? "";
      return isAddress(text) ? text : "";
    } catch {
      return "";
    }
  };
  // rows: null until the first read. chainFailed: the node would not give the address's past deals.
  const s = { typed: stored(), rows: null, role: "all", failed: null, chainFailed: null, block: null, busy: null, notice: null };
  let live = true, reads = 0;
  const poll = setInterval(() => load(), 15_000);
  const onFocus = () => load();
  addEventListener("focus", onFocus);
  app.main.classList.add("wide");
  const who = () => wallet?.account ?? (isAddress(s.typed) ? s.typed.toLowerCase() : null);
  /** The viewer's role in a deal: by the address, when there is one; with none, a deal prepared in this browser is its broker's. */
  const roleOf = (address, t, how) => (!address ? (how === "prepared" ? "broker" : "here")
    : same(address, t.broker) ? "broker" : same(address, t.seller) ? "seller" : same(address, t.buyer) ? "buyer" : "here");

  /** Reads the address's deals from the chain and this browser's own, then each one's state now. */
  async function load() {
    const read = ++reads, address = who();
    try {
      const known = new Map(book(app).map((entry) => [entry.id, entry]));
      const [block, found] = await Promise.all([chain.block(), address ? v3.dealsOf(address).then((ids) => ({ ids }), (e) => ({ ids: [], failed: explain(e) })) : { ids: [] }]);
      const ids = [...new Set([...known.keys(), ...found.ids])];
      const receipts = await v3.receiptsOf(ids).catch(() => new Map());
      const rows = (await Promise.all(ids.map(async (id) => {
        const deal = await v3.deal(id), t = deal.terms ?? known.get(id).terms;
        const [base, quote] = await Promise.all([chain.token(t.baseToken), chain.token(t.quoteToken)]);
        return { id, t, base, quote, status: deal.status, state: stateOf(t, deal.status, Math.max(block.time, Date.now() / 1000)), role: roleOf(address, t, known.get(id)?.how),
          how: known.get(id)?.how ?? null, at: known.get(id)?.at ?? 0, receipt: receipts.get(id) ?? null };
      }).map((row) => row.catch(() => null)))).filter(Boolean); // a deal whose tokens do not answer cannot be shown, or funded
      if (read !== reads) return; // a later read is on its way
      Object.assign(s, { rows, block, failed: null, chainFailed: found.failed ?? null });
    } catch (e) {
      if (read !== reads) return;
      s.failed = explain(e);
    }
    render();
  }

  function render() {
    if (live) show(app.main, view());
  }

  function view() {
    const address = who(), rows = s.rows ?? [];
    const counts = Object.fromEntries(Object.keys(ROLES).map((role) => [role, role === "all" ? rows.length : rows.filter((row) => row.role === role).length]));
    const shown = rows.filter((row) => s.role === "all" || row.role === s.role);
    document.title = "Broker deals · otc.fam";
    return h("div", { class: "history" },
      card(
        h("div", { class: "card-head" }, h("h1", {}, "Broker deals", " ", h("span", { class: "version", testid: "version" }, "v3"))),
        h("p", { class: "lead" }, "The deals you broker, sell and buy, each with its state on the chain now and its receipt. Deals that are not funded yet are known only "
          + "to the browser they were prepared or opened in."),
        identity(address),
        h("div", { class: "tabs", role: "group", "aria-label": "Show deals by your role" }, Object.entries(ROLES).filter(([role]) => role !== "here" || counts.here).map(([role, label]) =>
          h("button", { class: "tab", type: "button", testid: `role-${role}`, "aria-pressed": String(s.role === role), onclick: () => {
            s.role = role;
            render();
          } }, `${label} (${counts[role]})`))),
        s.failed && notice({ kind: "error", text: `The deals could not be read. ${s.failed}` }),
        s.chainFailed && notice({ kind: "warn", text: `This network's node did not give this address's past deals, so only the deals this browser knows are listed. ${s.chainFailed}` }),
        s.notice && notice(s.notice),
        h("p", { class: "hint", testid: "history-count", role: "status" }, s.rows === null ? "Reading the deals…"
          : `${shown.length} deal${shown.length === 1 ? "" : "s"} shown, read from ${networkName(config.chainId)} at block ${s.block.number}.`),
        h("a", { class: "button primary", testid: "prepare", href: "#/v3/new" }, "Prepare a broker deal")),
      s.rows !== null && shown.length === 0 && card(h("p", { class: "lead", testid: "no-deals" }, address
        ? "No deals here yet. A deal appears once you prepare its link in this browser, open its link here, or once the chain has it for this address."
        : "No deals here yet. Prepare a deal, open a deal's link, or enter an address to see the deals the chain has for it.")),
      h("ol", { class: "deal-list", testid: "deal-list" }, shown.map(row)));
  }

  /** Whose deals are listed: the connected wallet's, or those of an address typed in. */
  function identity(address) {
    if (wallet?.account) {
      return h("p", { class: "notice info", testid: "history-who", role: "status" }, `Listing the deals of your wallet, ${wallet.account}, and the deals this browser knows.`);
    }
    const input = h("input", { id: "who", testid: "who", class: "mono", placeholder: "An address, 0x…", autocomplete: "off", autocapitalize: "off", spellcheck: "false", value: s.typed,
      oninput: (e) => {
        s.typed = e.currentTarget.value.trim();
        if (s.typed && !isAddress(s.typed)) return render();
        try {
          localStorage.setItem(key, s.typed);
        } catch {} // no storage: the address is asked for again next time
        load();
      } });
    return h("div", { class: "field" }, h("label", { for: "who" }, "Whose deals: an address that brokers, sells or buys"), input,
      h("p", { class: `note${s.typed && !isAddress(s.typed) ? " problem" : ""}`, testid: "history-who" }, s.typed && !isAddress(s.typed) ? "An address is 0x followed by 40 letters and digits."
        : address ? `Listing the deals the chain has for ${short(address)}, and the deals this browser knows. Reading needs no wallet.`
          : "Listing the deals this browser knows. Enter an address, or connect a wallet, to add the deals the chain has for it."),
      wallet && secondary("connect-action", s.busy ?? "Connect wallet", !s.busy && connect));
  }

  /** One deal of the list: its pair and price, its state now, the viewer's role, the broker's share, its deadline, its receipt, and its link. */
  function row({ id, t, base, quote, status, state, role, how, receipt }) {
    const m = money(t.quote, t.brokerBps), now = Math.max(s.block.time, Date.now() / 1000), payload = packTerms(t), link = linkOf(app, payload);
    const open = state === "awaiting" || state === "funded";
    const left = state === "expired" ? Math.min(-1, settleBy(t) - now) : settleBy(t) - now; // an expired deal's deadline is behind it, even by a second
    const noReceipt = status === "funded" ? (open ? "Funded; not settled yet. Its page lists the funding transaction." : "Funded, then expired before it was settled: the seller can take the tokens back.")
      : "None yet: nothing was deposited or paid.";
    return h("li", { class: "card deal-row", testid: "deal-row", "data-id": id, "data-status": state, "data-role": role },
      h("div", { class: "card-head" }, h("h2", { testid: "row-pair" }, `${base.symbol} / ${quote.symbol}`),
        h("span", { class: `status ${state}`, testid: "row-status", "data-status": state }, WORDS[state])),
      h("p", { class: "lead" }, `${amount(t.allocation, base)} for ${amount(t.quote, quote)}, ${t.delivery === VESTING ? "delivered as a vesting grant" : "delivered at once"}.`),
      h("dl", { class: "facts" },
        fact("Your role", h("span", { testid: "row-role" }, ROLE_WORDS[role])),
        fact("Price", h("span", { testid: "row-quote" }, amount(t.quote, quote))),
        fact(`Broker's share: ${percent(t.brokerBps)} of both fees`, h("span", { testid: "row-share" }, amount(m.brokerFee, quote)),
          state === "settled" ? " paid at settlement" : open ? " if the deal settles" : " not paid: the deal did not settle"),
        fact(DEADLINE[state], h("span", { testid: "row-deadline", "data-seconds": String(settleBy(t)) }, utc(settleBy(t))), open || state === "expired" ? ` (${fromNow(left)})` : ""),
        fact("Seller and buyer", h("span", { class: "mono" }, `${short(t.seller)} → ${short(t.buyer)}`)),
        fact("Receipt", h("span", { testid: "row-receipt", "data-kind": receipt?.kind ?? "none" }, receipt ? `${receipt.kind === "settled" ? "Settled" : "Refunded"} in block ${receipt.block}: ` : noReceipt),
          receipt && transaction(receipt.hash, explorer)),
        fact("Deal ID", h("span", { class: "mono" }, short(id)), how === "prepared" ? " · prepared in this browser" : how === "opened" ? " · opened in this browser" : " · found on the chain")),
      h("div", { class: "row wrap" },
        h("a", { class: "button secondary", testid: "row-open", href: link }, receipt ? "Open the receipt" : "Open the deal"),
        copyButton(`${location.href.split("#")[0]}${link}`),
        h("a", { class: "button secondary", testid: "row-duplicate", href: `#/v3/new/${payload}` }, "Duplicate terms")));
  }

  async function connect() {
    s.busy = "Connecting…";
    s.notice = null;
    render();
    try {
      await wallet.connect();
    } catch (e) {
      s.notice = { kind: "error", text: explain(e) };
    }
    s.busy = null;
    await load();
  }

  load();
  return {
    update: () => load(),
    stop() {
      live = false;
      reads++;
      clearInterval(poll);
      removeEventListener("focus", onFocus);
      app.main.classList.remove("wide");
    },
  };
}
