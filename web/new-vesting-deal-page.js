import { same, ZERO_ADDRESS } from "./eth.js";
import { action, amount, card, h, leg, networkName, NO_WALLET } from "./ui.js";
import { isAddress, parseAmount } from "./units.js";
import { createV2Data, economics, fundedId, IMMEDIATE, MAX_TIME, MAX_UINT, NEW_VESTING, v2Approval, v2Reason } from "./vesting-chain.js";
import { deliveryName, fees, operation, readSession, saveSession, schedule, transactionStatus } from "./vesting-ui.js";

const DAY = 86400n;

export function newVestingDealPage(app) {
  const { chain, config, wallet } = app;
  const draftKey = "otc-v2-draft:" + config.chainId + ":" + config.contract;
  const draft = readSession(draftKey) ?? {};
  let live = true, revision = 0, prepared = null, problem = "Enter the deal terms.";
  const summary = h("div");
  const actions = h("div");
  const fields = {};

  function field(name, label, options = {}, initial = "") {
    const id = "v2-" + name;
    const input = h("input", { id, testid: id, autocomplete: "off", spellcheck: "false",
      value: draft[name] ?? initial, ...options, oninput: update });
    fields[name] = input;
    return h("div", { class: "field" }, h("label", { for: id }, label), input);
  }

  const delivery = h("select", { id: "v2-delivery", testid: "v2-delivery", onchange: update },
    h("option", { value: "immediate" }, "Immediate delivery"),
    h("option", { value: "vesting" }, "New vesting grant"),
    h("option", { value: "unsupported" }, "Existing vesting position"));
  delivery.value = draft.delivery ?? "vesting";
  fields.delivery = delivery;
  const startMode = h("select", { id: "v2-start-mode", testid: "v2-start-mode", onchange: update },
    h("option", { value: "settlement" }, "At settlement"),
    h("option", { value: "fixed" }, "Fixed UTC time"));
  startMode.value = draft.startMode ?? "settlement";
  fields.startMode = startMode;
  const fixedField = field("fixedStart", "Fixed start (UTC)", { type: "datetime-local", step: "1" });
  const timings = h("div", { class: "v2-fields" },
    h("div", { class: "field" }, h("label", { for: startMode.id }, "Accrual starts"), startMode),
    fixedField, field("cliffDays", "Cliff (days)", { inputmode: "numeric" }, "30"),
    field("durationDays", "Duration (days)", { inputmode: "numeric" }, "90"),
    h("p", { class: "hint v2-wide" }, "A day is exactly 86,400 seconds. At the cliff the accrued portion becomes available."));

  const root = card(
    h("p", { class: "version-label" }, "OTC deal · V2"),
    h("h1", {}, "Create a private deal"),
    h("p", { class: "lead" }, "Fund the allocation first, then share the deal with the designated buyer."),
    h("div", { class: "field" }, h("label", { for: delivery.id }, "Delivery"), delivery),
    h("div", { class: "v2-fields" },
      field("baseToken", "Allocation token address", { class: "mono", placeholder: "0x…" }),
      field("allocation", "Allocation amount", { inputmode: "decimal", placeholder: "1000000" }),
      field("quoteToken", "Payment token address", { class: "mono", placeholder: "0x…" }),
      field("quote", "Agreed payment before fees", { inputmode: "decimal", placeholder: "123.456789" }),
      field("buyer", "Designated buyer", { class: "mono", placeholder: "0x…" }),
      field("expiryHours", "Expires in (hours)", { inputmode: "decimal" }, "24")),
    timings,
    summary,
    actions,
    h("p", { class: "hint v2-foot" }, "Verify both token addresses. Fee-on-transfer, rebasing and freezing tokens can prevent a transfer or refund."));
  root.classList.add("v2-card");

  const tx = operation(app, "fund", {
    render: renderActions,
    refresh: update,
    onReceipt(kind, receipt) {
      if (kind !== "fund") return;
      const id = fundedId(receipt, config.contract);
      saveSession(draftKey, null);
      location.hash = "#/v2/" + id;
    },
  });

  function inputs() {
    return Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value.trim()]));
  }

  function days(value, label) {
    if (!/^\d{1,12}$/.test(value)) throw new Error(label + " must be a whole number of days.");
    return BigInt(value) * DAY;
  }

  async function prepare(values) {
    for (const [key, label] of [["baseToken", "allocation token"], ["quoteToken", "payment token"], ["buyer", "designated buyer"]]) {
      if (!isAddress(values[key]) || same(values[key], ZERO_ADDRESS)) throw new Error("Enter a valid " + label + " address.");
    }
    if (same(values.baseToken, values.quoteToken)) throw new Error("Choose two different tokens.");
    if (same(values.buyer, config.contract)) throw new Error("Choose a buyer that can settle from a wallet.");
    if (same(values.buyer, wallet?.account)) throw new Error("Enter the other party’s address as buyer.");
    if (!values.allocation || !values.quote) throw new Error("Enter the allocation and payment amounts.");
    const hours = Number(values.expiryHours);
    if (!/^\d+(\.\d+)?$/.test(values.expiryHours) || hours < 1 / 60 || hours > 8760) {
      throw new Error("Use an expiry of at least one minute and at most 8760 hours.");
    }
    const mode = values.delivery === "vesting" ? NEW_VESTING : IMMEDIATE;
    const durationSeconds = mode === NEW_VESTING ? days(values.durationDays, "Duration") : 0n;
    const cliffSeconds = mode === NEW_VESTING ? days(values.cliffDays, "Cliff") : 0n;
    if (mode === NEW_VESTING && cliffSeconds >= durationSeconds) throw new Error("Use a positive duration and a shorter cliff.");
    const fixed = mode === NEW_VESTING && values.startMode === "fixed";
    const fixedMillis = fixed ? Date.parse(values.fixedStart + "Z") : 0;
    if (!Number.isFinite(fixedMillis) || fixedMillis < 0) throw new Error("Enter the fixed start in UTC.");
    const fixedStart = BigInt(Math.floor(fixedMillis / 1000));
    const [base, quoteToken, now, treasury] = await Promise.all([
      chain.token(values.baseToken).catch(() => { throw new Error("No ERC-20 answers at the allocation token address on " + networkName(config.chainId) + "."); }),
      chain.token(values.quoteToken).catch(() => { throw new Error("No ERC-20 answers at the payment token address on " + networkName(config.chainId) + "."); }),
      chain.now(), chain.treasury(),
    ]);
    if (fixed && fixedStart <= BigInt(now)) throw new Error("The fixed start must be later than the latest block.");
    const expiry = BigInt(now + Math.floor(hours * 3600));
    if ((fixedStart || (expiry - 1n)) + durationSeconds > MAX_TIME) throw new Error("The schedule exceeds the on-chain time range.");
    const allocation = parseAmount(values.allocation, base.decimals, base.symbol || "The allocation token");
    const quote = parseAmount(values.quote, quoteToken.decimals, quoteToken.symbol || "The payment token");
    if (economics(quote).buyerTotal > MAX_UINT) throw new Error("Payment plus its buyer fee is too large.");
    const terms = { baseToken: base.address, quoteToken: quoteToken.address, buyer: values.buyer, allocation, quote,
      expiry, delivery: mode, fixedStart, cliffSeconds, durationSeconds };
    const account = wallet?.account;
    const funds = account && wallet.chainId === config.chainId ? await Promise.all([
      chain.balanceOf(base.address, account), chain.allowance(base.address, account),
    ]) : null;
    return { terms, base, quoteToken, treasury, funds, account };
  }

  async function update() {
    if (!live) return;
    const values = inputs(), current = ++revision;
    saveSession(draftKey, values);
    timings.hidden = values.delivery !== "vesting";
    fixedField.hidden = values.startMode !== "fixed";
    problem = values.delivery === "unsupported"
      ? "Existing positions, revocable rights, screenshots and URLs cannot be funded through V2."
      : "Checking the terms…";
    prepared = null;
    if (!tx.state.busy) summary.replaceChildren();
    renderActions();
    if (values.delivery === "unsupported") return;
    try {
      const result = await prepare(values);
      if (!live || revision !== current) return;
      prepared = result;
      const { terms, base, quoteToken, treasury } = result;
      summary.replaceChildren(h("div", { class: "v2-preview" },
        h("h2", {}, "Review funded terms"),
        leg(deliveryName(terms.delivery), terms.allocation, base, "receive"),
        fees(terms.quote, quoteToken, treasury), schedule(terms)));
    } catch (error) {
      if (!live || revision !== current) return;
      problem = v2Reason(error);
    }
    renderActions();
  }

  function renderActions() {
    if (!live) return;
    const { busy, pending } = tx.state;
    for (const field of Object.values(fields)) field.disabled = Boolean(busy || pending);
    let button, hint;
    if (busy) button = { label: "Working…" };
    else if (pending) button = { label: "Check transaction", run: tx.resume };
    else if (!prepared) [button, hint] = [{ label: "Review before funding" }, problem];
    else if (!wallet) [button, hint] = [{ label: "Connect wallet" }, NO_WALLET];
    else if (!wallet.account) button = { label: "Connect wallet", run: () => tx.wallet(() => wallet.connect()) };
    else if (wallet.chainId !== config.chainId) button = {
      label: "Switch to " + networkName(config.chainId), run: () => tx.wallet(() => wallet.switchTo(config.chainId)),
    };
    else {
      const { terms, base, funds } = prepared;
      if (!funds || !same(prepared.account, wallet.account)) button = { label: "Checking balance…" };
      else if (funds[0] < terms.allocation) [button, hint] = [
        { label: "Insufficient allocation balance" }, "This wallet holds " + amount(funds[0], base) + ".",
      ];
      else if (funds[1] < terms.allocation) button = {
        label: "Approve " + amount(terms.allocation, base),
        run: () => tx.transact("approve", base.address, () => v2Approval(app, base, terms.allocation, funds[1])),
      };
      else button = {
        label: "Fund deal",
        run: () => tx.transact("fund", config.contract, async () => {
          const refreshed = await prepare(inputs());
          if (!same(prepared?.account, refreshed.account) || refreshed.terms.allocation !== terms.allocation) {
            throw new Error("The active wallet or terms changed. Review the deal before funding.");
          }
          return createV2Data(refreshed.terms);
        }),
      };
    }
    const next = action({ button, hint, extra: transactionStatus(config, tx) });
    if (!actions.firstElementChild?.isEqualNode(next)) actions.replaceChildren(next);
  }

  app.main.replaceChildren(root);
  update();
  if (tx.state.pending) tx.resume();
  return { update, stop: () => { live = false; } };
}
