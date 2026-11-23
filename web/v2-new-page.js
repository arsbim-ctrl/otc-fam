import { approveExactly, explain, same, transact, ZERO_ADDRESS } from "./eth.js";
import { createV2Data, DELIVERY, feeBreakdown, fundedId } from "./eth-v2.js";
import { action, amount, card, fact, h, leg, networkName, NO_WALLET, notice, secondary } from "./ui.js";
import { isAddress, parseAmount } from "./units.js";
import { transactionTracker } from "./v2-transactions.js";
import { displayDelivery, economics, replaceIfChanged, schedule, spanAddress, tokenWarning, txDetails, utc, v2Link, version } from "./v2-ui.js";

const SUPPORTED_DATE = 253_402_300_799n;
const MAX_UINT256 = 2n ** 256n - 1n;
const UNSUPPORTED = "Existing vesting positions, revocable rights, screenshots and URLs cannot be used. Choose immediate delivery or a fully funded new grant.";

export function v2NewPage(app) {
  const { config, chain, wallet, main } = app;
  const tracker = transactionTracker(app, "new");
  const tokenInfo = new Map();
  const s = { snapshot: null, treasury: null, problem: null, funds: null, busy: null, notice: null, txHash: null };
  let live = true;

  const input = (id, props) => h("input", {
    id, testid: id, autocomplete: "off", spellcheck: "false", ...props,
    oninput: () => { s.notice = null; render(); },
  });
  const select = (id, choices) => h("select", { id, testid: id, onchange: () => { s.notice = null; render(); } },
    choices.map(([value, text]) => h("option", { value }, text)));
  const field = (label, node) => h("div", { class: "field" }, h("label", { for: node.id }, label), node);

  const delivery = select("delivery", [["immediate", "Immediate delivery"], ["vesting", "New vesting grant"], ["external", "Existing vesting position"]]);
  const base = input("base-token", { class: "mono", placeholder: "0x…" });
  const quote = input("quote-token", { class: "mono", placeholder: "0x…" });
  const allocation = input("allocation", { inputmode: "decimal", placeholder: "0.00" });
  const price = input("price", { inputmode: "decimal", placeholder: "0.00" });
  const buyer = input("buyer", { class: "mono", placeholder: "0x…" });
  const expiry = input("expiry", { inputmode: "decimal", value: "24" });
  const start = select("start-mode", [["settlement", "At settlement"], ["fixed", "Fixed UTC time"]]);
  const utcStart = input("fixed-start", { type: "datetime-local", step: 1 });
  const fixedField = field("Start date and time (UTC)", utcStart);
  const scheduleUnit = select("schedule-unit", [["days", "Days (24 hours each)"], ["seconds", "Seconds"]]);
  const cliff = input("cliff", { inputmode: "numeric", value: "30" });
  const duration = input("duration", { inputmode: "numeric", value: "90" });
  const scheduleFields = h("section", { class: "v2-schedule-form", "aria-labelledby": "schedule-heading" },
    h("h2", { id: "schedule-heading" }, "Vesting schedule"), field("Start", start), fixedField, field("Schedule unit", scheduleUnit),
    h("div", { class: "v2-grid" }, field("Cliff length", cliff), field("Total duration", duration)));
  const tokenLeg = (label, units, token, tokenLabel, meta) => h("div", { class: "leg" },
    h("label", { class: "leg-label", for: units.id }, label), units,
    h("label", { class: "small", for: token.id }, tokenLabel), token, meta);
  const baseMeta = h("p", { class: "note" }), quoteMeta = h("p", { class: "note" });
  const fields = h("fieldset", { class: "v2-fields" }, field("Delivery", delivery),
    tokenLeg("Base allocation", allocation, base, "Base token address", baseMeta),
    h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
    tokenLeg("Agreed price", price, quote, "Payment token address", quoteMeta),
    field("Designated buyer address", buyer), field("Settle within (hours)", expiry), scheduleFields);
  const preview = h("div"), controls = h("div");
  main.replaceChildren(card(
    h("div", { class: "card-head" }, h("h1", {}, "Create private deal"), version()),
    h("p", { class: "lead" }, "Fund the full allocation and share one link with the designated buyer."),
    h("div", { class: "v2-detail-grid" }, fields, h("div", {}, preview, controls, tokenWarning()))));
  document.title = "Create private deal · otc.fam V2";

  function lookup(text, name, meta) {
    if (!isAddress(text) || same(text, ZERO_ADDRESS)) {
      meta.textContent = "";
      return { reason: `Enter a valid ${name} address.` };
    }
    const key = text.toLowerCase();
    if (!tokenInfo.has(key)) {
      tokenInfo.set(key, { reason: `Looking up the ${name}…` });
      chain.token(key).then(
        (token) => tokenInfo.set(key, { token }),
        () => tokenInfo.set(key, { reason: `No token with readable decimals answered at the ${name} address.` }),
      ).then(render);
    }
    const result = tokenInfo.get(key);
    meta.textContent = result.token ? `${result.token.symbol || "Unnamed token"} · ${result.token.decimals} decimals` : result.reason;
    return result;
  }

  function form() {
    if (delivery.value === "external") return { reason: UNSUPPORTED, unsupported: true };
    if (!s.snapshot) return { reason: s.problem ?? "Reading the V2 contract…" };
    const asset = lookup(base.value.trim(), "base token", baseMeta);
    const payment = lookup(quote.value.trim(), "payment token", quoteMeta);
    if (!asset.token || !payment.token) return { reason: asset.reason ?? payment.reason };
    if (same(asset.token.address, payment.token.address)) return { reason: "Choose different base and payment tokens." };
    const buyerAddress = buyer.value.trim().toLowerCase();
    if (!isAddress(buyerAddress) || [ZERO_ADDRESS, config.contract, wallet?.account].some((other) => same(buyerAddress, other))) {
      return { reason: "Enter a valid buyer address different from the seller and escrow." };
    }
    try {
      const rawAllocation = parseAmount(allocation.value, asset.token.decimals, asset.token.symbol);
      const rawPrice = parseAmount(price.value, payment.token.decimals, payment.token.symbol);
      const fees = feeBreakdown(rawPrice);
      if (fees.buyerTotal > MAX_UINT256) throw new Error("The agreed price plus the buyer fee is too large.");
      const hours = expiry.value.trim();
      const seconds = Math.floor(Number(hours) * 3600);
      if (!/^\d+(\.\d+)?$/.test(hours) || seconds < 60 || seconds > 31_536_000) {
        throw new Error("Use a settlement window between one minute and 8,760 hours.");
      }
      const terms = {
        baseToken: asset.token.address, quoteToken: payment.token.address, buyer: buyerAddress, allocation: rawAllocation,
        quote: rawPrice, expiry: s.snapshot.time + BigInt(seconds), delivery: DELIVERY[delivery.value],
        fixedStart: 0n, cliffSeconds: 0n, durationSeconds: 0n,
      };
      if (terms.delivery === DELIVERY.vesting) readSchedule(terms);
      return { terms, asset: asset.token, payment: payment.token };
    } catch (e) {
      return { reason: e.message };
    }
  }

  function readSchedule(terms) {
    if (![cliff.value, duration.value].every((v) => /^\d{1,14}$/.test(v.trim()))) {
      throw new Error("Use whole numbers for the cliff and duration.");
    }
    const scale = scheduleUnit.value === "days" ? 86_400n : 1n;
    terms.cliffSeconds = BigInt(cliff.value) * scale;
    terms.durationSeconds = BigInt(duration.value) * scale;
    if (terms.cliffSeconds >= terms.durationSeconds) throw new Error("The cliff must be shorter than the duration.");
    if (start.value === "fixed") {
      const text = utcStart.value;
      const millis = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(text) ? Date.parse(`${text}Z`) : NaN;
      if (!Number.isFinite(millis)) throw new Error("Enter the fixed start in UTC.");
      terms.fixedStart = BigInt(millis / 1000);
      if (terms.fixedStart <= s.snapshot.time) throw new Error("Choose a fixed start after the latest block time.");
      if (terms.expiry > terms.fixedStart) throw new Error("Shorten the settlement window so it ends by the fixed start.");
    }
    if ((terms.fixedStart || terms.expiry) + terms.durationSeconds > SUPPORTED_DATE) {
      throw new Error("The vesting end must be in year 9999 or earlier.");
    }
  }

  async function readChain() {
    try {
      const snapshot = await chain.snapshot();
      const treasury = s.treasury ?? await chain.treasury(snapshot.block);
      Object.assign(s, { snapshot, treasury, problem: null });
    } catch (e) {
      Object.assign(s, { snapshot: null, problem: explain(e) });
    }
  }

  function sellerFunds(token) {
    const account = wallet.account;
    const key = `${account}:${token.address}`;
    if (s.funds?.key === key) return s.funds;
    const request = { key };
    s.funds = request;
    Promise.all([chain.balanceOf(token.address, account), chain.allowance(token.address, account)]).then(
      ([balance, allowance]) => Object.assign(request, { balance, allowance }),
      (e) => { request.error = explain(e); },
    ).then(render);
    return request;
  }

  function recheckBalance() {
    s.funds = null;
    render();
  }

  function render() {
    if (!live) return;
    const t = form();
    scheduleFields.hidden = delivery.value !== "vesting";
    fixedField.hidden = start.value !== "fixed";
    fields.disabled = Boolean(s.busy || tracker.pending);
    const terms = t.terms;
    replaceIfChanged(preview,
      terms && h("section", { class: "v2-section", "aria-label": "Deal review" }, h("h2", {}, "Review terms"),
        leg(displayDelivery(terms.delivery), terms.allocation, t.asset, "allocation"),
        economics(terms.quote, t.payment, s.treasury),
        h("dl", { class: "facts" }, fact("Buyer", spanAddress(terms.buyer)), fact("Expires (estimated)", utc(terms.expiry))),
        schedule(terms)));
    replaceIfChanged(controls, actions(t), txDetails("Transaction", s.txHash, config.chainId));
  }

  function actions(t) {
    if (s.busy) return action({ button: { label: s.busy }, hint: s.stage });
    if (tracker.pending) return action({
      button: { label: "Check transaction", run: resume },
      hint: "Funding may still be pending. Check your wallet activity and recheck the transaction here.",
      extra: txDetails("Submitted transaction", tracker.pending.hash, config.chainId), notice: s.notice,
    });
    if (t.unsupported) return action({ notice: { kind: "warn", text: t.reason } });
    if (s.problem) return action({ button: { label: "Retry network read", run: refresh }, notice: { kind: "error", text: s.problem } });
    if (!t.terms) return action({ hint: t.reason, notice: s.notice });
    if (!wallet) return action({ notice: { kind: "info", text: NO_WALLET } });
    if (!wallet.account) return action({ button: { label: "Connect seller wallet", run: connect }, notice: s.notice });
    if (wallet.chainId !== config.chainId) {
      return action({ button: { label: `Switch to ${networkName(config.chainId)}`, run: switchNetwork }, notice: s.notice });
    }
    const f = sellerFunds(t.asset);
    if (f.error) return action({ button: { label: "Retry balance read", run: recheckBalance }, notice: { kind: "error", text: f.error } });
    if (f.balance === undefined) return action({ hint: "Checking your token balance and allowance…" });
    const give = amount(t.terms.allocation, t.asset);
    if (f.balance < t.terms.allocation) return action({
      notice: { kind: "warn", text: `This seller holds ${amount(f.balance, t.asset)}. Funding requires ${give}. Top up this wallet, then recheck.` },
      extra: secondary("recheck-balance", "Recheck balance", recheckBalance),
    });
    if (f.allowance < t.terms.allocation) return action({
      button: { label: `Approve ${give}`, run: approve },
      hint: "Approval allows the V2 contract to take this allocation when you fund the deal.", notice: s.notice,
    });
    return action({ button: { label: "Fund deal & get link", run: fund },
      hint: `${give} will move to escrow. Trading fees are charged at settlement.`, notice: s.notice });
  }

  async function run(label, work) {
    if (!live || s.busy) return;
    Object.assign(s, { busy: label, stage: "", notice: null, txHash: null });
    render();
    try {
      await work((stage) => { s.stage = stage; render(); });
    } catch (e) {
      s.notice = { kind: "error", text: explain(e) };
      s.txHash = e.transactionHash;
    }
    s.busy = null;
    recheckBalance();
  }

  const completed = (receipt, operation) => {
    if (operation === "fund") {
      const id = fundedId(receipt, config.contract);
      location.hash = v2Link(config, id);
    } else {
      s.notice = { kind: "success", text: "Approval confirmed." };
      s.txHash = receipt.transactionHash;
    }
  };
  const appFor = (operation) => ({ ...app, waitForReceipt: (tx) => tracker.waitForReceipt(tx, operation) });
  const connect = () => run("Connecting…", () => wallet.connect());
  const switchNetwork = () => run("Switching network…", () => wallet.switchTo(config.chainId));
  const refresh = () => run("Refreshing…", async () => { tokenInfo.clear(); await readChain(); });
  const resume = () => run("Checking transaction…", async () => {
    const operation = tracker.pending.action;
    const receipt = await tracker.check(0);
    if (receipt) completed(receipt, operation);
    else s.notice = { kind: "info", text: "This request is still pending on the read-only network." };
  });
  const approve = () => run("Approving allocation…", async (stage) => {
    const account = wallet.account;
    await readChain();
    const { terms, asset, reason } = form();
    if (!terms) throw new Error(reason);
    if (!same(wallet.account, account)) throw new Error("Your wallet changed accounts. Review the seller before approving.");
    const allowance = await chain.allowance(asset.address, account);
    if (!same(wallet.account, account)) throw new Error("Your wallet changed accounts. Review the seller before approving.");
    completed(await approveExactly(appFor("approve"), asset, terms.allocation, allowance, stage), "approve");
  });
  const fund = () => run("Funding deal…", async (stage) => {
    const account = wallet.account;
    await readChain();
    const { terms, reason } = form();
    if (!terms) throw new Error(reason);
    if (!same(wallet.account, account)) throw new Error("Your wallet changed accounts. Review the seller before funding.");
    completed(await transact(appFor("fund"), config.contract, createV2Data(terms), stage, "Escrowing the allocation"), "fund");
  });

  render();
  if (tracker.pending) resume();
  readChain().then(render);
  return { update: recheckBalance, stop() { live = false; } };
}
