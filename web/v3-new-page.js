// #/v3/new: the form a broker prepares a deal with. The broker writes down who sells, who buys, the tokens and the
// amounts, how the tokens are delivered, how long the deal stays open, and the broker's own address and share of the
// fees. The page shows the exact money before anything exists: both 0.5% fees, what the buyer pays, what the seller
// receives, the broker's share to the token's smallest unit and what is left for the treasury. Its one button makes
// the deal's link. That needs no wallet, signs nothing and gives nobody any right: the seller funds the deal and the
// buyer settles it, each from their own wallet, on the deal's page.
// #/v3/new/<terms> starts the form from another deal's terms (to duplicate them): the new deal gets a new nonce and
// a new deadline, so it is another deal with another ID, and the old one is unchanged.
import { explain, same } from "./eth.js";
import { action, amount, card, copyButton, dot, fact, h, networkName, secondary, setNote, show, span, TOKEN_WARNING, utc } from "./ui.js";
import { daysToSeconds, formatAmount, isAddress, openFor, parseAmount, parseUtc } from "./units.js";
import { BPS, IMMEDIATE, linkOf, money, packTerms, percent, remember, unpackTerms, VESTING } from "./v3.js";

/** A share of the fees typed as a percentage ("20", "12.5") -> hundredths of a percent, or what to fix. */
export function shareOf(text) {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  const bps = match ? BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0") : null;
  if (!text) return { problem: "Enter the broker's share", note: "Write the broker's share of the fees as a percentage, like 20. Write 0 for none." };
  if (bps === null || bps > BPS) return { problem: "Check the broker's share", note: "Write a percentage from 0 to 100, with at most two digits after the dot, like 20 or 12.5." };
  return { bps };
}

/** A number of seconds as days, for the form: "30", "0.5". Exact whenever the seconds came from such a number of days. */
function daysOf(seconds) {
  let rest = seconds % 86_400n, digits = "";
  while (rest && digits.length < 12) {
    rest *= 10n;
    digits += rest / 86_400n;
    rest %= 86_400n;
  }
  return digits ? `${seconds / 86_400n}.${digits}` : `${seconds / 86_400n}`;
}

