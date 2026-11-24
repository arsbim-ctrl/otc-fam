import { explain } from "./eth.js";
import { card, h, notice, show, transaction, utc } from "./ui.js";
import { dealState, payment } from "./v3.js";
import {
  actionButton, copyLink, createHref, dealHref, displayNetwork, heading, listenForUpdates,
  mono, nav, percent, problem, readTokens, roleWallets, savedLinks, statePill, valueOf,
} from "./v3-common.js";

const WINDOW = 10_000;
const roleTitle = { broker: "Broker", seller: "Seller", buyer: "Buyer" };

export function historyPage({ main, chain, v3, wallet, explorer }) {
  document.title = "Broker deal history · otc.fam";

  let stopped = false, inFlight = false, queued = false, role = "broker", account = wallet?.account;
  let rows = null, error = "", loading = false, connecting = false, walletError = "";
  let fromLimit = null, firstBlock = null;

  const controls = h("div", { class: "broker-history-controls" });
  const view = h("div", { class: "broker-history-view" });
  const select = h("select", { id: "broker-history-role", testid: "broker-history-role", onchange: (event) => {
    role = event.currentTarget.value;
    clear();
    update();
  } }, roleWallets.map(key => h("option", { value: key }, roleTitle[key])));
  main.replaceChildren(h("div", { class: "broker-layout broker-history" }, nav(),
    card(heading("Deal history"),
      h("p", { class: "lead" }, "Find funded deals onchain by the role of your connected wallet. Prepared links also appear in the browser that created them."),
      h("div", { class: "broker-history-filter" }, h("label", { for: select.id }, "Show deals as"), select), controls), view));

  const stopWatching = listenForUpdates(refresh, 10_000);
  update();

  function clear() {
    rows = null;
    error = "";
    fromLimit = null;
    firstBlock = null;
  }

  function update() {
    if (wallet?.account !== account) {
      account = wallet.account;
      clear();
    }
    render();
    void refresh();
  }

  async function connect() {
    connecting = true;
    walletError = "";
    render();
    try {
      await wallet.connect();
    } catch (error) {
      walletError = explain(error);
    } finally {
      connecting = false;
      update();
    }
  }

  async function refresh() {
    if (stopped || !account) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    loading = true;
    const selected = role, owner = account;
    const valid = () => !stopped && selected === role && owner === account;
    if (rows === null) render();
    try {
      const block = await v3.block();
      if (!valid()) return;
      const from = Math.max(v3.fromBlock, Math.min(fromLimit ?? Infinity, block.number - WINDOW + 1));
      const ids = await v3.discover(selected, owner, from, block.number);
      const locals = savedLinks(v3.domain, selected, owner);
      const localById = new Map(locals.map(record => [record.id, record]));
      const unique = [...new Set([...ids, ...localById.keys()])];
      const found = [];
      for (let start = 0; start < unique.length; start += 8) {
        const batch = await Promise.all(unique.slice(start, start + 8).map(async (id) => {
          const local = localById.get(id);
          const deal = local ? await v3.readProposal(local, block.number) : await v3.deal(id, block.number);
          if (!deal.status && !local) return null;
          const [tokens, events] = await Promise.all([
            readTokens(chain, deal.terms),
            deal.status > 1 ? v3.receipts(id, block.number).catch(() => []) : [],
          ]);
          return { ...deal, id, tokens, events, local, state: dealState(deal.status, deal.terms, block.time, deal.used) };
        }));
        if (!valid()) return;
        found.push(...batch.filter(Boolean));
      }
      if (!valid()) return;
      rows = found;
      firstBlock = from;
      error = "";
    } catch (cause) {
      if (valid()) error = explain(cause);
    } finally {
      loading = false;
      inFlight = false;
      if (!stopped) render();
      if (queued) {
        queued = false;
        void refresh();
      }
    }
  }

  function older() {
    fromLimit = Math.max(v3.fromBlock, firstBlock - WINDOW);
    void refresh();
  }

  function render() {
    if (stopped) return;
    show(controls, h("div", { class: "history-wallet" }, wallet?.account
      ? h("p", { class: "hint" }, `${roleTitle[role]} wallet `, mono(wallet.account))
      : wallet ? actionButton("broker-history-connect", "Connect wallet", connect, connecting, "secondary")
        : h("p", { class: "hint" }, "Open the history in a browser with a wallet to see its deals."),
    walletError && problem(walletError)));

    const content = [];
    if (error) content.push(problem(`Could not refresh this history. ${error}`), actionButton("broker-history-refresh", "Retry", refresh, false, "secondary"));
    if (account) {
      if (rows === null && loading) content.push(notice({ kind: "info", text: "Reading deal history…" }));
      if (rows?.length === 0) content.push(card(h("p", { class: "hint", testid: "broker-history-empty" },
        `No ${role} deals found for this wallet in the blocks shown.`)));
      if (rows?.length) content.push(h("ul", { class: "broker-history-list", testid: "broker-history-list" }, rows.map(row => {
        const { terms, state, id, tokens: [base, quote] } = row;
        const link = dealHref(v3.domain, terms);
        const event = row.events.findLast(item => item.name !== "BrokerDealFunded");
        return h("li", {}, card(
          h("div", { class: "card-head" },
            h("h2", {}, h("a", { href: link, testid: `broker-history-deal-${id}` }, `${base.symbol || "Base"} / ${quote.symbol || "Quote"}`)),
            statePill(state)),
          row.local && role === "broker" && h("p", { class: "hint" }, "Created in this browser"),
          h("dl", { class: "facts broker-scope" },
            h("div", {}, h("dt", {}, "Quote"), h("dd", {}, valueOf(terms.quote, quote))),
            h("div", {}, h("dt", {}, "Broker share"), h("dd", {}, `${percent(terms.brokerBps)} · ${valueOf(payment(terms).brokerFee, quote)}`)),
            h("div", {}, h("dt", {}, "Deadline"), h("dd", {}, utc(terms.expiry))),
            h("div", {}, h("dt", {}, "Network"), h("dd", {}, displayNetwork(v3.domain.chainId)))),
          event && h("p", { class: "hint" }, event.name === "BrokerDealSettled" ? "Settlement transaction " : "Refund transaction ",
            transaction(event.hash, explorer)),
          h("div", { class: "broker-link-actions" }, copyLink(link, `copy-${id}`),
            h("a", { class: "button secondary", href: createHref(v3.domain, terms) }, "Duplicate terms"))));
      })));
      if (firstBlock > v3.fromBlock) content.push(actionButton("broker-history-older", "Load older onchain deals", older, loading, "secondary"));
    }
    show(view, h("div", { class: "broker-history-results" }, content));
  }

  return { update, stop() { stopped = true; stopWatching(); } };
}
