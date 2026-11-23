// #/v2/new: the form that funds a v2 deal. The seller chooses how the tokens are delivered (at once, or as a new
// vesting grant), names the buyer, and sees the exact money before anything is signed: the price, both 0.5% fees,
// what the buyer pays, what the seller receives and what the treasury receives, and the schedule. Its one button
// connects, approves the allocation and funds the deal; then the page gives the one link to send to the buyer.
// An existing vesting position is not something this contract can hold: choosing it is refused on the page, before
// the wallet is ever asked for anything.
import { approveExactly, explain, same, transact } from "./eth.js";
import { action, amount, card, copyButton, dot, fact, h, networkName, NO_WALLET, setNote, show, span, TOKEN_WARNING, utc } from "./ui.js";
import { daysToSeconds, formatAmount, isAddress, openFor, parseAmount, parseUtc } from "./units.js";
import { createDealData, fundedId, money } from "./v2.js";

const UNSUPPORTED = "otc.fam cannot sell an existing vesting position. A Sablier stream, an allocation locked at another contract, a grant that can be revoked, "
  + "a screenshot or a link: the page cannot check any of them and the deal contract cannot hold them, so none is accepted as delivery. "
  + "Nothing was asked of your wallet. To sell tokens you hold, choose immediate or vesting delivery: the deal contract then holds the tokens themselves.";

