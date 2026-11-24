// A v2 deal's page, #/v2/d/<id>: one link for the whole life of a deal. Before settlement it shows the buyer what
// they pay (price and fee), what they receive and how (at once, or as a vesting grant), that the allocation is
// really held on the chain, and the one button that settles. After a vesting settlement it is the grant's page too
// (v2-grant.js), and every transaction it knows of is listed as a receipt (v2-receipts.js). This file reads the
// chain, with or without a wallet, draws the deal's own card, and sends the transactions (through flow.js).
import { approveExactly, explain, same, transact } from "./eth.js";
import { flow } from "./flow.js";
import { action, amount, card, copyButton, fact, fromNow, h, head, leg, networkName, NO_WALLET, notice, secondary, short, show, span, TOKEN_WARNING, utc } from "./ui.js";
import { formatAmount } from "./units.js";
import { grantCard } from "./v2-grant.js";
import { receiptsCard } from "./v2-receipts.js";
import { cancelData, claimData, fillData, money } from "./v2.js";

export function dealPageV2(app, idText) {
  const { config, chain, wallet, v2 } = app;
  const id = /^\d{1,78}$/.test(idText) && BigInt(idText) < 2n ** 256n ? BigInt(idText) : null;
  // history: undefined until the deal's events are read, null when the node would not give them, else the list.
  const s = { deal: null, base: null, quote: null, block: null, escrow: 0n, buyerHolds: 0n, treasury: null, grant: null, funds: null, history: undefined,
    historyOf: null, failed: null, busy: null, notice: null, receipt: null };
  let live = true, reads = 0, timer;
  const poll = setInterval(() => s.busy || load(), 5000);
  const onFocus = () => s.busy || load();
  addEventListener("focus", onFocus);
  app.main.classList.add("wide");
  const presses = flow({ app, s, key: `otcfam:pending:${config.chainId}:${v2?.contract}:deal:${idText}`, render,
    async settle(receipt, label) {
      if (receipt?.transactionHash) s.receipt = { what: label.replace(/…$/, ""), hash: receipt.transactionHash, block: Number(receipt.blockNumber), gas: BigInt(receipt.gasUsed) };
      await load();
    } });

  /** Reads the deal, its tokens, its funding, its grant and what the wallets concerned hold, then shows them. */
  async function load() {
    if (!v2) return render();
    const read = ++reads;
    try {
      const deal = id === null ? { status: "none" } : await v2.deal(id);
      const [{ treasury }, block, base, quote, escrow, buyerHolds, grant, funds] = deal.status === "none" ? [{}]
        : await Promise.all([v2.setup(), chain.block(), chain.token(deal.baseToken), chain.token(deal.quoteToken), chain.balanceOf(deal.baseToken, v2.contract),
          chain.balanceOf(deal.baseToken, deal.buyer), deal.grantId ? v2.grant(deal.grantId) : null, fundsFor(deal)]);
      if (read !== reads) return; // a later read is on its way
      Object.assign(s, { deal, treasury, block, base, quote, escrow, buyerHolds, grant, funds, failed: null });
      readHistory();
    } catch (e) {
      if (read !== reads) return;
      s.failed = explain(e);
    }
    render();
  }

  async function fundsFor(deal) {
    const account = wallet?.account;
    if (!account || deal.status !== "funded" || !same(account, deal.buyer)) return null;
    const [balance, allowance] = await Promise.all([chain.balanceOf(deal.quoteToken, account), chain.allowance(deal.quoteToken, account, v2.contract)]);
    return { account, balance, allowance };
  }

  /** Reads the deal's events again whenever something happened to it: they are its receipts. */
  async function readHistory() {
    const of = `${s.deal.status}:${s.grant?.claimed ?? ""}`;
    if (of === s.historyOf || s.deal.status === "none") return;
    s.historyOf = of;
    const history = await v2.history(id).catch(() => null);
    if (of !== s.historyOf) return; // the deal has changed since: a later read is on its way
    if (history) s.history = history;
    else {
      s.history ??= null; // a failed re-read keeps the list it had
      s.historyOf = null; // and is tried again the next time the deal is read
    }
    render();
  }

  const now = () => Math.max(s.block?.time ?? 0, Date.now() / 1000);
  /** Whether a funded vesting deal's fixed start has passed: a grant cannot start before it is funded. */
  const startPassed = (d) => d.delivery === "vesting" && d.fixedStart > 0 && now() > d.fixedStart;
  /** A deal's state as the page says it: a funded deal that can no longer be settled is "expired". */
  const stateOf = (d) => (d.status === "funded" && (now() >= d.expiry || startPassed(d)) ? "expired" : d.status);
  /** Until when a funded deal can be settled, in unix seconds: its expiry, or its fixed vesting start if that comes first. */
  const settleBy = (d) => (d.delivery === "vesting" && d.fixedStart > 0 ? Math.min(d.expiry, d.fixedStart) : d.expiry);

  function render() {
    if (!live) return;
    show(app.main, view());
    clearTimeout(timer);
    const left = s.deal?.status === "funded" ? settleBy(s.deal) - now() : -1;
    // The page turns to "expired" on time: a deal can still be settled in the very second of a fixed start.
    if (left >= 0 && left < 86_400) timer = setTimeout(render, left * 1000 + 1250);
  }

  /** After a reload, while the transaction sent before it is awaited: what is awaited, and a way to stop waiting. */
  const waiting = () => s.busy?.waiting && h("div", { class: "action" }, h("p", { class: "notice info", testid: "waiting", role: "status" }, s.busy.hint),
    secondary("stop-waiting", "Stop waiting for it", () => presses.stopWaiting("Stopped waiting. If that transaction is confirmed later, this page shows its result the next time it reads the chain.")));
  const busyHint = () => !s.busy.waiting && s.busy.hint;

  function view() {
    if (!v2) {
      return card(h("h1", {}, "v2 deals are not set up here"),
        h("p", { class: "lead" }, "This site's config.json names no v2 deal contract (contractV2), so deals with fees and vesting cannot be read here."),
        h("a", { class: "button secondary", href: "#/" }, "Back to the start"));
    }
    if (!s.deal) {
      if (!s.failed) return card(h("p", { class: "loading" }, `Loading deal #${idText.slice(0, 80)}…`));
      return card(h("h1", {}, `Deal #${idText.slice(0, 80)}`), notice({ kind: "error", text: `This deal could not be read. ${s.failed}` }),
        h("button", { class: "secondary", type: "button", onclick: () => load() }, "Try again"));
    }
    if (s.deal.status === "none") {
      return card(head(id === null ? "Not a deal link" : `Deal #${idText}`, "not-found", "v2"),
        h("p", { class: "lead" }, id === null
          ? "This link does not end with a deal number. Ask the person who sent it for the whole link."
          : `There is no v2 deal #${idText} on ${networkName(config.chainId)}. Check that you have the whole link, or ask the person who sent it.`),
        h("a", { class: "button secondary", href: "#/v2/new" }, "Make a deal of your own"));
    }
    return h("div", { class: "board" },
      // The last read failed: what is shown is what the chain said before, and the page says so.
      s.failed && h("p", { class: "notice warn", testid: "stale", role: "status" }, `The chain could not be read just now, so this page may be out of date. ${s.failed}`),
      dealCard(), s.grant && grantCard(app, s, { connect, switchNetwork, claim }), receiptsCard(app, s, idText));
  }

  function dealCard() {
    const d = s.deal, q = s.quote, m = money(d.quote), me = wallet?.account, status = stateOf(d), vesting = d.delivery === "vesting", done = d.status === "settled";
    const role = !me ? null : same(me, d.seller) ? "seller" : same(me, d.buyer) ? "buyer" : "other";
    const give = amount(d.allocation, s.base), standing = status === "funded" || status === "expired";
    const [payLabel, receiveLabel] = role === "seller" ? [done ? "The buyer paid" : "The buyer pays", done ? "You sold" : "You sell"]
      : role === "buyer" ? [done ? "You paid" : "You pay", done ? (vesting ? "Your grant holds" : "You received") : "You receive"]
      : [done ? "The buyer paid" : "The buyer pays", done ? (vesting ? "The buyer's grant holds" : "The buyer received") : "The buyer receives"];
    const sum = (label, testid, units, ...more) => fact(label, h("span", { testid }, formatAmount(units, q.decimals)), ` ${q.symbol}`, ...more);
    document.title = `Deal #${idText} (v2): ${give} for ${amount(d.quote, q)} · otc.fam`;
    return card(
      head(`Deal #${idText}`, status, "v2"),
      h("p", { class: `delivery ${d.delivery}`, testid: "delivery", "data-delivery": d.delivery },
        h("strong", {}, vesting ? "Vesting delivery" : "Immediate delivery"),
        vesting ? ": the buyer gets a new grant that unlocks over time. Settled does not mean unlocked." : ": the buyer gets the tokens in the settlement transaction."),
      h("p", { class: "lead" }, lead(d, status, role)),
      waiting(),
      leg(payLabel, m.buyerTotal, q, "pay", `Price ${amount(d.quote, q)} + 0.5% buyer fee ${amount(m.buyerFee, q)}`),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      leg(receiveLabel, d.allocation, s.base, "receive", vesting ? "As a vesting grant, held in a vault of its own." : "To the buyer's wallet, at settlement."),
      standing && funding(d, give, vesting, status),
      h("dl", { class: "facts" },
        fact("Seller", h("span", { class: "mono", testid: "seller" }, d.seller), role === "seller" && " (you)"),
        fact("Buyer, the only address that can settle", h("span", { class: "mono", testid: "buyer" }, d.buyer), role === "buyer" && " (you)"),
        sum("Price", "price", d.quote),
        sum("Buyer fee, 0.5% of the price", "buyer-fee", m.buyerFee),
        sum("Buyer pays in total", "buyer-total", m.buyerTotal),
        sum("Seller fee, 0.5% of the price", "seller-fee", m.sellerFee),
        sum("Seller receives", "seller-net", m.sellerNet),
        sum("Treasury receives both fees", "treasury-fee", m.feePool, h("span", { class: "mono block", testid: "treasury" }, s.treasury)),
        standing && h("div", {}, h("dt", {}, status === "funded" ? "Can be settled until" : "Could be settled until"),
          h("dd", { testid: "expires", "data-expiry": d.exact.expiry, class: status === "funded" && settleBy(d) - now() < 900 ? "soon" : null },
            `${utc(settleBy(d))} (${fromNow(settleBy(d) - now())})`)),
        vesting && !done && schedule(d)),
      status === "funded" && h("p", { class: "warning", testid: "token-warning" }, TOKEN_WARNING),
      status === "funded" ? actions(d, m, role) : ended(d, status, role));
  }

  /**
   * The line that says the allocation is really held. The contract only ever gives a deal the status "funded" in the
   * transaction that took its whole allocation; the page adds what the contract holds of that token now, for this
   * deal and any other, and warns if that is ever less than this deal's.
   */
  function funding(d, give, vesting, status) {
    const ok = s.escrow >= d.allocation;
    return h("p", { class: ok ? "held" : "held bad", testid: "funding", "data-funded": String(ok) }, ok
      ? `Funded on the chain: the deal contract took the seller's whole ${give} when this deal was made, and holds ${amount(s.escrow, s.base)} now `
        + `(read at block ${s.block.number}). ${status !== "funded" ? "" : vesting ? "Settling moves this deal's allocation into the buyer's grant." : "Settling sends this deal's allocation to the buyer."}`
      : `The deal contract holds only ${amount(s.escrow, s.base)}, less than this deal's ${give}. Do not settle it: tell the seller.`);
  }

  /** The vesting schedule of a deal that is not settled yet: fixed dates, or lengths counted from the settlement. */
  function schedule(d) {
    const fixed = d.fixedStart > 0, start = BigInt(d.fixedStart), atCliff = amount((d.allocation * d.cliffSeconds) / d.durationSeconds, s.base);
    const line = (label, testid, seconds, words) => fact(label, h("span", { testid, "data-seconds": String(seconds) }, words));
    return [
      line("Vesting starts", "schedule-start", d.exact.fixedStart, fixed ? utc(start) : "When the buyer settles, at that block's time"),
      line("Cliff", "schedule-cliff", d.cliffSeconds, d.cliffSeconds === 0n ? "None: unlocking begins with the start"
        : `${fixed ? `${utc(start + d.cliffSeconds)}, ` : ""}${span(d.cliffSeconds)} after the start. Nothing can be claimed before it; then ${atCliff} unlock at once.`),
      line("Fully vested", "schedule-end", d.durationSeconds, `${fixed ? `${utc(start + d.durationSeconds)}, ` : ""}${span(d.durationSeconds)} after the start. Until then it unlocks second by second.`),
    ];
  }

  function lead(d, status, role) {
    const vesting = d.delivery === "vesting";
    if (status === "funded") {
      if (role === "seller") return "Your deal is funded and waits for its buyer. Send them this link: they settle it from their wallet.";
      if (role === "buyer") return "This deal is for you. Check the tokens, the price, both fees and the delivery, then settle it from your wallet.";
      return "A private deal for one buyer. Anyone can check its terms and its funding here; only the buyer's wallet can settle it.";
    }
    if (status === "settled") {
      if (!vesting) return "Settled: in one transaction the buyer paid, the seller and the treasury were paid, and the tokens went to the buyer. Nothing is left to do.";
      return "Settled, not unlocked: the buyer paid, and the whole allocation moved into a vault that pays the buyer as the grant vests.";
    }
    if (status === "cancelled") return "The seller cancelled this deal and took the allocation back. It can no longer be settled, and no fee was taken.";
    if (now() >= d.expiry) return `This deal expired ${fromNow(d.expiry - now())}. It can no longer be settled.`;
    return `This deal's fixed vesting start passed ${fromNow(d.fixedStart - now())}. A grant cannot start before it is funded, so the deal can no longer be settled.`;
  }

  /** What a settled, cancelled or expired deal offers: nothing to settle; to its seller, an expired deal's tokens back. */
  function ended(d, status, role) {
    const give = amount(d.allocation, s.base), vesting = d.delivery === "vesting";
    if (status === "settled") {
      return h("div", { class: "action" },
        h("p", { class: "success" }, vesting ? `The grant is funded with all ${give}. Its schedule, and what can be claimed, are in the grant's card on this page.`
          : `Delivered: all ${give} went to the buyer's wallet in the settlement transaction. That wallet holds ${amount(s.buyerHolds, s.base)} now.`),
        !vesting && s.notice && notice(s.notice));
    }
    if (status === "cancelled") return s.notice && h("div", { class: "action" }, notice(s.notice));
    if (role !== "seller") {
      return h("div", { class: "action" },
        h("p", { class: "hint" }, `The seller's ${give} stay in the deal contract until the seller cancels the deal and takes them back.`),
        wallet && !wallet.account && secondary("connect-action", s.busy?.label ?? "Made this deal? Connect to take your tokens back", !s.busy && connect),
        s.notice && notice(s.notice));
    }
    return h("div", { class: "action" },
      secondary("cancel-action", s.busy?.label ?? `Cancel it and take back your ${give}`, !s.busy && cancel),
      s.busy && busyHint() && h("p", { class: "hint" }, s.busy.hint),
      s.notice && notice(s.notice));
  }

  /** The button that moves a funded deal forward (connect, switch network, approve, settle), and what it is about to do. */
  function actions(d, m, role) {
    const q = s.quote, me = wallet?.account, steps = ["Connect", `Approve ${q.symbol}`, "Settle"], vesting = d.delivery === "vesting";
    const total = amount(m.buyerTotal, q), give = amount(d.allocation, s.base);
    if (s.busy?.step === null) return action({ hint: busyHint(), extra: secondary("cancel-action", s.busy.label) });
    if (s.busy) return action({ steps, step: s.busy.step, button: { label: s.busy.label }, hint: busyHint() });
    if (!wallet) {
      return action({ steps, step: 0, button: { label: "Connect a wallet to settle" }, notice: { kind: "info", text: NO_WALLET }, extra: copyButton(location.href) });
    }
    if (!me) {
      return action({ steps, step: 0, button: { label: "Connect wallet", run: connect }, hint: "Connect the buyer's wallet. Nothing is sent yet.", notice: s.notice });
    }
    if (role === "seller") {
      return action({ notice: s.notice ?? { kind: "info", text: `This is your own deal: only its buyer can settle it. Until then you can cancel it and take back your ${give}. Cancelling costs no fee.` },
        extra: secondary("cancel-action", `Cancel the deal and take back ${give}`, cancel) });
    }
    if (role === "other") {
      return action({ notice: { kind: "warn", text: `This deal is for another address: only ${d.buyer} can settle it. `
        + `Your wallet is connected as ${short(me)}, so it cannot. If that other address is yours too, switch to it in your wallet.` } });
    }
    if (wallet.chainId !== config.chainId) {
      return action({ steps, step: 0, button: { label: `Switch to ${networkName(config.chainId)}`, run: switchNetwork },
        hint: `Your wallet is on ${networkName(wallet.chainId)}, and this deal is on ${networkName(config.chainId)}. Nothing can be sent until it is switched.`, notice: s.notice });
    }
    const f = s.funds;
    if (!f || f.account !== me) return action({ steps, step: 1, button: { label: `Checking your ${q.symbol}…` } });
    if (f.balance < m.buyerTotal) {
      return action({ steps, step: 1, button: { label: `Not enough ${q.symbol}` },
        notice: { kind: "warn", text: `To settle this deal you pay ${total} (the price and the 0.5% buyer fee), and this wallet holds ${amount(f.balance, q)}.` } });
    }
    if (f.allowance < m.buyerTotal) {
      return action({ steps, step: 1, button: { label: `Approve ${total}`, run: approve },
        hint: `This lets the deal contract take exactly ${total} from your wallet, the price and the buyer fee, and only when you settle. Nothing moves yet.`, notice: s.notice });
    }
    return action({ steps, step: 2, button: { label: `Settle: pay ${total}`, run: settle },
      hint: `One transaction: you pay ${total}, the seller receives ${amount(m.sellerNet, q)}, the treasury receives ${amount(m.feePool, q)}, and `
        + `${vesting ? `the ${give} move into a vault for your grant` : `the ${give} come to your wallet`}. All of it happens, or nothing moves.`, notice: s.notice });
  }

  const connect = () => presses.act("Connecting…", 0, () => wallet.connect());
  const switchNetwork = () => presses.act("Switching network…", 0, () => wallet.switchTo(config.chainId));
  const approve = () => {
    const total = money(s.deal.quote).buyerTotal;
    return presses.act(`Approving ${amount(total, s.quote)}…`, 1, (stage) => approveExactly(app, s.quote, total, s.funds.allowance, stage, v2.contract));
  };
  const settle = () => presses.act("Settling the deal…", 2, (stage, sent) =>
    transact(app, v2.contract, fillData(id), stage, `Paying ${amount(money(s.deal.quote).buyerTotal, s.quote)} for ${amount(s.deal.allocation, s.base)}`, sent));
  const cancel = () => presses.act("Cancelling…", null, (stage, sent) => transact(app, v2.contract, cancelData(id), stage, "Cancelling the deal", sent));
  const claim = () => presses.act("Claiming…", 1, (stage, sent) => transact(app, v2.contract, claimData(id), stage, `Claiming ${amount(s.grant.claimable, s.base)}`, sent));

  load().then(() => v2 && presses.resume(() => {
    s.notice = { kind: "info", text: "The transaction sent before this page was reloaded is confirmed. What you see is the chain's state now." };
  }));
  return {
    update: () => s.busy || load(),
    stop() {
      live = false;
      presses.stop();
      clearInterval(poll);
      clearTimeout(timer);
      removeEventListener("focus", onFocus);
      app.main.classList.remove("wide");
    },
  };
}
