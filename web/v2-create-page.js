import { explain, same, ZERO_ADDRESS } from "./eth.js";
import { card, copyButton, dot, h, networkName } from "./ui.js";
import { isAddress, parseAmount } from "./units.js";
import { createData, fees, IMMEDIATE, NEW_VESTING, receiptEvents, UINT256_MAX } from "./v2-chain.js";
import { sendV2, tabStorage } from "./v2-transactions.js";
import {
  addressText, dealLink, economics, facts, money, panel, replaceChanged, scheduledTerms, submitApproval,
  tokenWarning, transactionFlow, transactionStatus, txHash, utc, walletAction, wireButton,
} from "./v2-ui.js";

const UINT64_MAX = (1n << 64n) - 1n;
const MAX_EXPIRY_MINUTES = 525600n;

function integer(text, label, max = UINT64_MAX) {
  if (!/^\d{1,20}$/.test(text) || BigInt(text) > max) {
    throw new Error(`${label} must be a whole number within its allowed range.`);
  }
  return BigInt(text);
}

function fixedUtc(text) {
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(text)
    ? text.length === 16 ? `${text}:00` : text
    : null;
  const date = new Date(iso && `${iso}Z`);
  if (!iso || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 19) !== iso) {
    throw new Error("Enter a valid fixed UTC date and time.");
  }
  return BigInt(date.valueOf()) / 1000n;
}