export function newDealPageV2(app) {
  const { config, chain, wallet, v2 } = app;
  const s = { tokens: {}, funds: null, treasury: null, busy: null, notice: null, created: null };
  const pendingKey = `otcfam:pending:${config.chainId}:${v2?.contract}:new`;
  let live = true, fundsRead = 0;
  if (!v2) {
    app.main.replaceChildren(card(h("h1", {}, "v2 deals are not set up here"),
      h("p", { class: "lead" }, "This site's config.json names no v2 deal contract (contractV2), so deals with fees and vesting cannot be made here."),
      h("a", { class: "button secondary", href: "#/new" }, "Make a v1 deal instead")));
    return { update() {}, stop() {} };
  }

  const input = (testid, placeholder, more = {}) =>
    h("input", { id: testid, testid, placeholder, autocomplete: "off", autocapitalize: "off", spellcheck: "false", ...more, oninput: update });
  const choice = (name, value, testid, label, sub, checked) => h("label", { class: "choice" },
    h("input", { type: "radio", name, value, testid, checked, onchange: update }), h("span", {}, h("strong", {}, label), h("small", {}, sub)));
  const field = {
    baseToken: input("base-token", "Token address, 0x…", { class: "mono" }),
    allocation: input("allocation", "0", { inputmode: "decimal", class: "amount-input" }),
    quoteToken: input("quote-token", "Token address, 0x…", { class: "mono" }),
    quote: input("quote", "0", { inputmode: "decimal", class: "amount-input" }),
    buyer: input("buyer", "The buyer's address, 0x…", { class: "mono" }),
    hours: input("expiry-hours", "24", { inputmode: "decimal", value: "24" }),
    start: input("start-utc", "2026-12-01 00:00", { "aria-label": "Vesting start, date and time in UTC" }),
    cliff: input("cliff-days", "30", { inputmode: "decimal", value: "30" }),
    duration: input("duration-days", "90", { inputmode: "decimal", value: "90" }),
    existing: input("existing-position", "A link, a stream id, a contract address…"),
  };
  const delivery = h("fieldset", { class: "choices" }, h("legend", {}, "Delivery"),
    choice("delivery", "immediate", "delivery-immediate", "Immediate", "The buyer gets the tokens when they pay.", true),
    choice("delivery", "vesting", "delivery-vesting", "Vesting", "The buyer gets a new grant that unlocks over time."),
    choice("delivery", "existing", "delivery-existing", "Existing position", "A stream or a locked allocation you already hold."));
  const startMode = h("fieldset", { class: "choices two" }, h("legend", {}, "Vesting starts"),
    choice("start", "settlement", "start-settlement", "At settlement", "When the buyer pays, at that block's time.", true),
    choice("start", "fixed", "start-fixed", "At a fixed time", "A date and time in UTC, still in the future."));
  const pill = { base: h("span", { class: "token" }), quote: h("span", { class: "token" }) };
  const note = Object.fromEntries(["base", "quote", "buyer", "hours", "start", "cliff", "duration"].map((key) => [key, h("p", { class: "note" })]));
  const startBox = h("div", { class: "field" }, h("label", { for: "start-utc" }, "Start (UTC)"), field.start, note.start);
  const vestingBox = h("div", { class: "vesting-fields" }, startMode, startBox,
    h("div", { class: "pair" },
      h("div", { class: "field" }, h("label", { for: "cliff-days" }, "Cliff (days)"), field.cliff, note.cliff),
      h("div", { class: "field" }, h("label", { for: "duration-days" }, "Whole vesting (days)"), field.duration, note.duration)));
  const existingBox = h("div", { class: "field" }, h("label", { for: "existing-position" }, "The position you would like to sell"), field.existing);
  const summary = h("div", { class: "summary" });
  const actionArea = h("div");
  const legOf = (label, amountInput, tokenPill, tokenInput, tokenNote) => h("div", { class: "leg" },
    h("label", { class: "leg-label", for: amountInput.id }, label),
    h("div", { class: "leg-row" }, amountInput, tokenPill),
    h("label", { class: "small", for: tokenInput.id }, "Token"), tokenInput, tokenNote);
  const dealFields = h("div", {},
    legOf("You sell", field.allocation, pill.base, field.baseToken, note.base),
    h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
    legOf("Price the buyer pays you, before fees", field.quote, pill.quote, field.quoteToken, note.quote),
    h("div", { class: "field" }, h("label", { for: "buyer" }, "Buyer"), field.buyer, note.buyer),
    h("div", { class: "field" }, h("label", { for: "expiry-hours" }, "Open for (hours)"), field.hours, note.hours),
    vestingBox,
    h("p", { class: "warning", testid: "token-warning" }, TOKEN_WARNING, " A token that keeps a fee on its transfers is refused."));
  // Two cards: what the seller enters, and what the deal will do with the button that does it. Side by side on a wide screen.
  const form = h("div", { class: "board form" },
    card(
      h("div", { class: "card-head" }, h("h1", {}, "Make a deal", " ", h("span", { class: "version", testid: "version" }, "v2"))),
      h("p", { class: "lead" }, "Sell tokens to one buyer. Your tokens are held by the deal contract until the buyer pays; each side pays a 0.5% fee at settlement, and nothing before."),
      delivery, existingBox, dealFields),
    card(h("h2", {}, "What this deal does"), summary, actionArea));
  app.main.classList.add("wide");
  const checked = (group) => group.querySelector("input:checked").value;

  /** The token at `text`, as far as it is known: `{ info }`, `{ pending }` while it is looked up, or `{ missing }`. */
  function tokenAt(text) {
    const key = text.toLowerCase();
    if (!s.tokens[key]) {
      s.tokens[key] = { pending: true };
      chain.token(key).then((info) => (s.tokens[key] = { info }), () => (s.tokens[key] = { missing: true })).then(update);
    }
    return s.tokens[key];
  }

  /** One side of the deal, from its two fields: `{ token, units }`, or what is missing or wrong (`problem`, `pending`). */
  function side(tokenText, amountText, token, sum) {
    if (!tokenText) return { problem: `Enter ${token}` };
    if (!isAddress(tokenText)) {
      return { problem: `Check ${token}`, note: /[/:.]|stream|sablier|vest/i.test(tokenText)
        ? "This is not a token address. An existing vesting position, or a link to one, cannot be sold here: only tokens the deal contract can hold."
        : "A token address is 0x followed by 40 letters and digits." };
    }
    const t = tokenAt(tokenText);
    if (t.pending) return { pending: true };
    if (t.missing) return { problem: `Check ${token}`, note: `No token answers at this address on ${networkName(config.chainId)}.` };
    if (!amountText) return { token: t.info, problem: `Enter ${sum}` };
    try {
      return { token: t.info, units: parseAmount(amountText, t.info.decimals, t.info.symbol) };
    } catch (e) {
      return { token: t.info, problem: `Check ${sum}`, note: e.message };
    }
  }

  /** The vesting schedule in the form: `{ fixedStart, cliffSeconds, durationSeconds }` in chain seconds, or what to fix. */
  function scheduleOf() {
    const out = { fixedStart: 0, cliffSeconds: 0n, durationSeconds: 0n, notes: {} };
    const wrong = (key, problem, text) => {
      out.problem ??= problem;
      out.notes[key] = text;
    };
    if (checked(startMode) === "fixed") {
      try {
        out.fixedStart = parseUtc(field.start.value);
        if (out.fixedStart <= Date.now() / 1000 + 60) wrong("start", "Check the vesting start", "The start must be in the future, by more than a minute.");
      } catch (e) {
        wrong("start", field.start.value.trim() ? "Check the vesting start" : "Enter the vesting start", e.message);
      }
    }
    try {
      out.durationSeconds = daysToSeconds(field.duration.value);
      if (out.durationSeconds === 0n) wrong("duration", "Check the vesting length", "The vesting must last more than zero.");
    } catch (e) {
      wrong("duration", "Check the vesting length", e.message);
    }
    try {
      out.cliffSeconds = daysToSeconds(field.cliff.value.trim() || "0");
      if (out.durationSeconds > 0n && out.cliffSeconds >= out.durationSeconds) wrong("cliff", "Check the cliff", "The cliff must be shorter than the whole vesting. Write 0 for no cliff.");
    } catch (e) {
      wrong("cliff", "Check the cliff", e.message);
    }
    return out;
  }

  /** Everything the form says, and the first problem in it, if any. */
  function terms() {
    const mode = checked(delivery);
    const base = side(field.baseToken.value.trim(), field.allocation.value.trim(), "the token you sell", "the amount you sell");
    const quote = side(field.quoteToken.value.trim(), field.quote.value.trim(), "the payment token", "the price");
    const buyerText = field.buyer.value.trim();
    const buyer = !buyerText ? { problem: "Enter the buyer's address", note: "A v2 deal is for one buyer: only this address can settle it." }
      : !isAddress(buyerText) ? { problem: "Check the buyer's address", note: "An address is 0x followed by 40 letters and digits." }
      : /^0x0{40}$/.test(buyerText) ? { problem: "Check the buyer's address", note: "The zero address cannot be a buyer." }
      : wallet?.account && same(buyerText, wallet.account) ? { problem: "Check the buyer's address", note: "This is your own address: put the buyer's." }
      : { address: buyerText.toLowerCase() };
    const expiry = openFor(field.hours.value.trim());
    const distinct = base.token && quote.token && base.token.address === quote.token.address
      ? { problem: "Pick two different tokens", note: "The token you sell and the payment token are the same." } : {};
    const schedule = mode === "vesting" ? scheduleOf() : { fixedStart: 0, cliffSeconds: 0n, durationSeconds: 0n, notes: {} };
    const problem = [base, quote, distinct, buyer, expiry, schedule].find((x) => x.problem)?.problem;
    return { mode, base, quote, buyer, expiry, distinct, schedule, problem, pending: base.pending || quote.pending };
  }

  /** What the connected wallet holds of `token`, and has approved for the v2 deal contract; null while it is read. */
  function fundsOf(token) {
    const key = `${wallet.account}:${token.address}`;
    if (s.funds?.key === key) return s.funds;
    if (s.funds?.reading !== key) loadFunds(token);
    return null;
  }

  async function loadFunds(token) {
    const key = `${wallet.account}:${token.address}`, read = ++fundsRead;
    s.funds = { reading: key };
    try {
      const [balance, allowance] = await Promise.all([chain.balanceOf(token.address, wallet.account), chain.allowance(token.address, wallet.account, v2.contract)]);
      if (read === fundsRead) s.funds = { key, balance, allowance };
    } catch (e) {
      if (read === fundsRead) [s.funds, s.notice] = [null, { kind: "error", text: explain(e) }];
    }
    update();
  }

  // A funding transaction that was sent and not yet seen in a block is remembered in this browser: a reload still ends with the link.
  const remember = (hash) => {
    try {
      localStorage.setItem(pendingKey, JSON.stringify({ hash, account: wallet.account }));
    } catch {}
  };
  const forget = () => {
    try {
      localStorage.removeItem(pendingKey);
    } catch {}
  };

  /** Runs one press: `work(stage)` sends what it must, and the button comes back once the wallet's tokens are read again. */
  async function act(label, step, work) {
    s.notice = null;
    s.busy = { label, step, hint: "" };
    update();
    try {
      await work((hint) => {
        s.busy.hint = hint;
        update();
      });
    } catch (e) {
      s.notice = { kind: e.replaced ? "info" : "error", text: explain(e) };
    }
    const sold = !s.created && wallet?.account && terms().base.token;
    if (sold) await loadFunds(sold);
    s.busy = null;
    update();
  }

  /** Reads deal `id` back from the chain and shows its link: what the buyer will see is what the chain holds. */
  async function showCreated(id) {
    const deal = await v2.deal(id);
    const [base, quote] = await Promise.all([chain.token(deal.baseToken), chain.token(deal.quoteToken)]);
    s.created = { deal, base, quote, link: `${location.href.split("#")[0]}#/v2/d/${id}` };
  }

  function update() {
    if (!live) return;
    if (s.created) {
      if (app.main.firstElementChild !== form) return show(app.main, created());
      app.main.replaceChildren(created()); // the form gives way to the link, which takes the focus
      return app.main.querySelector('[data-testid="deal-link"]').focus({ preventScroll: true });
    }
    const t = terms(), existing = t.mode === "existing", vesting = t.mode === "vesting";
    existingBox.hidden = !existing;
    dealFields.hidden = existing;
    vestingBox.hidden = !vesting;
    startBox.hidden = checked(startMode) !== "fixed";
    for (const [key, x] of [["base", t.base], ["quote", t.quote]]) {
      pill[key].replaceChildren(...(x.token ? [dot(x.token), x.token.symbol] : ["Token"]));
      pill[key].classList.toggle("empty", !x.token);
      const funds = key === "base" && x.token && wallet?.account && s.funds?.key === `${wallet.account}:${x.token.address}` && s.funds;
      const about = x.token && `${x.token.symbol}, ${x.token.decimals} decimals${funds ? ` · you hold ${amount(funds.balance, x.token)}` : ""}`;
      setNote(note[key], x.note ?? (x.pending ? "Looking up the token…" : about || ""), Boolean(x.note));
    }
    if (t.distinct.note) setNote(note.quote, t.distinct.note, true);
    setNote(note.buyer, t.buyer.note ?? "Only this address can settle the deal, and a vesting grant only ever pays this address.", Boolean(t.buyer.problem));
    setNote(note.hours, t.expiry.note ?? `The buyer can settle until ${utc(Math.floor(Date.now() / 1000 + t.expiry.hours * 3600))}. After that you take the tokens back.`, Boolean(t.expiry.note));
    const notes = t.schedule.notes;
    setNote(note.start, notes.start ?? (t.schedule.fixedStart ? `${utc(t.schedule.fixedStart)}. The buyer must settle before then.` : "Like 2026-12-01 00:00. The buyer must settle before then."), Boolean(notes.start));
    setNote(note.cliff, notes.cliff ?? (t.schedule.cliffSeconds ? `${span(t.schedule.cliffSeconds)} of chain time: nothing can be claimed before it.` : "No cliff: unlocking begins with the start."), Boolean(notes.cliff));
    setNote(note.duration, notes.duration ?? `${span(t.schedule.durationSeconds)} of chain time, from the start to fully vested.`, Boolean(notes.duration));
    show(summary, summaryOf(t));
    show(actionArea, actions(t)); // changed in place: the button keeps the focus from one step to the next
  }

  /** The exact money and schedule of the deal as it would be funded, once the form is complete. */
  function summaryOf(t) {
    if (t.mode === "existing") return h("div", {}, h("p", { class: "hint" }, "Nothing: this kind of delivery is not supported."));
    if (t.problem || t.pending) return h("div", {}, h("p", { class: "hint" }, "Fill in the form, and the exact amounts each side pays and receives appear here before anything is signed."));
    const q = t.quote.token, m = money(t.quote.units), sched = t.schedule, vesting = t.mode === "vesting";
    const sum = (label, testid, units) => fact(label, h("span", { testid }, formatAmount(units, q.decimals)), ` ${q.symbol}`);
    const atCliff = vesting && amount((t.base.units * sched.cliffSeconds) / sched.durationSeconds, t.base.token);
    return h("div", {},
      h("dl", { class: "facts", testid: "summary" },
        fact("Delivery", h("span", { testid: "summary-delivery" }, vesting
          ? `Vesting: ${amount(t.base.units, t.base.token)} go into a new grant for the buyer when they pay`
          : `Immediate: ${amount(t.base.units, t.base.token)} go to the buyer when they pay`)),
        sum("Price", "price", m.quote),
        sum("Buyer fee, 0.5% of the price", "buyer-fee", m.buyerFee),
        sum("Buyer pays in total", "buyer-total", m.buyerTotal),
        sum("Seller fee, 0.5% of the price", "seller-fee", m.sellerFee),
        sum("You receive", "seller-net", m.sellerNet),
        fact("Treasury receives both fees", h("span", { testid: "treasury-fee" }, formatAmount(m.feePool, q.decimals)), ` ${q.symbol}`,
          s.treasury && h("span", { class: "mono block", testid: "treasury" }, s.treasury)),
        vesting && fact("Vesting schedule", h("span", { testid: "summary-schedule" },
          `Starts ${sched.fixedStart ? utc(sched.fixedStart) : "when the buyer settles"}. `
          + (sched.cliffSeconds ? `Cliff ${span(sched.cliffSeconds)} later: ${atCliff} unlock at once. ` : "No cliff. ")
          + `Fully vested ${span(sched.durationSeconds)} after the start${sched.fixedStart ? `, ${utc(BigInt(sched.fixedStart) + sched.durationSeconds)}` : ""}; until then it unlocks second by second.`))),
      h("p", { class: "hint" }, "Fees are rounded down to the payment token's smallest unit and taken only when the buyer settles: funding, cancelling and claiming cost no fee."));
  }

  /** The one button (connect, switch network, approve, fund), or what the form still needs, and what the press does. */
  function actions(t) {
    const steps = ["Connect", `Approve ${t.base.token?.symbol ?? "token"}`, "Fund"];
    if (t.mode === "existing") return action({ button: { label: "Existing positions are not supported" }, notice: { kind: "error", text: UNSUPPORTED } });
    if (s.busy) return action({ steps, step: s.busy.step, button: { label: s.busy.label }, hint: s.busy.hint });
    if (!wallet) return action({ steps, step: 0, button: { label: "Connect a wallet to make a deal" }, notice: { kind: "info", text: NO_WALLET } });
    if (!wallet.account) {
      return action({ steps, step: 0, button: { label: "Connect wallet", run: connect }, hint: "Connect the wallet that holds the tokens you sell. Nothing is sent yet.",
        notice: s.notice });
    }
    if (wallet.chainId !== config.chainId) {
      return action({ steps, step: 0, button: { label: `Switch to ${networkName(config.chainId)}`, run: switchNetwork },
        hint: `Your wallet is on ${networkName(wallet.chainId)}; deals are on ${networkName(config.chainId)}. Nothing can be sent until it is switched.`, notice: s.notice });
    }
    if (t.pending) return action({ steps, step: 1, button: { label: "Looking up the tokens…" } });
    if (t.problem) return action({ steps, step: 1, button: { label: t.problem }, notice: s.notice });
    const f = fundsOf(t.base.token), give = amount(t.base.units, t.base.token);
    if (!f) return action({ steps, step: 1, button: { label: `Checking your ${t.base.token.symbol}…` } });
    if (f.balance < t.base.units) {
      return action({ steps, step: 1, button: { label: `Not enough ${t.base.token.symbol}` },
        notice: { kind: "warn", text: `You sell ${give}, and this wallet holds ${amount(f.balance, t.base.token)}.` } });
    }
    if (f.allowance < t.base.units) {
      return action({ steps, step: 1, button: { label: `Approve ${give}`, run: () => approve(t, f) },
        hint: `This lets the deal contract take exactly ${give} from your wallet when you fund the deal. Nothing moves yet.`, notice: s.notice });
    }
    return action({ steps, step: 2, button: { label: "Fund the deal", run: () => create(t) },
      hint: `Your ${give} move into the deal contract. They go ${t.mode === "vesting" ? "into the buyer's grant" : "to the buyer"} when the buyer pays, or back to you if you cancel first.`,
      notice: s.notice });
  }

  const connect = () => act("Connecting…", 0, () => wallet.connect());
  const switchNetwork = () => act("Switching network…", 0, () => wallet.switchTo(config.chainId));
  const approve = (t, f) => act(`Approving ${amount(t.base.units, t.base.token)}…`, 1, (stage) => approveExactly(app, t.base.token, t.base.units, f.allowance, stage, v2.contract));
  const create = (t) => act("Funding the deal…", 2, async (stage) => {
    const start = Math.max(Date.now() / 1000, await chain.now());
    const deal = { baseToken: t.base.token.address, quoteToken: t.quote.token.address, buyer: t.buyer.address, allocation: t.base.units, quote: t.quote.units,
      expiry: BigInt(Math.floor(start + t.expiry.hours * 3600)), delivery: t.mode, ...t.schedule };
    const what = `Funding the deal: ${amount(deal.allocation, t.base.token)} for ${amount(deal.quote, t.quote.token)}`;
    const receipt = await transact(app, v2.contract, createDealData(deal), stage, what, remember);
    forget();
    await showCreated(fundedId(receipt, v2.contract));
  });

  /** After a reload: takes up the funding transaction this browser sent before, and ends with the deal's link. */
  function resume() {
    let pending = null;
    try {
      pending = JSON.parse(localStorage.getItem(pendingKey));
    } catch {}
    if (!/^0x[0-9a-f]{64}$/i.test(pending?.hash)) return;
    act("Funding the deal…", 2, async (stage) => {
      stage(`This page was reloaded while the funding transaction ${pending.hash} was on its way. Waiting for the network to confirm it.`);
      try {
        await showCreated(fundedId(await chain.confirmed(pending.hash, pending.account), v2.contract));
      } finally {
        forget();
      }
    });
  }

  function created() {
    const { deal: d, base, quote, link } = s.created, m = money(d.quote), vesting = d.delivery === "vesting";
    return card(
      h("div", { class: "card-head" }, h("h1", {}, `Deal #${d.id} is funded`, " ", h("span", { class: "version", testid: "version" }, "v2"))),
      h("p", { class: "lead" }, "Send this one link to the buyer. It shows them the terms, both fees and that your tokens are held on the chain, and lets them settle from their wallet."),
      h("div", { class: "linkbox" }, h("a", { testid: "deal-link", href: link }, link)),
      h("div", { class: "row" }, copyButton(link), h("a", { class: "button secondary", href: link }, "Open the deal")),
      h("dl", { class: "facts" },
        fact("Delivery", vesting ? "Vesting: a new grant for the buyer" : "Immediate: to the buyer's wallet"),
        fact("Buyer", h("span", { class: "mono" }, d.buyer)),
        fact("They get", amount(d.allocation, base)),
        fact("They pay, fee included", amount(m.buyerTotal, quote)),
        fact("You receive, fee taken", amount(m.sellerNet, quote)),
        fact("Can be settled until", utc(vesting && d.fixedStart ? Math.min(d.expiry, d.fixedStart) : d.expiry))),
      h("p", { class: "hint" }, `Your ${amount(d.allocation, base)} are held by the deal contract. `
        + "To take them back before the buyer settles, open the deal with this wallet and cancel it: that costs no fee."));
  }

  app.main.replaceChildren(form);
  update();
  v2.setup().then(({ treasury }) => {
    s.treasury = treasury;
    update();
  }, (e) => {
    s.notice = { kind: "error", text: explain(e) };
    update();
  });
  resume();
  return {
    update: () => {
      if (!s.busy) s.funds = null; // the account or the network changed: read the wallet's tokens again
      update();
    },
    stop() {
      live = false;
      app.main.classList.remove("wide");
    },
  };
}
