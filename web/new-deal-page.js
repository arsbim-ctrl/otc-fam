// #/new: the form that makes a deal (what you give, what you get, who may fill it, for how long), its one button
// (connect, switch network, approve, create), then the link to send to the other side.
import { approveExactly, createDealData, createdId, explain, same, transact, ZERO_ADDRESS } from "./eth.js";
import { action, amount, card, copyButton, DATE, dot, fact, h, networkName, NO_WALLET, setNote, when } from "./ui.js";
import { isAddress, parseAmount } from "./units.js";

export function newDealPage(app) {
  const { config, chain, wallet } = app;
  const s = { tokens: {}, funds: null, busy: null, notice: null, created: null };
  let live = true, fundsRead = 0;
  const input = (testid, placeholder, more = {}) =>
    h("input", { id: testid, testid, placeholder, autocomplete: "off", autocapitalize: "off", spellcheck: "false", ...more, oninput: update });
  const field = {
    sellToken: input("sell-token", "Token address, 0x…", { class: "mono" }),
    sellAmount: input("sell-amount", "0", { inputmode: "decimal", class: "amount-input" }),
    buyToken: input("buy-token", "Token address, 0x…", { class: "mono" }),
    buyAmount: input("buy-amount", "0", { inputmode: "decimal", class: "amount-input" }),
    taker: input("taker", "Empty: anyone with the link", { class: "mono" }),
    hours: input("expiry-hours", "24", { inputmode: "decimal", value: "24" }),
  };
  const pill = { sell: h("span", { class: "token" }), buy: h("span", { class: "token" }) };
  const note = { sell: h("p", { class: "note" }), buy: h("p", { class: "note" }), taker: h("p", { class: "note" }), hours: h("p", { class: "note" }) };
  const summary = h("div", { class: "summary" });
  const actionArea = h("div");
  const legOf = (label, amountInput, tokenPill, tokenInput, tokenNote) => h("div", { class: "leg" },
    h("label", { class: "leg-label", for: amountInput.id }, label),
    h("div", { class: "leg-row" }, amountInput, tokenPill),
    h("label", { class: "small", for: tokenInput.id }, "Token"), tokenInput, tokenNote);
  const form = card(
    h("h1", {}, "Make a deal"),
    h("p", { class: "lead" }, "Offer tokens for other tokens. You get a link to send to the other side, who fills the deal from their wallet."),
    legOf("You give", field.sellAmount, pill.sell, field.sellToken, note.sell),
    h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
    legOf("You get", field.buyAmount, pill.buy, field.buyToken, note.buy),
    h("div", { class: "field" }, h("label", { for: "taker" }, "Who can fill it"), field.taker, note.taker),
    h("div", { class: "field" }, h("label", { for: "expiry-hours" }, "Expires in (hours)"), field.hours, note.hours),
    summary, actionArea);

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
  function side(tokenText, amountText, verb) {
    if (!tokenText) return { problem: `Enter the token you ${verb}` };
    if (!isAddress(tokenText)) return { problem: `Check the token you ${verb}`, note: "A token address is 0x followed by 40 letters and digits." };
    const t = tokenAt(tokenText);
    if (t.pending) return { pending: true };
    if (t.missing) return { problem: `Check the token you ${verb}`, note: `No token answers at this address on ${networkName(config.chainId)}.` };
    if (!amountText) return { token: t.info, problem: `Enter the amount you ${verb}` };
    try {
      return { token: t.info, units: parseAmount(amountText, t.info.decimals, t.info.symbol) };
    } catch (e) {
      return { token: t.info, problem: `Check the amount you ${verb}`, note: e.message };
    }
  }

  /** Everything the form says: both sides, the taker, the hours, and the first problem in it, if any. */
  function terms() {
    const sell = side(field.sellToken.value.trim(), field.sellAmount.value.trim(), "give");
    const buy = side(field.buyToken.value.trim(), field.buyAmount.value.trim(), "get");
    const takerText = field.taker.value.trim(), hoursText = field.hours.value.trim(), hours = Number(hoursText);
    const taker = !takerText ? { address: ZERO_ADDRESS }
      : !isAddress(takerText) ? { problem: "Check the taker's address", note: "An address is 0x followed by 40 letters and digits. Leave it empty to let anyone fill." }
      : wallet?.account && same(takerText, wallet.account) ? { problem: "Check the taker's address", note: "This is your own address: put the other side's, or leave it empty." }
      : { address: takerText.toLowerCase() };
    const expiry = /^\d+(\.\d+)?$/.test(hoursText) && hours > 0 && hours <= 8760 ? { hours }
      : { problem: "Check the hours", note: "Write a number of hours, more than 0 and at most 8760 (a year), like 24 or 0.5." };
    const distinct = sell.token && buy.token && sell.token.address === buy.token.address
      ? { problem: "Pick two different tokens", note: "The token you give and the token you get are the same." } : {};
    const problem = [sell, buy, distinct, taker, expiry].find((x) => x.problem)?.problem;
    return { sell, buy, taker, expiry, distinct, problem, pending: sell.pending || buy.pending };
  }

  /** What the connected wallet holds of `token`, and has approved for the deal contract; null while it is read. */
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
      const [balance, allowance] = await Promise.all([chain.balanceOf(token.address, wallet.account), chain.allowance(token.address, wallet.account)]);
      if (read === fundsRead) s.funds = { key, balance, allowance };
    } catch (e) {
      if (read === fundsRead) s.funds = { key, error: explain(e) };
    }
    update();
  }

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
      s.notice = { kind: "error", text: explain(e) };
    }
    const t = terms();
    if (!s.created && wallet.account && t.sell.token) await loadFunds(t.sell.token);
    s.busy = null;
    update();
  }

  function update() {
    if (!live) return;
    if (s.created) return app.main.replaceChildren(created());
    const t = terms(), anyone = t.taker.address === ZERO_ADDRESS;
    for (const [key, x] of [["sell", t.sell], ["buy", t.buy]]) {
      pill[key].replaceChildren(...(x.token ? [dot(x.token), x.token.symbol] : ["Token"]));
      pill[key].classList.toggle("empty", !x.token);
      const funds = key === "sell" && x.token && wallet?.account && s.funds?.key === `${wallet.account}:${x.token.address}` && s.funds;
      const about = x.token && `${x.token.symbol}, ${x.token.decimals} decimals${funds && !funds.error ? ` · you hold ${amount(funds.balance, x.token)}` : ""}`;
      setNote(note[key], x.note ?? (x.pending ? "Looking up the token…" : about || ""), Boolean(x.note));
    }
    if (t.distinct.note) setNote(note.buy, t.distinct.note, true);
    setNote(note.taker, t.taker.note ?? (anyone ? "Anyone who has the link can fill it." : "Only this address can fill it."), Boolean(t.taker.note));
    setNote(note.hours, t.expiry.note ?? `Until ${DATE.format(new Date(Date.now() + t.expiry.hours * 3_600_000))}.`, Boolean(t.expiry.note));
    const give = !t.problem && !t.pending && amount(t.sell.units, t.sell.token);
    summary.replaceChildren(...(!give ? [] : [
      h("p", {}, `You give ${give} and get ${amount(t.buy.units, t.buy.token)}.`),
      h("p", {}, `${anyone ? "Anyone with the link" : "Only the address you named"} can fill it, for ${t.expiry.hours} hour${t.expiry.hours === 1 ? "" : "s"}. `
        + `Until then your ${give} stay locked in the deal contract, and you can cancel to take them back.`)]));
    actionArea.replaceChildren(actions(t));
  }

  /** The one button (connect, switch network, approve, create), or what the form still needs, and what the press does. */
  function actions(t) {
    const steps = ["Connect", `Approve ${t.sell.token?.symbol ?? "token"}`, "Create"];
    if (s.busy) return action({ steps, step: s.busy.step, button: { label: s.busy.label }, hint: s.busy.hint });
    if (!wallet) return action({ steps, step: 0, button: { label: "Connect a wallet to make a deal" }, notice: { kind: "info", text: NO_WALLET } });
    if (!wallet.account) {
      return action({ steps, step: 0, button: { label: "Connect wallet", run: connect }, hint: "Connect the wallet that holds what you give. Nothing is sent yet.",
        notice: s.notice });
    }
    if (wallet.chainId !== config.chainId) {
      return action({ steps, step: 0, button: { label: `Switch to ${networkName(config.chainId)}`, run: switchNetwork },
        hint: `Your wallet is on ${networkName(wallet.chainId)}; deals are on ${networkName(config.chainId)}.`, notice: s.notice });
    }
    if (t.pending) return action({ steps, step: 1, button: { label: "Looking up the tokens…" } });
    if (t.problem) return action({ steps, step: 1, button: { label: t.problem }, notice: s.notice });
    const f = fundsOf(t.sell.token), give = amount(t.sell.units, t.sell.token);
    if (!f) return action({ steps, step: 1, button: { label: `Checking your ${t.sell.token.symbol}…` } });
    if (f.error) return action({ steps, step: 1, button: { label: "Retry balance and approval", run: () => loadFunds(t.sell.token) },
      notice: { kind: "error", text: f.error } });
    if (f.balance < t.sell.units) {
      return action({ steps, step: 1, button: { label: `Not enough ${t.sell.token.symbol}` },
        notice: { kind: "warn", text: `You give ${give}, and this wallet holds ${amount(f.balance, t.sell.token)}.` } });
    }
    if (f.allowance < t.sell.units) {
      return action({ steps, step: 1, button: { label: `Approve ${give}`, run: () => approve(t, f) },
        hint: `This lets the deal contract take exactly ${give} from your wallet when you create the deal. Nothing moves yet.`, notice: s.notice });
    }
    return action({ steps, step: 2, button: { label: "Create the deal", run: () => create(t) },
      hint: `Your ${give} move into the deal contract. They go to the other side when the deal is filled, or back to you if you cancel it.`, notice: s.notice });
  }

  const connect = () => act("Connecting…", 0, () => wallet.connect());
  const switchNetwork = () => act("Switching network…", 0, () => wallet.switchTo(config.chainId));
  const approve = (t, f) => act(`Approving ${amount(t.sell.units, t.sell.token)}…`, 1, (stage) => approveExactly(app, t.sell.token, t.sell.units, f.allowance, stage));
  const create = (t) => act("Creating the deal…", 2, async (stage) => {
    const start = Math.max(Date.now() / 1000, await chain.now());
    const deal = { sellToken: t.sell.token.address, sellAmount: t.sell.units, buyToken: t.buy.token.address, buyAmount: t.buy.units,
      taker: t.taker.address, expiry: BigInt(Math.floor(start + t.expiry.hours * 3600)) };
    const what = `Creating the deal: ${amount(deal.sellAmount, t.sell.token)} for ${amount(deal.buyAmount, t.buy.token)}`;
    const id = createdId(await transact(app, config.contract, createDealData(deal), stage, what), config.contract);
    s.created = { ...deal, id, link: `${location.href.split("#")[0]}#/d/${id}`, sell: t.sell.token, buy: t.buy.token };
  });

  function created() {
    const c = s.created;
    return card(
      h("div", { class: "card-head" }, h("h1", {}, `Deal #${c.id} is open`)),
      h("p", { class: "lead" }, "Send this link to the other side. It shows them what they pay and what they get, and lets them fill the deal from their wallet."),
      h("div", { class: "linkbox" }, h("a", { testid: "deal-link", href: c.link }, c.link)),
      h("div", { class: "row" }, copyButton(c.link), h("a", { class: "button secondary", href: c.link }, "Open the deal")),
      h("dl", { class: "facts" },
        fact("They pay", amount(c.buyAmount, c.buy)),
        fact("They get", amount(c.sellAmount, c.sell)),
        c.taker === ZERO_ADDRESS ? fact("Who can fill", "Anyone who has the link") : fact("Reserved for", h("span", { class: "mono" }, c.taker)),
        fact("Expires", when(Number(c.expiry), Date.now() / 1000))),
      h("p", { class: "hint" }, `Your ${amount(c.sellAmount, c.sell)} are locked in the deal contract. `
        + "To take them back before someone fills the deal, open it with this wallet and cancel it."));
  }

  app.main.replaceChildren(form);
  update();
  return {
    update: () => {
      if (!s.busy) s.funds = null; // the account or the network changed: read the wallet's tokens again
      update();
    },
    stop: () => (live = false),
  };
}
