import { amount, card, h, notice, show, TOKEN_WARNING, utc } from "./ui.js";
import { daysToSeconds, openFor, parseAmount, parseUtc } from "./units.js";
import { dealHash, normalize, unsigned, validateTerms } from "./broker-terms.js";
import { rememberDeal } from "./broker-store.js";
import { brokerButton, brokerNav, copyDeal, deliveryText, errorText, field, heading, moneyFacts, shareText } from "./broker-ui.js";

const newNonce = () => crypto.getRandomValues(new BigUint64Array(1))[0].toString();
const asDays = (seconds) => ({ value: seconds % 86_400n ? String(seconds) : String(seconds / 86_400n), seconds: seconds % 86_400n !== 0n });

export function brokerBuilder(app, api, source) {
  document.title = "Prepare broker deal · otc.fam";
  const defaults = {
    seller: source?.seller ?? "", buyer: source?.buyer ?? "", broker: source?.broker ?? app.wallet?.account ?? "",
    baseToken: source?.baseToken ?? "", quoteToken: source?.quoteToken ?? "", allocation: "", quote: "", brokerBps: String(source?.brokerBps ?? 2000),
    lifetime: "24", nonce: newNonce(), delivery: String(source?.delivery ?? 0), fixedStart: "", cliff: "30", duration: "90",
  };
  const form = h("form", { class: "card broker-form", novalidate: true });
  const summary = h("aside", { class: "broker-summary", "aria-label": "Terms preview" });
  const input = (name, { mode, max = 80, patternClass = "" } = {}) =>
    h("input", { id: `broker-${name}`, name, testid: name, value: defaults[name], maxlength: max, inputmode: mode, class: patternClass, autocomplete: "off", spellcheck: "false" });
  const byName = (name) => form.elements.namedItem(name);
  const value = (name) => byName(name).value.trim();
  const addressField = (label, name) => field(label, input(name, { max: 42, patternClass: "mono" }));
  const numberField = (label, name, mode = "decimal", hint) => field(label, input(name, { mode }), hint);
  const select = h("select", { name: "delivery", id: "broker-delivery", testid: "delivery" },
    h("option", { value: "0" }, "Immediate delivery"), h("option", { value: "1" }, "New vesting grant"));
  select.value = defaults.delivery;
  const schedule = h("div", { class: "broker-schedule" },
    field("Fixed start (UTC, optional)", input("fixedStart"), "Leave blank to start on settlement. Example 2026-12-01 12:00."),
    h("div", { class: "broker-fields" }, numberField("Cliff (days)", "cliff"), numberField("Duration (days)", "duration")));
  form.append(h("h2", {}, "Agreed terms"),
    h("div", { class: "broker-fields" }, addressField("Seller wallet", "seller"), addressField("Buyer wallet", "buyer")),
    h("div", { class: "broker-fields" }, addressField("Broker wallet", "broker"), numberField("Broker share (bps)", "brokerBps", "numeric", "2,000 bps is 20% of both fees.")),
    h("div", { class: "broker-fields" }, addressField("Allocation token", "baseToken"), numberField("Allocation", "allocation")),
    h("div", { class: "broker-fields" }, addressField("Quote token", "quoteToken"), numberField("Quote", "quote")),
    h("p", { class: "broker-warning" }, TOKEN_WARNING),
    h("div", { class: "broker-fields" }, numberField("Open for (hours)", "lifetime"), field("Delivery", select)),
    schedule, h("details", {}, h("summary", {}, "Seller nonce"), numberField("Nonce", "nonce", "numeric", "The seller can fund once with this nonce.")),
    h("button", { type: "submit", class: "primary", testid: "create-link" }, "Create deal link"));
  const view = h("div", { class: "broker-view" }, brokerNav(), heading(source ? "Duplicate broker terms" : "Prepare a broker deal",
    source ? "This copy has a new seller nonce. Review the terms and choose a new deadline before sharing." : "Agree the terms once. The named seller funds them, then the designated buyer settles."),
  h("div", { class: "broker-grid broker-builder" }, form, summary));
  app.main.replaceChildren(view);

  let live = true, sequence = 0, saved, problem, preview, updating = false, submitting = false, filled = false;
  const durationUnits = { cliff: false, duration: false };
  const draw = () => {
    if (!live) return;
    const current = saved;
    const terms = current?.terms ?? preview?.terms;
    const quote = current?.quote ?? preview?.quote;
    const allocation = current?.base ?? preview?.base;
    show(summary, card(h("h2", {}, saved ? "Deal link ready" : "Settlement preview"),
      terms && allocation && h("p", { class: "broker-big" }, amount(terms.allocation, allocation)),
      terms && h("p", { class: "hint" }, deliveryText(terms)),
      terms && quote ? moneyFacts(terms, quote) : h("p", { class: "hint" }, "Enter both token contracts and amounts to see the split in exact token units."),
      terms && h("p", { class: "hint" }, `Broker share · ${shareText(terms.brokerBps)}. Fees are paid only on successful settlement.`),
      saved && h("div", { class: "broker-link" }, h("p", { class: "hint" }, `Deadline · ${utc(saved.terms.expiry)}`),
        h("a", { class: "button primary", href: saved.hash, testid: "deal-link" }, "Open deal preview"),
        copyDeal(new URL(saved.hash, location.href).href, (ok) => {
          const stored = ok && rememberDeal(api.domain, current.terms, "shared");
          if (saved !== current) return;
          problem = { kind: ok ? "success" : "error", text: ok
            ? (stored ? "Link copied. The named seller can now open it and fund." : "Link copied. This browser could not save it in Deal history.")
            : "Clipboard unavailable. Open the deal preview and copy its address." };
          draw();
        })),
      problem && notice(problem)));
  };
  async function readTerms(strict) {
    const entered = Object.fromEntries([...new FormData(form)].map(([name, text]) => [name, text.trim()]));
    const get = (name) => entered[name];
    const type = get("delivery");
    const brokerBps = unsigned(get("brokerBps"), 16, "Broker share");
    if (brokerBps > 10_000n) throw new Error(`Broker share (${brokerBps} bps) must be between 0 and 10,000.`);
    for (const [label, name] of [["Allocation token", "baseToken"], ["Quote token", "quoteToken"]]) {
      if (!/^0x[0-9a-f]{40}$/i.test(get(name))) throw new Error(`${label} (${get(name) || "empty"}) needs a 0x address with 40 hex digits.`);
    }
    const [base, quote] = await Promise.all([app.chain.token(get("baseToken")), app.chain.token(get("quoteToken"))]);
    const parse = (name, token) => {
      try { return parseAmount(get(name), token.decimals, token.symbol); }
      catch (e) { throw new Error(`${name === "allocation" ? "Allocation" : "Quote"} (${get(name) || "empty"}). ${e.message}`); }
    };
    const termQuote = parse("quote", quote), allocation = parse("allocation", base);
    if (!strict) return { base, quote, terms: { allocation, quote: termQuote, brokerBps, delivery: BigInt(type),
      cliffSeconds: type === "1" ? time("cliff", get("cliff")) : 0n, durationSeconds: type === "1" ? time("duration", get("duration")) : 0n } };
    const { hours, note: deadlineNote } = openFor(get("lifetime"));
    if (!hours) throw new Error(`Open for (${get("lifetime") || "empty"}). ${deadlineNote}`);
    const now = (await api.block()).time;
    const fixed = type === "1" && get("fixedStart");
    const start = fixed ? parseUtc(fixed) : 0;
    if (fixed && start <= now) throw new Error(`Fixed start (${get("fixedStart")}) must be in the future on this chain.`);
    const terms = normalize([
      get("seller"), get("buyer"), base.address, quote.address, String(allocation), String(termQuote),
      String(now + Math.round(hours * 3600)), get("nonce"), type, String(start),
      type === "1" ? String(time("cliff", get("cliff"))) : "0", type === "1" ? String(time("duration", get("duration"))) : "0", get("broker"), String(brokerBps),
    ]);
    validateTerms(terms, api.contract);
    return { terms, quote, base };
  }
  function time(name, text) {
    return durationUnits[name] ? unsigned(text, 64, name) : daysToSeconds(text);
  }
  async function update() {
    const turn = ++sequence;
    schedule.hidden = value("delivery") !== "1";
    const validAddress = (name) => /^0x[0-9a-f]{40}$/i.test(value(name));
    const eligible = ["baseToken", "quoteToken"].every(validAddress) && value("allocation") && value("quote");
    let next, error;
    try { if (eligible) next = await readTerms(false); } catch (e) { error = { kind: "error", text: errorText(e) }; }
    if (turn !== sequence || !live) return;
    preview = next;
    if (!saved && !submitting) problem = error;
    draw();
  }
  form.addEventListener("input", () => {
    if (updating || submitting) return;
    if (saved) byName("nonce").value = newNonce();
    saved = problem = null;
    update();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || saved || updating) return;
    submitting = true;
    ++sequence;
    const submit = form.querySelector('[type="submit"]');
    submit.setAttribute("aria-busy", "true");
    submit.textContent = "Checking terms…";
    try {
      const result = await readTerms(true);
      if (!live) return;
      saved = { ...result, hash: dealHash(api.domain, result.terms) };
      const stored = rememberDeal(api.domain, saved.terms, "created");
      problem = { kind: stored ? "success" : "info", text: stored ? "Terms saved. Review the preview before sharing." : "The link is ready. This browser could not save it in Deal history." };
    } catch (e) {
      problem = { kind: "error", text: errorText(e) };
    } finally {
      submitting = false;
      submit.removeAttribute("aria-busy");
      submit.textContent = "Create deal link";
      draw();
      if (saved && document.activeElement === submit) summary.querySelector('[data-testid="deal-link"]')?.focus();
    }
  });

  if (source) {
    updating = true;
    if (source.delivery) {
      const cliff = asDays(source.cliffSeconds), duration = asDays(source.durationSeconds);
      for (const [name, period] of Object.entries({ cliff, duration })) {
        byName(name).value = period.value;
        durationUnits[name] = period.seconds;
        if (period.seconds) byName(name).previousElementSibling.textContent = name === "cliff" ? "Cliff (seconds)" : "Duration (seconds)";
      }
      if (source.fixedStart && Number(source.fixedStart) <= 253_402_300_799) {
        byName("fixedStart").value = new Date(Number(source.fixedStart) * 1000).toISOString().slice(0, 19) + "Z";
      }
    }
    Promise.all([app.chain.token(source.baseToken), app.chain.token(source.quoteToken)]).then(([base, quote]) => {
      byName("allocation").value = amount(source.allocation, base).split(" ")[0].replaceAll(",", "");
      byName("quote").value = amount(source.quote, quote).split(" ")[0].replaceAll(",", "");
      update();
    }).catch((e) => { problem = { kind: "error", text: errorText(e) }; draw(); }).finally(() => { updating = false; });
  }
  update();
  return {
    update() {
      if (!filled && !value("broker") && app.wallet?.account) {
        byName("broker").value = app.wallet.account;
        filled = true;
      }
    },
    stop() { live = false; },
  };
}
