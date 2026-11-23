// A deal's page, #/d/<id>: what the taker pays and receives, from whom, until when, and the one button that moves the
// deal forward (connect, switch network, approve, fill). It reads the deal with or without a wallet and follows it.
import { approveExactly, cancelData, explain, fillData, same, transact, ZERO_ADDRESS } from "./eth.js";
import { action, amount, card, copyButton, fact, fromNow, h, head, leg, networkName, NO_WALLET, notice, secondary, short, show, when } from "./ui.js";

export function dealPage(app, idText) {
  const { config, chain, wallet } = app;
  const id = /^\d{1,78}$/.test(idText) && BigInt(idText) < 2n ** 256n ? BigInt(idText) : null;
  const s = { deal: null, sell: null, buy: null, chainTime: 0, funds: null, failed: null, busy: null, notice: null, done: null };
  let live = true, reads = 0, expiryTimer;
  const poll = setInterval(() => s.busy || load(), 5000);
  const onFocus = () => s.busy || load();
  addEventListener("focus", onFocus);

  /** Reads the deal, its tokens and what the connected wallet holds of the token it pays, then shows them. */
  async function load() {
    const read = ++reads;
    try {
      const deal = id === null ? { status: "none" } : await chain.deal(id);
      const [chainTime, sell, buy, funds] = deal.status === "none" ? [0]
        : await Promise.all([chain.now(), chain.token(deal.sellToken), chain.token(deal.buyToken), fundsFor(deal)]);
      if (read !== reads) return; // a later read is on its way
      Object.assign(s, { deal, chainTime, sell, buy, funds, failed: null });
    } catch (e) {
      if (read !== reads) return;
      s.failed = explain(e);
    }
    render();
  }

  async function fundsFor(deal) {
    const account = wallet?.account;
    if (!account || deal.status !== "open" || !mayFill(deal, account)) return null;
    const [balance, allowance] = await Promise.all([chain.balanceOf(deal.buyToken, account), chain.allowance(deal.buyToken, account)]);
    return { account, balance, allowance };
  }

  const mayFill = (deal, account) => !same(account, deal.maker) && (deal.taker === ZERO_ADDRESS || same(account, deal.taker));
  const now = () => Math.max(s.chainTime, Date.now() / 1000);

  function render() {
    if (!live) return;
    show(app.main, view()); // changed in place: the focus, and any text selected, stay where they are
    clearTimeout(expiryTimer);
    const left = s.deal?.status === "open" ? Number(s.deal.expiry) - now() : 0;
    if (left > 0 && left < 86_400) expiryTimer = setTimeout(render, left * 1000 + 250); // the page turns to "expired" on time
  }

  /** Runs one press: `work(stage)` sends what it must, and the buttons come back once the chain has been read again. */
  async function act(label, step, work) {
    s.notice = null;
    s.busy = { label, step, hint: "" };
    render();
    try {
      await work((hint) => {
        s.busy.hint = hint;
        render();
      });
    } catch (e) {
      s.notice = { kind: "error", text: explain(e) };
    }
    await load();
    s.busy = null;
    render();
  }

  function view() {
    if (!s.deal) {
      if (!s.failed) return card(h("p", { class: "loading" }, `Loading deal #${idText.slice(0, 80)}…`));
      return card(h("h1", {}, `Deal #${idText.slice(0, 80)}`), notice({ kind: "error", text: `This deal could not be read. ${s.failed}` }),
        h("button", { class: "secondary", type: "button", onclick: () => load() }, "Try again"));
    }
    if (s.deal.status === "none") {
      return card(head(id === null ? "Not a deal link" : `Deal #${idText}`, "not-found"),
        h("p", { class: "lead" }, id === null
          ? "This link does not end with a deal number. Ask the person who sent it for the whole link."
          : `There is no deal #${idText} on ${networkName(config.chainId)}. Check that you have the whole link, or ask the person who sent it.`),
        h("a", { class: "button secondary", href: "#/new" }, "Make a deal of your own"));
    }
    const d = s.deal, me = wallet?.account;
    const status = d.status === "open" && now() >= Number(d.expiry) ? "expired" : d.status;
    const mine = Boolean(me && same(me, d.maker));
    const taking = status === "open" && !mine && (!me || mayFill(d, me));
    const [payLabel, receiveLabel] = s.done?.filled ? ["You paid", "You received"]
      : mine ? ["You get", "You give"] : taking ? ["You pay", "You receive"] : ["The taker pays", "The taker receives"];
    const get = amount(d.sellAmount, s.sell), standing = status === "open" || status === "expired";
    document.title = `Deal #${idText}: ${amount(d.buyAmount, s.buy)} for ${get} · otc.fam`;
    return card(
      head(`Deal #${idText}`, status, "v1"),
      h("p", { class: "lead" }, lead(status, mine, taking)),
      leg(payLabel, d.buyAmount, s.buy, "pay"),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      leg(receiveLabel, d.sellAmount, s.sell, "receive"),
      status === "open" && h("p", { class: "held" }, mine
        ? `Your ${get} are locked in the deal contract until the deal is filled or you cancel it.`
        : `The maker's ${get} are already locked in the deal contract. Filling swaps both sides in one transaction.`),
      h("dl", { class: "facts" },
        fact("From", h("span", { class: "mono", testid: "maker" }, d.maker), mine && " (you)"),
        standing && (d.taker === ZERO_ADDRESS ? fact("Who can fill", "Anyone who has this link")
          : fact("Reserved for", h("span", { class: "mono" }, d.taker), me && same(me, d.taker) && " (you)")),
        standing && h("div", {}, h("dt", {}, status === "open" ? "Expires" : "Expired"),
          h("dd", { testid: "expires", "data-expiry": String(d.expiry), class: status === "open" && Number(d.expiry) - now() < 900 ? "soon" : null },
            when(Number(d.expiry), now())))),
      status === "open" ? actions(d) : ended(status, mine));
  }

  function lead(status, mine, taking) {
    const d = s.deal, pay = amount(d.buyAmount, s.buy), get = amount(d.sellAmount, s.sell);
    if (status === "open") {
      if (mine) return "Your offer is open. Send this link to the other side: they fill it from their wallet.";
      if (taking) return "You are offered a swap. Check what you pay and what you receive, then fill it from your wallet.";
      return "This deal is reserved for another address.";
    }
    if (status === "filled") {
      if (s.done?.filled) return `Done: you paid ${pay} and received ${get}.`;
      if (mine) return `Your deal was filled: you received ${pay} for your ${get}.`;
      return "This deal was filled: the two sides swapped their tokens. Nothing is left to do.";
    }
    if (status === "cancelled") {
      if (mine) return `You cancelled this deal: your ${get} went back to your wallet.`;
      return `The maker cancelled this deal and took back their ${get}. It can no longer be filled.`;
    }
    return `This deal expired ${fromNow(Number(d.expiry) - now())}. It can no longer be filled.`;
  }

  /** What a filled, cancelled or expired deal offers: nothing to fill; to its maker, an expired deal's tokens back. */
  function ended(status, mine) {
    const get = amount(s.deal.sellAmount, s.sell);
    if (status === "filled" && s.done?.filled) {
      return h("p", { class: "success" }, `The swap went through in transaction ${s.done.hash.slice(0, 10)}…${s.done.hash.slice(-8)}. The ${get} are in your wallet.`);
    }
    if (status !== "expired") return s.notice && h("div", { class: "action" }, notice(s.notice));
    if (!mine) {
      return h("div", { class: "action" },
        h("p", { class: "hint" }, `The maker's ${get} stay in the deal contract until they cancel the deal and take them back.`),
        wallet && !wallet.account && secondary("connect-action", s.busy?.label ?? "Made this deal? Connect to take your tokens back", !s.busy && connect),
        s.notice && notice(s.notice));
    }
    return h("div", { class: "action" },
      secondary("cancel-action", s.busy?.label ?? `Cancel it and take back your ${get}`, !s.busy && cancel),
      s.busy?.hint && h("p", { class: "hint" }, s.busy.hint),
      s.notice && notice(s.notice));
  }

  /** The button that moves an open deal forward (connect, switch network, approve, fill), and what it is about to do. */
  function actions(d) {
    const me = wallet?.account, buy = s.buy, steps = ["Connect", `Approve ${buy.symbol}`, "Fill"];
    const pay = amount(d.buyAmount, buy), get = amount(d.sellAmount, s.sell);
    if (s.busy?.step === null) return action({ hint: s.busy.hint, extra: secondary("cancel-action", s.busy.label) });
    if (s.busy) return action({ steps, step: s.busy.step, button: { label: s.busy.label }, hint: s.busy.hint });
    if (!wallet) {
      return action({ steps, step: 0, button: { label: "Connect a wallet to fill" }, notice: { kind: "info", text: NO_WALLET }, extra: copyButton(location.href) });
    }
    if (!me) {
      return action({ steps, step: 0, button: { label: "Connect wallet", run: connect }, hint: "Connect the wallet you will pay from. Nothing is sent yet.",
        notice: s.notice });
    }
    if (same(me, d.maker)) {
      return action({ notice: { kind: "info", text: `This is your own deal: you cannot fill it. Until someone does, you can cancel it and take back your ${get}.` },
        extra: secondary("cancel-action", `Cancel the deal and take back ${get}`, cancel) });
    }
    if (!mayFill(d, me)) {
      return action({ notice: { kind: "warn", text: `This deal is for another address: only ${d.taker} can fill it. `
        + `Your wallet is connected as ${short(me)}, so it cannot. If that other address is yours too, switch to it in your wallet.` } });
    }
    if (wallet.chainId !== config.chainId) {
      return action({ steps, step: 0, button: { label: `Switch to ${networkName(config.chainId)}`, run: switchNetwork },
        hint: `Your wallet is on ${networkName(wallet.chainId)}, and this deal is on ${networkName(config.chainId)}.`, notice: s.notice });
    }
    const f = s.funds;
    if (!f || f.account !== me) return action({ steps, step: 1, button: { label: `Checking your ${buy.symbol}…` } });
    if (f.balance < d.buyAmount) {
      return action({ steps, step: 1, button: { label: `Not enough ${buy.symbol}` },
        notice: { kind: "warn", text: `To fill this deal you pay ${pay}, and this wallet holds ${amount(f.balance, buy)}.` } });
    }
    if (f.allowance < d.buyAmount) {
      return action({ steps, step: 1, button: { label: `Approve ${pay}`, run: approve },
        hint: `This lets the deal contract take exactly ${pay} from your wallet, and only when you fill. Nothing moves yet.`, notice: s.notice });
    }
    return action({ steps, step: 2, button: { label: `Fill: pay ${pay}`, run: fill },
      hint: `One transaction: your ${pay} go to the maker and their ${get} come to you. Both happen, or nothing moves.`, notice: s.notice });
  }

  const connect = () => act("Connecting…", 0, () => wallet.connect());
  const switchNetwork = () => act("Switching network…", 0, () => wallet.switchTo(config.chainId));
  const approve = () => act(`Approving ${amount(s.deal.buyAmount, s.buy)}…`, 1, (stage) => approveExactly(app, s.buy, s.deal.buyAmount, s.funds.allowance, stage));
  const fill = () => act("Filling the deal…", 2, async (stage) => {
    const what = `Paying ${amount(s.deal.buyAmount, s.buy)} for ${amount(s.deal.sellAmount, s.sell)}`;
    const receipt = await transact(app, config.contract, fillData(id), stage, what);
    s.done = { filled: true, hash: receipt.transactionHash };
  });
  const cancel = () => act("Cancelling…", null, (stage) => transact(app, config.contract, cancelData(id), stage, "Cancelling the deal"));

  load();
  return {
    update: () => s.busy || load(),
    stop() {
      live = false;
      clearInterval(poll);
      clearTimeout(expiryTimer);
      removeEventListener("focus", onFocus);
    },
  };
}