/** A nonce no deal of this seller is likely to have used: 64 random bits. */
function newNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`) || 1n;
}

export function newDealPageV3(app, from = "") {
  const { config, chain, wallet, v3 } = app;
  const s = { tokens: {}, treasury: null, ahead: 0, busy: null, notice: null, created: null };
  let live = true;
  if (!v3) {
    app.main.replaceChildren(card(h("h1", {}, "Broker deals are not set up here"),
      h("p", { class: "lead" }, "This site's config.json names no broker deals contract (contractV3), so broker deals cannot be prepared here."),
      h("a", { class: "button secondary", href: "#/" }, "Back to the start")));
    return { update() {}, stop() {} };
  }
  const copied = unpackTerms(from);

  const input = (testid, placeholder, more = {}) =>
    h("input", { id: testid, testid, placeholder, autocomplete: "off", autocapitalize: "off", spellcheck: "false", ...more, oninput: update });
  const choice = (name, value, testid, label, sub, checked) => h("label", { class: "choice" },
    h("input", { type: "radio", name, value, testid, checked, onchange: update }), h("span", {}, h("strong", {}, label), h("small", {}, sub)));
  const field = {
    baseToken: input("base-token", "Token address, 0x…", { class: "mono" }),
    allocation: input("allocation", "0", { inputmode: "decimal", class: "amount-input" }),
    quoteToken: input("quote-token", "Token address, 0x…", { class: "mono" }),
    quote: input("quote", "0", { inputmode: "decimal", class: "amount-input" }),
    seller: input("seller", "The seller's address, 0x…", { class: "mono" }),
    buyer: input("buyer", "The buyer's address, 0x…", { class: "mono" }),
    broker: input("broker", "Your address, 0x…", { class: "mono" }),
    share: input("broker-share", "20", { inputmode: "decimal" }),
    hours: input("expiry-hours", "24", { inputmode: "decimal", value: "24" }),
    start: input("start-utc", "2026-12-01 00:00", { "aria-label": "Vesting start, date and time in UTC" }),
    cliff: input("cliff-days", "30", { inputmode: "decimal", value: "30" }),
    duration: input("duration-days", "90", { inputmode: "decimal", value: "90" }),
  };
  const delivery = h("fieldset", { class: "choices two" }, h("legend", {}, "Delivery"),
    choice("delivery", "immediate", "delivery-immediate", "Immediate", "The buyer gets the tokens when they pay.", true),
    choice("delivery", "vesting", "delivery-vesting", "Vesting", "The buyer gets a new grant that unlocks over time."));
  const startMode = h("fieldset", { class: "choices two" }, h("legend", {}, "Vesting starts"),
    choice("start", "settlement", "start-settlement", "At settlement", "When the buyer pays, at that block's time.", true),
    choice("start", "fixed", "start-fixed", "At a fixed time", "A date and time in UTC, still in the future."));
  const pill = { base: h("span", { class: "token" }), quote: h("span", { class: "token" }) };
  const note = Object.fromEntries(["base", "quote", "seller", "buyer", "broker", "share", "hours", "start", "cliff", "duration"].map((key) => [key, h("p", { class: "note" })]));
  const startBox = h("div", { class: "field" }, h("label", { for: "start-utc" }, "Start (UTC)"), field.start, note.start);
  const vestingBox = h("div", { class: "vesting-fields" }, startMode, startBox,
    h("div", { class: "pair" },
      h("div", { class: "field" }, h("label", { for: "cliff-days" }, "Cliff (days)"), field.cliff, note.cliff),
      h("div", { class: "field" }, h("label", { for: "duration-days" }, "Whole vesting (days)"), field.duration, note.duration)));
  const summary = h("div", { class: "summary" });
  const actionArea = h("div");
  const legOf = (label, amountInput, tokenPill, tokenInput, tokenNote) => h("div", { class: "leg" },
    h("label", { class: "leg-label", for: amountInput.id }, label),
    h("div", { class: "leg-row" }, amountInput, tokenPill),
    h("label", { class: "small", for: tokenInput.id }, "Token"), tokenInput, tokenNote);
  const person = (key, label, more) => h("div", { class: "field" }, h("label", { for: field[key].id }, label), field[key], note[key], more);
  const useWallet = wallet && h("button", { class: "secondary small-button", type: "button", testid: "use-wallet", onclick: mine }, "Use my wallet's address");
  // Two cards: what the broker enters, and what the deal will do with the button that makes its link. Side by side on a wide screen.
  const form = h("div", { class: "board form" },
    card(
      h("div", { class: "card-head" }, h("h1", {}, "Prepare a broker deal", " ", h("span", { class: "version", testid: "version" }, "v3"))),
      h("p", { class: "lead" }, "Write down what the seller and the buyer agreed on, and get one link for both. Preparing it signs nothing, moves nothing and gives nobody any right: "
        + "the seller funds the deal and the buyer settles it, each from their own wallet."),
      copied && h("p", { class: "notice info", testid: "copied", role: "status" }, "These are another deal's terms, copied. The new deal gets a new nonce and a new deadline, so it is "
        + "another deal with another ID. The deal they came from is unchanged, as every deal's terms are."),
      delivery,
      legOf("The seller sells", field.allocation, pill.base, field.baseToken, note.base),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      legOf("Price the buyer pays the seller, before fees", field.quote, pill.quote, field.quoteToken, note.quote),
      person("seller", "Seller"), person("buyer", "Buyer"), person("broker", "Broker: where your share is paid", useWallet),
      person("share", "Your share of the fees (%)"),
      person("hours", "Open for (hours)"),
      vestingBox,
      h("p", { class: "warning", testid: "token-warning" }, TOKEN_WARNING, " A token that keeps a fee on its transfers is refused at settlement.")),
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
    if (!isAddress(tokenText)) return { problem: `Check ${token}`, note: "A token address is 0x followed by 40 letters and digits." };
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

  /** One party's address from its field, or what to fix. `others` are the parties already named: a party is an address of its own. */
  function party(key, who, others) {
    const text = field[key].value.trim();
    if (!text) return { problem: `Enter the ${who}'s address` };
    if (!isAddress(text)) return { problem: `Check the ${who}'s address`, note: "An address is 0x followed by 40 letters and digits." };
    if (/^0x0{40}$/.test(text)) return { problem: `Check the ${who}'s address`, note: `The zero address cannot be the ${who}.` };
    if (same(text, v3.contract)) return { problem: `Check the ${who}'s address`, note: "This is the deal contract's own address." };
    const clash = others.find(([, other]) => other.address && same(other.address, text));
    if (clash) return { problem: `Check the ${who}'s address`, note: `This is the ${clash[0]}'s address. The seller, the buyer and the broker are three different addresses.` };
    return { address: text.toLowerCase() };
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
        if (out.fixedStart <= now() + 60) wrong("start", "Check the vesting start", "The start must be in the future, by more than a minute.");
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
  function read() {
    const vesting = checked(delivery) === "vesting";
    const base = side(field.baseToken.value.trim(), field.allocation.value.trim(), "the token sold", "the amount sold");
    const quote = side(field.quoteToken.value.trim(), field.quote.value.trim(), "the payment token", "the price");
    const distinct = base.token && quote.token && base.token.address === quote.token.address
      ? { problem: "Pick two different tokens", note: "The token sold and the payment token are the same." } : {};
    const seller = party("seller", "seller", []), buyer = party("buyer", "buyer", [["seller", seller]]), broker = party("broker", "broker", [["seller", seller], ["buyer", buyer]]);
    const share = shareOf(field.share.value.trim()), expiry = openFor(field.hours.value.trim());
    const schedule = vesting ? scheduleOf() : { fixedStart: 0, cliffSeconds: 0n, durationSeconds: 0n, notes: {} };
    const problem = [base, quote, distinct, seller, buyer, broker, share, expiry, schedule].find((x) => x.problem)?.problem;
    return { vesting, base, quote, distinct, seller, buyer, broker, share, expiry, schedule, problem, pending: base.pending || quote.pending };
  }

  /** The time deadlines are counted from: the browser's clock, or the chain's when that is ahead of it (a test chain whose time was moved on). */
  const now = () => Date.now() / 1000 + s.ahead;
  const readClock = () => chain.now().then((time) => {
    s.ahead = Math.max(0, time - Date.now() / 1000);
    update();
  }, () => {}); // unread, the browser's clock stands

  function update() {
    if (!live) return;
    if (s.created) {
      if (app.main.firstElementChild !== form) return show(app.main, created());
      app.main.replaceChildren(created()); // the form gives way to the link, which takes the focus
      return app.main.querySelector('[data-testid="deal-link"]').focus({ preventScroll: true });
    }
    const t = read();
    vestingBox.hidden = !t.vesting;
    startBox.hidden = checked(startMode) !== "fixed";
    for (const [key, x] of [["base", t.base], ["quote", t.quote]]) {
      pill[key].replaceChildren(...(x.token ? [dot(x.token), x.token.symbol] : ["Token"]));
      pill[key].classList.toggle("empty", !x.token);
      setNote(note[key], x.note ?? (x.pending ? "Looking up the token…" : x.token ? `${x.token.symbol}, ${x.token.decimals} decimals` : ""), Boolean(x.note));
    }
    if (t.distinct.note) setNote(note.quote, t.distinct.note, true);
    setNote(note.seller, t.seller.note ?? "Only this address can fund the deal: it deposits the tokens.", Boolean(t.seller.note));
    setNote(note.buyer, t.buyer.note ?? "Only this address can settle the deal, and a vesting grant only ever pays this address.", Boolean(t.buyer.note));
    setNote(note.broker, t.broker.note ?? "Your share is paid to this address when the buyer settles, and never before.", Boolean(t.broker.note));
    setNote(note.share, t.share.note ?? "A share of the two 0.5% fees, not of the price: 20 means a fifth of the fees. The treasury receives the rest.", Boolean(t.share.note));
    setNote(note.hours, t.expiry.note ?? `The deal can be funded and settled until ${utc(Math.floor(now() + t.expiry.hours * 3600))}. After that the seller takes back whatever was deposited.`, Boolean(t.expiry.note));
    const notes = t.schedule.notes;
    setNote(note.start, notes.start ?? (t.schedule.fixedStart ? `${utc(t.schedule.fixedStart)}. The buyer must settle before then.` : "Like 2026-12-01 00:00. The buyer must settle before then."), Boolean(notes.start));
    setNote(note.cliff, notes.cliff ?? (t.schedule.cliffSeconds ? `${span(t.schedule.cliffSeconds)} of chain time: nothing can be claimed before it.` : "No cliff: unlocking begins with the start."), Boolean(notes.cliff));
    setNote(note.duration, notes.duration ?? `${span(t.schedule.durationSeconds)} of chain time, from the start to fully vested.`, Boolean(notes.duration));
    show(summary, summaryOf(t));
    show(actionArea, actions(t)); // changed in place: the button keeps the focus
  }

  /** The exact money and schedule of the deal as it would be prepared, once the form is complete. */
  function summaryOf(t) {
    if (t.problem || t.pending) return h("div", {}, h("p", { class: "hint" }, "Fill in the form, and the exact amounts each side pays and receives, your share among them, appear here before any link exists."));
    const q = t.quote.token, m = money(t.quote.units, t.share.bps), sched = t.schedule;
    const deadline = Math.floor(Math.min(now() + t.expiry.hours * 3600, sched.fixedStart || Infinity)); // a fixed start ends it sooner
    const sum = (label, testid, units, who) => fact(label, h("span", { testid }, formatAmount(units, q.decimals)), ` ${q.symbol}`, who && h("span", { class: "mono block" }, who));
    const atCliff = t.vesting && amount((t.base.units * sched.cliffSeconds) / sched.durationSeconds, t.base.token);
    return h("div", {},
      h("dl", { class: "facts", testid: "summary" },
        fact("Delivery", h("span", { testid: "summary-delivery" }, t.vesting
          ? `Vesting: ${amount(t.base.units, t.base.token)} go into a new grant for the buyer when they pay`
          : `Immediate: ${amount(t.base.units, t.base.token)} go to the buyer when they pay`)),
        fact("Seller, the only address that can fund", h("span", { class: "mono", testid: "summary-seller" }, t.seller.address)),
        fact("Buyer, the only address that can settle", h("span", { class: "mono", testid: "summary-buyer" }, t.buyer.address)),
        fact("Can be funded and settled until", h("span", { testid: "summary-deadline", "data-seconds": String(deadline) }, utc(deadline))),
        sum("Price", "price", m.quote),
        sum("Buyer fee, 0.5% of the price", "buyer-fee", m.buyerFee),
        sum("Buyer pays in total", "buyer-total", m.buyerTotal),
        sum("Seller fee, 0.5% of the price", "seller-fee", m.sellerFee),
        sum("Seller receives", "seller-net", m.sellerNet),
        sum("Both fees together", "fee-pool", m.feePool),
        sum(`You receive, as broker: ${percent(t.share.bps)} of both fees`, "broker-fee", m.brokerFee, t.broker.address),
        sum("Treasury receives the rest of the fees", "treasury-fee", m.treasuryFee, s.treasury),
        t.vesting && fact("Vesting schedule", h("span", { testid: "summary-schedule" },
          `Starts ${sched.fixedStart ? utc(sched.fixedStart) : "when the buyer settles"}. `
          + (sched.cliffSeconds ? `Cliff ${span(sched.cliffSeconds)} later: ${atCliff} unlock at once. ` : "No cliff. ")
          + `Fully vested ${span(sched.durationSeconds)} after the start${sched.fixedStart ? `, ${utc(BigInt(sched.fixedStart) + sched.durationSeconds)}` : ""}; until then it unlocks second by second.`))),
      h("p", { class: "hint" }, "Each fee is rounded down to the payment token's smallest unit, and so is your share of them. They are taken only when the buyer settles: "
        + "funding, a refund, an expiry and vesting claims cost no fee and pay you nothing."));
  }

  /** The one button, or what the form still needs, and what the press does. */
  function actions(t) {
    if (s.busy) return action({ button: { label: s.busy.label } });
    if (t.pending) return action({ button: { label: "Looking up the tokens…" } });
    if (t.problem) return action({ button: { label: t.problem }, notice: s.notice });
    return action({ button: { label: "Create the deal link", run: () => create(t) },
      hint: "No wallet is needed and nothing is signed. The link carries exactly these terms; it gives nobody any right over anyone's tokens.", notice: s.notice });
  }

  /** Makes the deal's link from the form: the terms get their deadline and a fresh nonce, and the contract says their ID. */
  async function create(t) {
    s.busy = { label: "Preparing the link…" };
    s.notice = null;
    update();
    try {
      const start = Math.max(Date.now() / 1000, await chain.now());
      const terms = { seller: t.seller.address, buyer: t.buyer.address, baseToken: t.base.token.address, quoteToken: t.quote.token.address, allocation: t.base.units, quote: t.quote.units,
        expiry: BigInt(Math.floor(start + t.expiry.hours * 3600)), nonce: newNonce(), delivery: t.vesting ? VESTING : IMMEDIATE, fixedStart: BigInt(t.schedule.fixedStart),
        cliffSeconds: t.schedule.cliffSeconds, durationSeconds: t.schedule.durationSeconds, broker: t.broker.address, brokerBps: t.share.bps };
      const id = await v3.idOf(terms);
      remember(app, id, terms, "prepared");
      if (live) s.created = { id, terms, base: t.base.token, quote: t.quote.token, link: `${location.href.split("#")[0]}${linkOf(app, packTerms(terms))}` };
    } catch (e) {
      s.notice = { kind: "error", text: explain(e) };
    }
    s.busy = null;
    update();
  }

  /** Puts the connected wallet's address in the broker's field, connecting it first if need be. */
  async function mine() {
    try {
      if (!wallet.account) await wallet.connect();
      field.broker.value = wallet.account ?? "";
      s.notice = null;
    } catch (e) {
      s.notice = { kind: "error", text: explain(e) };
    }
    update();
  }

  function created() {
    const { id, terms: t, base, quote, link } = s.created, m = money(t.quote, t.brokerBps), vesting = t.delivery === VESTING;
    const again = () => {
      s.created = null;
      app.main.replaceChildren(form);
      update();
    };
    return card(
      h("div", { class: "card-head" }, h("h1", {}, "The deal's link is ready", " ", h("span", { class: "version", testid: "version" }, "v3"))),
      h("p", { class: "lead" }, "Send this one link to the seller, then to the buyer. It shows the terms to anyone, with no wallet, and it gives nobody any right: "
        + "the deal is on the chain only once the seller has signed these terms and funded it."),
      h("div", { class: "linkbox" }, h("a", { testid: "deal-link", href: link }, link)),
      h("div", { class: "row" }, copyButton(link), h("a", { class: "button secondary", href: link }, "Open the deal")),
      h("dl", { class: "facts" },
        fact("Deal ID", h("span", { class: "mono", testid: "created-id" }, id)),
        fact("Delivery", vesting ? "Vesting: a new grant for the buyer" : "Immediate: to the buyer's wallet"),
        fact("Seller", h("span", { class: "mono" }, t.seller)),
        fact("Buyer", h("span", { class: "mono" }, t.buyer)),
        fact("The buyer gets", amount(t.allocation, base)),
        fact("The buyer pays, fee included", amount(m.buyerTotal, quote)),
        fact("The seller receives, fee taken", amount(m.sellerNet, quote)),
        fact(`You receive, as broker: ${percent(t.brokerBps)} of both fees`, h("span", { testid: "created-broker-fee" }, amount(m.brokerFee, quote))),
        fact("Can be funded and settled until", utc(vesting && t.fixedStart && t.fixedStart < t.expiry ? t.fixedStart : t.expiry))),
      h("p", { class: "hint" }, "These terms cannot be changed. To change anything, prepare another deal: it gets another ID. This browser keeps the deal in your list, where you follow it to its receipt."),
      h("div", { class: "row" }, h("a", { class: "button secondary", testid: "to-history", href: "#/v3/deals" }, "Your broker deals"), secondary("another", "Prepare another deal", again)));
  }

  /** Starts the form from another deal's terms: everything but the deadline and the nonce, which the new deal gets afresh. */
  function fillFrom(t) {
    for (const key of ["seller", "buyer", "broker", "baseToken", "quoteToken"]) field[key].value = t[key];
    field.share.value = (Number(t.brokerBps) / 100).toString();
    if (t.delivery === VESTING) {
      delivery.querySelector('[value="vesting"]').checked = true;
      field.cliff.value = daysOf(t.cliffSeconds);
      field.duration.value = daysOf(t.durationSeconds);
      if (Number(t.fixedStart) > now() + 60) {
        startMode.querySelector('[value="fixed"]').checked = true;
        field.start.value = new Date(Number(t.fixedStart) * 1000).toISOString().slice(0, 19).replace("T", " ");
      }
    }
    Promise.all([chain.token(t.baseToken), chain.token(t.quoteToken)]).then(([base, quote]) => {
      field.allocation.value ||= formatAmount(t.allocation, base.decimals).replaceAll(",", "");
      field.quote.value ||= formatAmount(t.quote, quote.decimals).replaceAll(",", "");
      update();
    }, () => {}); // a token that does not answer is said by the form itself
  }

  app.main.replaceChildren(form);
  if (copied) fillFrom(copied);
  else if (wallet?.account) field.broker.value = wallet.account;
  update();
  v3.setup().then(({ treasury }) => {
    s.treasury = treasury;
    update();
  }, (e) => {
    s.notice = { kind: "error", text: explain(e) };
    update();
  });
  readClock();
  addEventListener("focus", readClock);
  return {
    update,
    stop() {
      live = false;
      removeEventListener("focus", readClock);
      app.main.classList.remove("wide");
    },
  };
}