export function v2CreatePage(app) {
  const { chain, config, wallet } = app;
  const key = `otc-v2:${config.chainId}:${chain.contract}:draft`;
  const draft = tabStorage(key);
  const saved = draft.get();
  const cache = new Map();
  const state = { block: null, treasury: null, funds: null, readError: null, created: saved?.created ?? null, run: null };
  let live = true, sequence = 0;

  const field = (id, props = {}) => h("input", { id, testid: id, autocomplete: "off", spellcheck: "false", ...props });
  const select = (id, options) => h("select", { id, testid: id }, options.map(([value, label]) => h("option", { value }, label)));
  const fields = {
    delivery: select("delivery-mode", [
      ["immediate", "Immediate delivery"], ["vesting", "New vesting grant"], ["external", "Existing vesting position"],
    ]),
    baseToken: field("base-token", { class: "mono", placeholder: "0x…", autocapitalize: "off" }),
    allocation: field("allocation", { inputmode: "decimal", placeholder: "0", maxlength: 340 }),
    quoteToken: field("quote-token", { class: "mono", placeholder: "0x…", autocapitalize: "off" }),
    quote: field("quote", { inputmode: "decimal", placeholder: "0", maxlength: 340 }),
    buyer: field("buyer", { class: "mono", placeholder: "0x…", autocapitalize: "off" }),
    minutes: field("expiry-minutes", { inputmode: "numeric", value: "1440", maxlength: 6 }),
    startMode: select("start-mode", [["settlement", "At settlement"], ["fixed", "Fixed UTC date and time"]]),
    fixedStart: field("fixed-start", { type: "datetime-local", step: "1" }),
    unit: select("schedule-unit", [["days", "Days"], ["seconds", "Seconds"]]),
    cliffSeconds: field("cliff-length", { inputmode: "numeric", value: "30", maxlength: 20 }),
    durationSeconds: field("duration-length", { inputmode: "numeric", value: "90", maxlength: 20 }),
  };
  for (const [name, value] of Object.entries(saved?.fields ?? {})) {
    if (fields[name]) fields[name].value = value;
  }

  const label = (input, text, hint) => h("div", { class: "v2-field" },
    h("label", { for: input.id }, text), input, hint);
  const baseInfo = h("p", { class: "hint v2-meta" });
  const quoteInfo = h("p", { class: "hint v2-meta" });
  const fixedField = label(fields.fixedStart, "Start time in UTC",
    h("p", { class: "hint" }, "The buyer must settle before this time."));
  const schedule = h("fieldset", { class: "v2-schedule" },
    h("legend", {}, "Vesting schedule"),
    label(fields.startMode, "Start"), fixedField,
    label(fields.unit, "Measure the cliff and duration in"),
    h("div", { class: "v2-pair" },
      label(fields.cliffSeconds, "Cliff length"),
      label(fields.durationSeconds, "Total duration")),
    h("p", { class: "hint" }, "Tokens accrue from the start. The cliff releases the amount already accrued."));
  const termsBox = h("div");
  const statusBox = h("div");
  const description = h("p", { class: "hint" });
  const submit = h("button", { type: "button", class: "primary", testid: "primary-action", disabled: true, onclick: () => state.run?.() });
  const review = panel("review-terms", "Review terms", termsBox,
    h("div", { class: "v2-actions" }, submit, description, statusBox), tokenWarning());
  const readError = h("div");
  const inputs = h("fieldset", { class: "v2-inputs" },
    h("legend", { class: "sr-only" }, "Deal terms"),
    label(fields.delivery, "Delivery"),
    h("div", { class: "v2-fields", testid: "supported-fields" },
      h("div", { class: "leg v2-input-leg" }, label(fields.allocation, "Token allocation"),
        label(fields.baseToken, "Allocation token contract"), baseInfo),
      h("div", { class: "leg v2-input-leg" }, label(fields.quote, "Quoted payment"),
        label(fields.quoteToken, "Payment token contract"), quoteInfo),
      label(fields.buyer, "Designated buyer address"),
      label(fields.minutes, "Settle within (minutes)", h("p", { class: "hint" }, "Measured from the funding transaction’s latest block.")),
      schedule));
  const unsupported = h("p", { class: "notice warn", testid: "unsupported-position", role: "status", hidden: true },
    "Existing vesting positions are unsupported. Sablier positions, revocable rights, screenshots and URLs cannot be funded here. Select immediate delivery or a new grant.");
  const form = card(h("div", { class: "v2-heading" },
    h("span", { class: "v2-kicker" }, "OTC V2"), h("h1", {}, "Create a private deal"),
    h("p", { class: "lead" }, "Fund a token allocation and send one link to your designated buyer.")),
    readError, h("div", { class: "v2-grid" }, h("div", { class: "v2-panel" }, inputs, unsupported), review));
  form.classList.add("v2-card");
  const flow = transactionFlow(app, `${key}:tx`, render, (job, receipt) => {
    if (job.kind !== "fund") return;
    const event = receiptEvents(receipt, chain.contract).find((entry) => entry.name === "DealFunded");
    if (!event) throw new Error("The funding transaction confirmed without the expected DealFunded event.");
    state.created = { id: event.id.toString(), hash: receipt.transactionHash };
    save();
  });

  function save() {
    draft.set({ fields: Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, input.value])), created: state.created });
  }

  function lookup(input) {
    const token = input.value.trim().toLowerCase();
    return isAddress(token) && token !== ZERO_ADDRESS ? cache.get(token) : null;
  }

  async function loadToken(input) {
    const token = input.value.trim().toLowerCase();
    if (!isAddress(token) || token === ZERO_ADDRESS || cache.has(token)) return;
    cache.set(token, { loading: true });
    cache.set(token, await chain.token(token).then((info) => ({ info }), () => ({ missing: true })));
    render();
  }

  function asset(input, value, description) {
    const text = input.value.trim();
    if (/^https?:|^ipfs:|sablier\./i.test(text)) throw new Error("Existing position links and screenshots are unsupported. Enter an ERC-20 token address.");
    if (!isAddress(text) || same(text, ZERO_ADDRESS)) throw new Error(`Enter the ${description} token contract address.`);
    const entry = lookup(input);
    if (entry?.missing) throw new Error(`No ERC-20 metadata was found for the ${description} token on this network.`);
    if (!entry?.info) throw new Error(`Looking up the ${description} token…`);
    return { token: entry.info, units: parseAmount(value.value, entry.info.decimals, entry.info.symbol) };
  }

  function terms() {
    const delivery = fields.delivery.value === "vesting" ? NEW_VESTING : IMMEDIATE;
    const buyer = fields.buyer.value.trim().toLowerCase();
    if (/^https?:|^ipfs:|sablier\./i.test(buyer)) throw new Error("Existing position links are unsupported. Enter the buyer’s wallet address.");
    const base = asset(fields.baseToken, fields.allocation, "allocation");
    const payment = asset(fields.quoteToken, fields.quote, "payment");
    if (same(base.token.address, payment.token.address)) throw new Error("Use different token contracts for allocation and payment.");
    if (fees(payment.units).buyerTotal > UINT256_MAX) throw new Error("The quoted payment plus fees exceeds the maximum token amount.");
    if (!isAddress(buyer) || same(buyer, ZERO_ADDRESS) || same(buyer, wallet?.account) || same(buyer, chain.contract)) {
      throw new Error("Enter a designated buyer wallet address distinct from the seller and deal contract.");
    }
    if (!state.block || !state.treasury) throw new Error("Checking the OTC V2 contract and current block…");
    const minutes = integer(fields.minutes.value.trim(), "Expiry in minutes", MAX_EXPIRY_MINUTES);
    if (minutes < 1n) throw new Error("Allow at least one minute for settlement.");

    let fixedStart = 0n, cliffSeconds = 0n, durationSeconds = 0n;
    if (delivery === NEW_VESTING) {
      const multiplier = fields.unit.value === "days" ? 86400n : 1n;
      cliffSeconds = integer(fields.cliffSeconds.value.trim(), "Cliff length") * multiplier;
      durationSeconds = integer(fields.durationSeconds.value.trim(), "Duration") * multiplier;
      if (fields.startMode.value === "fixed") {
        fixedStart = fixedUtc(fields.fixedStart.value);
        if (fixedStart <= state.block.time) throw new Error("Choose a UTC start in the future according to the latest block.");
      }
      if (durationSeconds <= cliffSeconds || (fixedStart || state.block.time) + durationSeconds > UINT64_MAX) {
        throw new Error("The duration must be greater than the cliff and produce an on-chain end timestamp.");
      }
    }

    return {
      base, payment, buyer, delivery, fixedStart, cliffSeconds, durationSeconds,
      baseToken: base.token.address, quoteToken: payment.token.address, allocation: base.units, quote: payment.units,
      expiry: state.block.time + minutes * 60n,
    };
  }

  function availableAction(t) {
    const walletStep = walletAction(app, flow, refresh);
    if (walletStep.label || walletStep.hint) return walletStep;
    const account = wallet.account;
    const funds = state.funds;
    const allocation = money(t.allocation, t.base.token);
    if (!funds || funds.account !== account || funds.token !== t.baseToken) return { hint: "Checking your allocation balance and approval…" };
    if (funds.balance < t.allocation) return { hint: `This wallet holds ${money(funds.balance, t.base.token)}. Funding requires ${allocation}.` };
    if (funds.allowance < t.allocation) return {
      label: `Approve ${allocation}`, hint: "Approval lets OTC V2 take the specified allocation in a separate funding transaction.",
      run: () => flow.run("Confirm token approval in your wallet…",
        () => submitApproval(app, account, t.base.token, t.allocation, funds.allowance), refresh),
    };
    return {
      label: "Fund and create link", hint: "Funding moves the full allocation into escrow. You can reclaim it any time before settlement.",
      run: () => flow.run("Confirm funding in your wallet…", async () => {
        const latest = await chain.block();
        state.block = latest;
        if (fields.delivery.value === "external") throw new Error("Existing vesting positions are unsupported.");
        return sendV2(app, { data: createData(terms()), from: account, kind: "fund" });
      }, refresh),
    };
  }

  function render() {
    if (!live) return;
    if (state.created) {
      if (app.main.firstElementChild?.dataset.funded === state.created.id) return;
      const link = dealLink(config, state.created.id);
      const done = card(
        h("span", { class: "v2-kicker" }, "OTC V2"),
        h("h1", {}, `Deal #${state.created.id} is funded`),
        h("p", { class: "lead" }, "Share this link with the designated buyer. They can verify the funded terms before connecting their wallet."),
        h("div", { class: "linkbox" }, h("a", { href: link, testid: "deal-link" }, link)),
        h("div", { class: "row" }, copyButton(link), h("a", { class: "button primary", href: link }, "View funded deal")),
        h("div", { class: "v2-funding-receipt" }, h("h2", {}, "Funding receipt"), txHash(config, state.created.hash)),
        h("button", { type: "button", class: "v2-link-button", onclick: () => {
          state.created = null;
          save();
          app.main.replaceChildren(form);
          refresh();
        } }, "Return to the deal form"));
      done.classList.add("v2-card", "v2-complete");
      done.dataset.funded = state.created.id;
      app.main.replaceChildren(done);
      return;
    }

    const refused = fields.delivery.value === "external";
    const busy = Boolean(flow.job || flow.busy);
    inputs.disabled = busy;
    inputs.querySelector(".v2-fields").hidden = refused;
    unsupported.hidden = !refused;
    schedule.hidden = fields.delivery.value !== "vesting";
    fixedField.hidden = fields.startMode.value !== "fixed";
    for (const [input, line] of [[fields.baseToken, baseInfo], [fields.quoteToken, quoteInfo]]) {
      const entry = lookup(input);
      line.textContent = entry?.info ? `${entry.info.symbol || "ERC-20"} · ${entry.info.decimals} decimals`
        : entry?.loading ? "Reading token metadata…" : "";
    }

    let t, problem;
    if (!refused) {
      try { t = terms(); } catch (error) { problem = error.message; }
    }
    replaceChanged(termsBox, t ? h("div", {},
      h("div", { class: "v2-allocation" }, dot(t.base.token), h("strong", {}, money(t.allocation, t.base.token)),
        h("span", {}, t.delivery === NEW_VESTING ? "New vesting grant" : "Immediate delivery")),
      facts([["Designated buyer", addressText(t.buyer)], ...economics(t.quote, t.payment.token), ...scheduledTerms(t),
        ["Provisional expiry (UTC)", utc(t.expiry)], ["Treasury", addressText(state.treasury)]]))
      : h("p", { class: "hint" }, refused ? "Choose a supported delivery mode to continue." : "Enter the allocation, quote and buyer to review the exact payment and fees."));
    const next = t && !state.readError ? availableAction(t) : {};
    description.textContent = busy ? "" : problem || next.hint || "";
    wireButton(submit, state, flow.busy || (flow.job ? "Waiting for receipt…" : next.label || "Fund and create link"),
      !busy && !refused && next.run);
    replaceChanged(statusBox, transactionStatus(config, flow));
    replaceChanged(readError, state.readError ? h("div", { class: "notice error v2-error", role: "status" },
      h("p", {}, state.readError),
      h("button", { class: "v2-link-button", type: "button", onclick: () => {
        for (const [token, info] of cache) if (info.missing) cache.delete(token);
        refresh();
      } }, "Retry read")) : h("span", { hidden: true }));
  }

  async function refresh() {
    if (!live || state.created || flow.busy) return;
    const current = ++sequence;
    try {
      const block = await chain.block();
      await flow.check(block);
      if (!live || current !== sequence) return;
      const token = fields.baseToken.value.trim().toLowerCase();
      const account = wallet?.account;
      const treasury = state.treasury ?? await chain.beneficiaryTreasury(block.number);
      const [, , funds] = await Promise.all([
        loadToken(fields.baseToken), loadToken(fields.quoteToken),
        account && isAddress(token) && fields.delivery.value !== "external"
          ? Promise.all([chain.balanceOf(token, account, block.number), chain.allowance(token, account, block.number)])
            .then(([balance, allowance]) => ({ account, token, balance, allowance }), () => null)
          : null,
      ]);
      if (!live || current !== sequence) return;
      Object.assign(state, { block, treasury, funds, readError: null });
    } catch (error) {
      if (!live || current !== sequence) return;
      state.readError = explain(error);
    }
    render();
  }

  let debounce;
  inputs.addEventListener("input", () => {
    save();
    render();
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 120);
  });
  app.main.replaceChildren(form);
  document.title = `Create a private deal · ${networkName(config.chainId)} · otc.fam`;
  render();
  refresh();
  const poll = setInterval(refresh, 4500);
  return {
    update: refresh,
    stop() {
      live = false;
      clearInterval(poll);
      clearTimeout(debounce);
    },
  };
}
