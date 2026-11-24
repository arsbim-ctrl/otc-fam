import { h, show, utc } from "./ui.js";
import { brokerError, directory, effectiveStatus, feesFor, percent, readProposal, roleFor, STAGE, toHex } from "./v3-protocol.js";
import { button, header, message, panel, share, shell, tokenAmount, v3Link } from "./v3-view.js";

const titles = { seller: "Seller", buyer: "Buyer", broker: "Broker" };
const statusList = ["awaiting", "funded", "settled", "expired", "refunded", "unavailable"];

export function brokerHistoryPage(app, protocol, duplicate) {
  const book = directory(protocol.domain);
  let stopped = false, revision = 0, loading = false, entries = [], error = "", connectError = "";
  let selectedRole = "", selectedStage = "", seenAccount;
  document.title = "Broker deal book · otc.fam";

  async function load() {
    if (stopped) return;
    const run = ++revision;
    const account = app.wallet?.account;
    if (account !== seenAccount) entries = [];
    seenAccount = account;
    error = "";
    loading = Boolean(account && app.wallet.chainId === protocol.domain.chainId);
    render();
    if (!loading) return;
    try {
      await protocol.checkNetwork();
      const block = await app.chain.block();
      const at = toHex(block.number);
      const local = new Map(book.list(account).map((item) => [item.id, item]));
      const found = await protocol.history(account, block.number).catch((e) => {
        if (run === revision) error = `Onchain history could not load. ${brokerError(e)}`;
        return [];
      });
      const ids = [...new Set([...local.keys(), ...found])];
      const items = await Promise.all(ids.map(async (id) => {
        const deal = await protocol.deal(id, at);
        const saved = local.get(id);
        let path = v3Link(id), terms = deal.terms, nonceUsed = false;
        if (saved?.path.startsWith("#/v3/p/")) {
          try {
            const proposal = readProposal(protocol.domain, saved.path.slice(7));
            if (proposal.id === id) {
              path = saved.path;
              terms ??= proposal.terms;
            }
          } catch {}
        }
        if (!terms) return null;
        const role = roleFor(terms, account);
        if (!role) return null;
        if (!deal.terms) [nonceUsed] = await protocol.read("usedNonce", [terms.seller, terms.nonce], at);
        const [base, quote] = await Promise.all([app.chain.token(terms.baseToken), app.chain.token(terms.quoteToken)]);
        const stage = effectiveStatus({ ...deal, terms, nonceUsed }, block.time);
        return { id, path, terms, role, stage, created: saved?.created, base, quote };
      }));
      if (run === revision) entries = items.filter(Boolean);
    } catch (e) {
      if (run === revision) error = brokerError(e);
    } finally {
      if (run === revision) {
        loading = false;
        render();
      }
    }
  }

  async function requestWallet(target, work) {
    target.disabled = true;
    connectError = "";
    try {
      await work();
      await load();
    } catch (error) {
      connectError = brokerError(error);
      render();
    } finally {
      target.disabled = false;
      if (target.isConnected) target.focus({ preventScroll: true });
    }
  }

  function entry(row) {
    const { id, role, stage, terms, path, created, base, quote } = row;
    const href = path;
    const receipt = ["settled", "refunded", "funded"].includes(stage);
    return h("li", { class: "broker-entry-card", testid: "v3-book-entry", "data-role": role, "data-status": stage, "data-deal": id },
      h("div", { class: "broker-entry-top" },
        h("h2", {}, `${base.symbol || "Base token"} / ${quote.symbol || "Payment token"}`),
        h("span", { class: `broker-stage ${stage}` }, STAGE[stage])),
      h("p", { class: "broker-muted" }, `${titles[role]} · ${terms.delivery ? "New vesting grant" : "Immediate transfer"}${created ? " · Link created here" : ""}`),
      h("dl", { class: "broker-facts broker-entry-facts" },
        h("div", {}, h("dt", {}, "Quote"), h("dd", {}, tokenAmount(terms.quote, quote))),
        h("div", {}, h("dt", {}, "Broker share"), h("dd", {}, `${percent(terms.brokerBps)} · ${tokenAmount(feesFor(terms).brokerFee, quote)}`)),
        h("div", {}, h("dt", {}, "Deadline"), h("dd", {}, utc(terms.expiry)))),
      h("div", { class: "broker-entry-actions" },
        h("a", { class: "button primary", href, testid: `v3-open-${id}` }, receipt ? "Open deal and receipt" : "Open proposal"),
        share(href, `v3-copy-${id}`),
        button("Duplicate terms", () => duplicate(row), { id: `v3-duplicate-${id}`, secondary: true })));
  }

  function render() {
    if (stopped) return;
    const wallet = app.wallet, ready = wallet?.account && wallet.chainId === protocol.domain.chainId;
    const shown = entries.filter((row) => (!selectedRole || row.role === selectedRole) && (!selectedStage || row.stage === selectedStage));
    const filter = (label, id, choices, value, set) => {
      const options = [["", "All"], ...choices].map(([key, text]) => h("option", { value: key, selected: key === value }, text));
      return h("div", { class: "broker-field" }, h("label", { for: id }, label), h("select", {
        id, testid: id, onchange: (event) => { set(event.currentTarget.value); render(); },
      }, options));
    };
    const state = !wallet ? h("p", { class: "broker-muted" }, "Open this page in a wallet-enabled browser to see your deal book.")
      : !wallet.account ? button("Connect wallet", (target) => requestWallet(target, () => wallet.connect()))
        : !ready ? button("Switch to the deal network", (target) => requestWallet(target, () => wallet.switchTo(protocol.domain.chainId)))
          : button("Refresh history", () => load(), { id: "v3-book-refresh", secondary: true, disabled: loading });
    const rows = panel(
      h("div", { class: "broker-book-tools" },
        filter("Role", "v3-role-filter", Object.entries(titles), selectedRole, (value) => { selectedRole = value; }),
        filter("Status", "v3-stage-filter", statusList.map((key) => [key, STAGE[key]]), selectedStage, (value) => { selectedStage = value; }),
        state),
      h("p", { class: "broker-muted", testid: "v3-book-status", role: "status" },
        loading ? "Reading deal history…" : `${shown.length} ${shown.length === 1 ? "deal" : "deals"} for the connected wallet.`),
      ready && !shown.length && !loading && h("p", { class: "broker-callout" }, entries.length
        ? "No deals match those filters." : "Funded deals appear from onchain events. Unfunded links appear when created or opened in this browser with this wallet."),
      h("ul", { class: "broker-entry-list" }, shown.map(entry)));
    show(app.main, shell("history",
      header("Deal book", "Find proposals and receipts for the connected wallet. Unfunded links are saved in this browser."),
      connectError && message(connectError, true), error && message(error, true),
      ready ? rows : panel(state)));
  }

  const wake = () => { if (!document.hidden && !loading) load(); };
  addEventListener("focus", wake);
  load();
  return { update: load, stop() { stopped = true; revision++; removeEventListener("focus", wake); } };
}
