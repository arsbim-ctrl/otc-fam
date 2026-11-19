// otc.fam's page. #/d/<id> shows deal <id> to whoever opens its link and lets its taker fill it; #/new makes a deal.
// It reads the chain at config.json's rpcUrl, with no wallet, and sends transactions through the browser's wallet.
import { Chain, Wallet, ZERO_ADDRESS, approveData, cancelData, createDealData, createdId, explain, fillData, same } from "./eth.js";
import { formatAmount, isAddress, parseAmount } from "./units.js";

const NETWORKS = { 1: "Ethereum", 10: "OP Mainnet", 137: "Polygon", 8453: "Base", 42161: "Arbitrum One", 84532: "Base Sepolia", 11155111: "Sepolia", 31337: "Local test chain" };
const STATUS_WORDS = { open: "Open", filled: "Filled", cancelled: "Cancelled", expired: "Expired", "not-found": "No such deal" };
const NO_WALLET = "There is no wallet in this browser. Open this link in your wallet app's browser (MetaMask, Rabby, Coinbase Wallet…) or in a browser with a wallet extension.";
const DATE = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const main = document.getElementById("app");
let config, chain, wallet, page;

start();

async function start() {
  try {
    const response = await fetch("config.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = await response.json();
    if (!Number.isSafeInteger(config.chainId) || !isAddress(config.contract) || typeof config.rpcUrl !== "string") throw new Error("it must give chainId, contract and rpcUrl");
  } catch (e) {
    main.replaceChildren(card(h("h1", {}, "This site is not set up"), h("p", { class: "lead" }, `Its config.json could not be read (${e.message}).`)));
    return;
  }
  chain = new Chain(new URL(config.rpcUrl, location.href).href, config.contract);
  if (window.ethereum) {
    wallet = new Wallet(window.ethereum, () => {
      showAccount();
      page?.update();
    });
    await Promise.race([wallet.ready, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  document.getElementById("network").textContent = networkName(config.chainId);
  document.getElementById("footer").replaceChildren(`Deals contract on ${networkName(config.chainId)}: `, h("span", { class: "mono" }, config.contract));
  showAccount();
  addEventListener("hashchange", route);
  route();
}

function route() {
  page?.stop();
  const deal = /^#\/d\/(.*)$/.exec(location.hash);
  page = deal ? dealPage(deal[1]) : location.hash === "#/new" ? newDealPage() : homePage();
  scrollTo(0, 0);
}

// ------------------------------------------------------------------------------------------- the deal's page

function dealPage(idText) {
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
      const [chainTime, sell, buy, funds] = deal.status === "none" ? [0] : await Promise.all([chain.now(), chain.token(deal.sellToken), chain.token(deal.buyToken), fundsFor(deal)]);
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
    const next = view();
    if (!main.firstElementChild?.isEqualNode(next)) main.replaceChildren(next); // unchanged: leave it, and any text selected in it
    clearTimeout(expiryTimer);
    const left = s.deal?.status === "open" ? Number(s.deal.expiry) - now() : 0;
    if (left > 0 && left < 86_400) expiryTimer = setTimeout(render, left * 1000 + 250); // the page turns to "expired" on time
  }

  /** Runs one press of a button: `work(stage)` sends what it must; the button comes back once the chain is read again. */
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
      return card(h("h1", {}, `Deal #${idText.slice(0, 80)}`), h("p", { class: "notice error", testid: "notice" }, `This deal could not be read. ${s.failed}`),
        h("button", { class: "secondary", type: "button", onclick: () => load() }, "Try again"));
    }
    if (s.deal.status === "none") {
      return card(head(id === null ? "Not a deal link" : `Deal #${idText}`, "not-found"),
        h("p", { class: "lead" }, id === null
          ? "This link does not end with a deal number. Ask the person who sent it for the whole link."
          : `There is no deal #${idText} on ${networkName(config.chainId)}. Check that you have the whole link, or ask the person who sent it.`),
        h("a", { class: "button secondary", href: "#/new" }, "Make a deal of your own"));
    }
    const d = s.deal, sell = s.sell, buy = s.buy, me = wallet?.account;
    const status = d.status === "open" && now() >= Number(d.expiry) ? "expired" : d.status;
    const mine = Boolean(me && same(me, d.maker));
    const taking = status === "open" && !mine && (!me || mayFill(d, me));
    const [payLabel, receiveLabel] = s.done === "filled" ? ["You paid", "You received"] : mine ? ["You get", "You give"] : taking ? ["You pay", "You receive"] : ["The taker pays", "The taker receives"];
    return card(
      head(`Deal #${idText}`, status),
      h("p", { class: "lead" }, lead(status, mine, taking)),
      leg(payLabel, d.buyAmount, buy, "pay"),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      leg(receiveLabel, d.sellAmount, sell, "receive"),
      h("dl", { class: "facts" },
        h("div", {}, h("dt", {}, "From"), h("dd", {}, h("span", { class: "mono", testid: "maker" }, d.maker), mine && " (you)")),
        h("div", {}, h("dt", {}, "Who can fill"), h("dd", {}, d.taker === ZERO_ADDRESS ? "Anyone who has this link" : ["Only ", h("span", { class: "mono" }, d.taker), me && same(me, d.taker) ? " (you)" : ""])),
        h("div", {}, h("dt", {}, status === "expired" ? "Expired" : status === "open" ? "Expires" : "Ends"), h("dd", { testid: "expires", "data-expiry": String(d.expiry) }, when(Number(d.expiry), now()))),
        status === "open" && h("div", {}, h("dt", {}, "Held"), h("dd", {}, `${mine ? "Your" : "The maker's"} ${amount(d.sellAmount, sell)} are locked in the deal contract until the deal is filled or cancelled.`))),
      status === "open" ? actions(d) : ended(status, mine));
  }

  function lead(status, mine, taking) {
    const d = s.deal, pay = amount(d.buyAmount, s.buy), get = amount(d.sellAmount, s.sell);
    if (status === "open") {
      if (mine) return "Your offer is open. Send this link to the other side: they fill it from their wallet.";
      return taking ? "You are offered a swap. Check what you pay and what you receive, then fill it from your wallet." : "This deal is reserved for another address.";
    }
    if (status === "filled") {
      if (s.done === "filled") return `Done. You paid ${pay} and received ${get}.`;
      return mine ? `Your deal was filled: you received ${pay} for your ${get}.` : "This deal was filled: the two sides swapped their tokens. Nothing is left to do.";
    }
    if (status === "cancelled") return mine ? `You cancelled this deal: your ${get} went back to your wallet.` : `The maker cancelled this deal and took back their ${get}. It can no longer be filled.`;
    return `This deal expired ${fromNow(Number(d.expiry) - now())}. It can no longer be filled.`;
  }

  /** What a filled, cancelled or expired deal offers: nothing to fill; to its maker, an expired deal's tokens back. */
  function ended(status, mine) {
    if (status === "filled" && s.done === "filled") return h("p", { class: "success" }, `The swap is done: ${amount(s.deal.sellAmount, s.sell)} are now in your wallet.`);
    if (status !== "expired") return s.notice && notice(s.notice);
    if (!mine) return h("p", { class: "hint" }, `The maker's ${amount(s.deal.sellAmount, s.sell)} stay in the deal contract until they cancel the deal and take them back.`);
    return h("div", { class: "action" },
      s.busy ? h("button", { class: "secondary", type: "button", testid: "cancel-action", disabled: true }, s.busy.label)
        : h("button", { class: "secondary", type: "button", testid: "cancel-action", onclick: (e) => press(e, cancel) }, `Cancel it and take back ${amount(s.deal.sellAmount, s.sell)}`),
      s.busy?.hint && h("p", { class: "hint" }, s.busy.hint),
      s.notice && notice(s.notice));
  }

  /** The button that moves an open deal forward (connect, switch network, approve, fill), and what it is about to do. */
  function actions(d) {
    const me = wallet?.account, sell = s.sell, buy = s.buy, steps = ["Connect", `Approve ${buy.symbol}`, "Fill"];
    const pay = amount(d.buyAmount, buy), get = amount(d.sellAmount, sell);
    if (s.busy?.step === null) return action({ hint: s.busy.hint, extra: h("button", { class: "secondary", type: "button", testid: "cancel-action", disabled: true }, s.busy.label) });
    if (s.busy) return action({ steps, step: s.busy.step, button: { label: s.busy.label }, hint: s.busy.hint });
    if (!wallet) return action({ button: { label: "Connect a wallet to fill" }, notice: { kind: "info", text: NO_WALLET }, extra: copyButton(location.href) });
    if (!me) return action({ steps, step: 0, button: { label: "Connect wallet", run: connect }, hint: "Connect the wallet you will pay from. Nothing is sent yet.", notice: s.notice });
    if (same(me, d.maker)) {
      return action({ notice: { kind: "info", text: `This is your own deal: you cannot fill it. Until someone does, you can cancel it and take back your ${get}.` },
        extra: h("button", { class: "secondary", type: "button", testid: "cancel-action", onclick: (e) => press(e, cancel) }, `Cancel the deal and take back ${get}`) });
    }
    if (!mayFill(d, me)) {
      return action({ notice: { kind: "warn", text: `This deal is for another address: only ${d.taker} can fill it. The wallet you connected is ${me}. If the other address is yours too, switch to it in your wallet.` } });
    }
    if (wallet.chainId !== config.chainId) {
      return action({ steps, step: 0, button: { label: `Switch to ${networkName(config.chainId)}`, run: switchNetwork },
        hint: `Your wallet is on ${networkName(wallet.chainId)}, and this deal is on ${networkName(config.chainId)}.`, notice: s.notice });
    }
    const f = s.funds;
    if (!f || f.account !== me) return action({ steps, step: 1, button: { label: `Checking your ${buy.symbol}…` } });
    if (f.balance < d.buyAmount) {
      return action({ steps, step: 1, button: { label: `Not enough ${buy.symbol}` }, notice: { kind: "warn", text: `To fill this deal you pay ${pay}, and this wallet holds ${amount(f.balance, buy)}.` } });
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
  const approve = () => act(`Approving ${amount(s.deal.buyAmount, s.buy)}…`, 1, (stage) => approveToken(s.buy, s.deal.buyAmount, s.funds.allowance, stage));
  const fill = () => act("Filling the deal…", 2, async (stage) => {
    await transact(config.contract, fillData(id), stage, `Paying ${amount(s.deal.buyAmount, s.buy)} for ${amount(s.deal.sellAmount, s.sell)}`);
    s.done = "filled";
  });
  const cancel = () => act("Cancelling…", null, async (stage) => {
    await transact(config.contract, cancelData(id), stage, "Cancelling the deal");
    s.done = "cancelled";
  });

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

// ------------------------------------------------------------------------------------------- making a deal

function newDealPage() {
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
  const form = card(
    h("h1", {}, "Make a deal"),
    h("p", { class: "lead" }, "Offer tokens for other tokens. You get a link to send to the other side, who fills the deal from their wallet."),
    h("div", { class: "leg" }, h("label", { class: "leg-label", for: "sell-amount" }, "You give"), h("div", { class: "leg-row" }, field.sellAmount, pill.sell),
      h("label", { class: "small", for: "sell-token" }, "Token"), field.sellToken, note.sell),
    h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
    h("div", { class: "leg" }, h("label", { class: "leg-label", for: "buy-amount" }, "You get"), h("div", { class: "leg-row" }, field.buyAmount, pill.buy),
      h("label", { class: "small", for: "buy-token" }, "Token"), field.buyToken, note.buy),
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
    if (!tokenText) return { problem: `Enter the token you ${verb}`, quiet: true };
    if (!isAddress(tokenText)) return { problem: `Check the token you ${verb}`, note: "A token address is 0x followed by 40 letters and digits." };
    const t = tokenAt(tokenText);
    if (t.pending) return { pending: true };
    if (t.missing) return { problem: `Check the token you ${verb}`, note: `No token answers at this address on ${networkName(config.chainId)}.` };
    if (!amountText) return { token: t.info, problem: `Enter the amount you ${verb}`, quiet: true };
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
    const expiry = /^\d+(\.\d+)?$/.test(hoursText) && hours > 0 && hours <= 8760 ? { hours } : { problem: "Check the hours", note: "Write a number of hours, more than 0 and at most 8760 (a year), like 24 or 0.5." };
    const distinct = sell.token && buy.token && sell.token.address === buy.token.address ? { problem: "Pick two different tokens", note: "The token you give and the token you get are the same." } : {};
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
      if (read === fundsRead) [s.funds, s.notice] = [null, { kind: "error", text: explain(e) }];
    }
    update();
  }

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
    if (!s.created && wallet.account && t.sell.token) await loadFunds(t.sell.token); // read again before the button comes back
    s.busy = null;
    update();
  }

  function update() {
    if (!live) return;
    if (s.created) return main.replaceChildren(created());
    const t = terms();
    for (const [key, x] of [["sell", t.sell], ["buy", t.buy]]) {
      pill[key].replaceChildren(...(x.token ? [h("i", { class: "dot", style: `--hue:${hue(x.token.address)}` }), x.token.symbol] : ["Token"]));
      pill[key].classList.toggle("empty", !x.token);
      const holds = key === "sell" && x.token && wallet?.account && s.funds?.key === `${wallet.account}:${x.token.address}` ? ` · you hold ${amount(s.funds.balance, x.token)}` : "";
      setNote(note[key], x.note ?? (x.pending ? "Looking up the token…" : x.token ? `${x.token.symbol}, ${x.token.decimals} decimals${holds}` : ""), Boolean(x.note));
    }
    if (t.distinct.note) setNote(note.buy, t.distinct.note, true);
    setNote(note.taker, t.taker.note ?? (t.taker.address === ZERO_ADDRESS ? "Anyone who has the link can fill it." : "Only this address can fill it."), Boolean(t.taker.note));
    setNote(note.hours, t.expiry.note ?? `Until ${DATE.format(new Date(Date.now() + t.expiry.hours * 3_600_000))}.`, Boolean(t.expiry.note));
    summary.replaceChildren(...(t.problem || t.pending ? [] : [
      h("p", {}, `You give ${amount(t.sell.units, t.sell.token)} and get ${amount(t.buy.units, t.buy.token)}.`),
      h("p", {}, `${t.taker.address === ZERO_ADDRESS ? "Anyone with the link" : "Only the address you named"} can fill it, for ${t.expiry.hours} hour${t.expiry.hours === 1 ? "" : "s"}. Until then your ${amount(t.sell.units, t.sell.token)} stay locked in the deal contract, and you can cancel to take them back.`)]));
    actionArea.replaceChildren(actions(t));
  }

  function actions(t) {
    const steps = ["Connect", `Approve ${t.sell.token?.symbol ?? "token"}`, "Create"];
    if (s.busy) return action({ steps, step: s.busy.step, button: { label: s.busy.label }, hint: s.busy.hint });
    if (!wallet) return action({ button: { label: "Connect a wallet to make a deal" }, notice: { kind: "info", text: NO_WALLET } });
    if (!wallet.account) return action({ steps, step: 0, button: { label: "Connect wallet", run: connect }, hint: "Connect the wallet that holds what you give. Nothing is sent yet.", notice: s.notice });
    if (wallet.chainId !== config.chainId) {
      return action({ steps, step: 0, button: { label: `Switch to ${networkName(config.chainId)}`, run: switchNetwork },
        hint: `Your wallet is on ${networkName(wallet.chainId)}; deals are on ${networkName(config.chainId)}.`, notice: s.notice });
    }
    if (t.pending) return action({ steps, step: 1, button: { label: "Looking up the tokens…" } });
    if (t.problem) return action({ steps, step: 1, button: { label: t.problem }, notice: s.notice });
    const f = fundsOf(t.sell.token), give = amount(t.sell.units, t.sell.token);
    if (!f) return action({ steps, step: 1, button: { label: `Checking your ${t.sell.token.symbol}…` } });
    if (f.balance < t.sell.units) return action({ steps, step: 1, button: { label: `Not enough ${t.sell.token.symbol}` }, notice: { kind: "warn", text: `You give ${give}, and this wallet holds ${amount(f.balance, t.sell.token)}.` } });
    if (f.allowance < t.sell.units) {
      return action({ steps, step: 1, button: { label: `Approve ${give}`, run: () => approve(t, f) },
        hint: `This lets the deal contract take exactly ${give} from your wallet when you create the deal. Nothing moves yet.`, notice: s.notice });
    }
    return action({ steps, step: 2, button: { label: "Create the deal", run: () => create(t) },
      hint: `Your ${give} move into the deal contract. They go to the other side when the deal is filled, or back to you if you cancel it.`, notice: s.notice });
  }

  const connect = () => act("Connecting…", 0, () => wallet.connect());
  const switchNetwork = () => act("Switching network…", 0, () => wallet.switchTo(config.chainId));
  const approve = (t, f) => act(`Approving ${amount(t.sell.units, t.sell.token)}…`, 1, (stage) => approveToken(t.sell.token, t.sell.units, f.allowance, stage));
  const create = (t) => act("Creating the deal…", 2, async (stage) => {
    const start = Math.max(Date.now() / 1000, await chain.now());
    const deal = { sellToken: t.sell.token.address, sellAmount: t.sell.units, buyToken: t.buy.token.address, buyAmount: t.buy.units, taker: t.taker.address,
      expiry: BigInt(Math.floor(start + t.expiry.hours * 3600)) };
    const receipt = await transact(config.contract, createDealData(deal), stage, `Creating the deal: ${amount(deal.sellAmount, t.sell.token)} for ${amount(deal.buyAmount, t.buy.token)}`);
    const id = createdId(receipt, config.contract);
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
        h("div", {}, h("dt", {}, "They pay"), h("dd", {}, amount(c.buyAmount, c.buy))),
        h("div", {}, h("dt", {}, "They get"), h("dd", {}, amount(c.sellAmount, c.sell))),
        h("div", {}, h("dt", {}, "Who can fill"), h("dd", {}, c.taker === ZERO_ADDRESS ? "Anyone who has the link" : ["Only ", h("span", { class: "mono" }, c.taker)])),
        h("div", {}, h("dt", {}, "Expires"), h("dd", {}, when(Number(c.expiry), Date.now() / 1000)))),
      h("p", { class: "hint" }, `Your ${amount(c.sellAmount, c.sell)} are locked in the deal contract. To take them back before someone fills the deal, open it with this wallet and cancel it.`));
  }

  main.replaceChildren(form);
  update();
  return {
    update: () => {
      if (!s.busy) s.funds = null; // the account or the network changed: read the wallet's tokens again
      update();
    },
    stop: () => (live = false),
  };
}

// ------------------------------------------------------------------------------------------- the home page

function homePage() {
  const number = h("input", { id: "deal-number", inputmode: "numeric", placeholder: "Deal number", autocomplete: "off" });
  const open = (e) => {
    e.preventDefault();
    if (/^\d+$/.test(number.value.trim())) location.hash = `#/d/${number.value.trim()}`;
  };
  main.replaceChildren(card(
    h("h1", {}, "One deal, one link"),
    h("p", { class: "lead" }, "Offer tokens for other tokens and send the link to the other side. They see what they pay and what they get, and fill it from their wallet: both sides swap in one transaction, or nothing moves."),
    h("a", { class: "button primary", href: "#/new" }, "Make a deal"),
    h("form", { class: "row", onsubmit: open }, number, h("button", { class: "secondary", type: "submit" }, "Open"))));
  return { update() {}, stop() {} };
}

// ------------------------------------------------------------------------------------------- shared

/** Sends `data` to `to` from the wallet once the chain says it would go through, and waits for it to be mined. */
async function transact(to, data, stage, what) {
  await chain.call(to, data, wallet.account); // a transaction the chain would refuse is not sent: its reason is shown instead
  stage(`${what}. Confirm it in your wallet.`);
  const hash = await wallet.send({ to, data }, config.chainId);
  stage(`${what}. Sent: waiting for the network to confirm it.`);
  const receipt = await chain.receipt(hash);
  if (receipt.status !== "0x1") throw new Error("The transaction failed on the chain, and nothing moved. Try again.");
  return receipt;
}

/** Approves the deal contract for exactly `units` of `token`. */
async function approveToken(token, units, allowance, stage) {
  const data = approveData(config.contract, units);
  // Some tokens (USDT among them) refuse to change an approval that is not zero: it is set to zero first.
  if (allowance > 0n && (await chain.call(token.address, data, wallet.account).then(() => false, () => true))) {
    await transact(token.address, approveData(config.contract, 0n), stage, `Setting your ${token.symbol} approval to zero first`);
  }
  await transact(token.address, data, stage, `Approving ${amount(units, token)}`);
}

/** A press of the page's button: it is disabled at once, before anything is awaited. */
function press(event, run) {
  event.currentTarget.disabled = true;
  run();
}

/** The block under a deal or the form: the steps, the one button (`run` makes it pressable), what it does, and a notice. */
function action({ steps, step, button, hint, notice: message, extra }) {
  return h("div", { class: "action" },
    steps && h("ol", { class: "steps" }, steps.map((name, i) => h("li", { class: i < step ? "done" : i === step ? "now" : "" }, name))),
    button && h("button", { class: "primary", type: "button", testid: "primary-action", disabled: !button.run, onclick: button.run && ((e) => press(e, button.run)) }, button.label),
    hint && h("p", { class: "hint" }, hint),
    message && notice(message),
    extra);
}

const notice = ({ kind, text }) => h("p", { class: `notice ${kind}`, testid: "notice", role: "status" }, text);

function copyButton(text) {
  return h("button", { class: "secondary", type: "button", onclick: async (e) => {
    const button = e.currentTarget;
    const copied = navigator.clipboard ? await navigator.clipboard.writeText(text).then(() => true, () => false) : false;
    button.textContent = copied ? "Link copied" : "Copying failed: copy the link from the address bar";
    setTimeout(() => (button.textContent = "Copy link"), 2500);
  } }, "Copy link");
}

function head(title, status) {
  return h("div", { class: "card-head" }, h("h1", {}, title), h("span", { class: `status ${status}`, testid: "deal-status", "data-status": status }, STATUS_WORDS[status]));
}

/** One side of a deal: its amount, its token's symbol and its token's address. */
function leg(label, units, token, side) {
  const text = formatAmount(units, token.decimals);
  return h("div", { class: "leg" },
    h("div", { class: "leg-label" }, label),
    h("div", { class: "leg-row" },
      h("span", { class: `amount${text.length > 16 ? " long" : text.length > 10 ? " mid" : ""}`, testid: `${side}-amount` }, text),
      h("span", { class: "token" }, h("i", { class: "dot", style: `--hue:${hue(token.address)}` }), h("span", { testid: `${side}-symbol` }, token.symbol))),
    h("div", { class: "leg-sub" }, "Token contract ", h("span", { class: "mono" }, token.address)));
}

function showAccount() {
  const chip = document.getElementById("account");
  chip.hidden = !wallet?.account;
  chip.textContent = wallet?.account ? `${wallet.account.slice(0, 6)}…${wallet.account.slice(-4)}` : "";
}

function setNote(el, text, problem) {
  el.textContent = text;
  el.classList.toggle("problem", problem);
}

/** "Fri, 20 Nov 2026, 15:23 UTC (in 2 hours)" for unix time `seconds`. */
function when(seconds, now) {
  if (seconds > 253_402_300_799) return "Never (after the year 9999)";
  return `${DATE.format(new Date(seconds * 1000))} (${fromNow(seconds - now)})`;
}

function fromNow(seconds) {
  const abs = Math.abs(seconds);
  if (abs < 60) return seconds >= 0 ? "in less than a minute" : "less than a minute ago";
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (abs < 172_800) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  return RELATIVE.format(Math.round(seconds / 86_400), "day");
}

const networkName = (chainId) => NETWORKS[chainId] ?? `chain ${chainId}`;
const amount = (units, token) => `${formatAmount(units, token.decimals)} ${token.symbol}`;
const hue = (address) => parseInt(address.slice(2, 8), 16) % 360;
const card = (...children) => h("section", { class: "card" }, ...children);

/** The page's DOM builder: h("p", { class, testid, onclick… }, "text", child…). Text is always text, never HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "testid") el.setAttribute("data-testid", value);
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== ""));
  return el;
}
