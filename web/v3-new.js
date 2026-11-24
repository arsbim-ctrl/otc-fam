import { explain, same, say } from "./eth.js";
import { h } from "./ui.js";
import { daysToSeconds, formatAmount, openFor, parseAmount, parseUtc } from "./units.js";
import { dealId, directory, feesFor, percent, proposalPath, termsFrom } from "./v3-protocol.js";
import { button, canonicalTerms, feeDetails, header, legs, message, panel, share, shell, tokenAmount, tokenWarning } from "./v3-view.js";

const input = (name, label, props = {}) => h("div", { class: "broker-field" },
  h("label", { for: `broker-${name}` }, label),
  h("input", { id: `broker-${name}`, testid: `v3-${name}`, name, autocomplete: "off", ...props }));
const plainAddress = { class: "mono", placeholder: "0x…", spellcheck: "false", required: true, maxlength: 42 };
const decimal = { inputmode: "decimal", required: true, maxlength: 100 };
const date = (time) => new Date(Number(time) * 1000).toISOString().slice(0, 19).replace("T", " ");

function decimalShare(text) {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw say("Enter a broker percentage with up to two decimal places.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function randomNonce() {
  return BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""));
}

export function newBrokerPage(app, protocol, copied) {
  const domain = protocol.domain;
  const book = directory(domain);
  let stopped = false, submitting = false, quoteCheck = 0, feeTimer, brokerEdited = Boolean(copied);

  const feedback = h("div", { class: "broker-feedback" });
  const quotePreview = h("p", { class: "broker-callout", "aria-live": "polite", testid: "v3-fee-preview" }, "Enter the payment token, quote and broker share to calculate the fee split.");
  const preview = h("div", { class: "broker-preview" });
  const delivery = h("select", { name: "delivery", id: "broker-delivery", testid: "v3-delivery" },
    h("option", { value: "0" }, "Immediate transfer"), h("option", { value: "1" }, "New funded vesting grant"));
  const schedule = h("div", { class: "broker-grid", hidden: true },
    input("cliff", "Cliff in days", { ...decimal, value: "30" }),
    input("duration", "Duration in days", { ...decimal, value: "90" }),
    input("start", "Fixed start in UTC (optional)", { placeholder: "2026-12-03 15:00", maxlength: 27 }),
    h("p", { class: "broker-muted" }, "Leave the fixed start blank to start vesting when the buyer settles. Schedule offsets also accept seconds with an s suffix."));
  const form = h("form", { class: "broker-form", onsubmit: submit, oninput: changed },
    h("div", { class: "broker-grid" },
      input("seller", "Seller wallet", plainAddress), input("buyer", "Designated buyer wallet", plainAddress),
      input("broker", "Broker recipient wallet", plainAddress), input("share", "Broker share of fee pool (%)", { ...decimal, value: "20.00", maxlength: 6 }),
      input("base-token", "Token the seller deposits", plainAddress), input("allocation", "Allocation in whole tokens", decimal),
      input("quote-token", "Payment token", plainAddress), input("quote", "Quote in whole tokens", decimal),
      input("hours", "Funding and settlement window (hours)", { ...decimal, value: "24", maxlength: 12 }),
      h("div", { class: "broker-field" }, h("label", { for: "broker-delivery" }, "Delivery"), delivery)),
    schedule, tokenWarning(), quotePreview,
    h("button", { class: "primary", type: "submit", testid: "v3-review" }, "Review proposal"), feedback);
  const walletBox = h("p", { class: "broker-muted" });
  app.main.replaceChildren(shell("new",
    header("Prepare a broker deal", "Agree the terms, then share one link with the seller and buyer. Only their wallets can authorize funding and settlement."),
    h("div", { class: "broker-columns" },
      panel(form),
      h("div", { class: "broker-stack" }, panel(h("h2", {}, "Share privately"),
        h("p", { class: "broker-muted" }, "Anyone with the link can read its terms. Verify the details with your counterparties. Once funded, the terms and transaction history are public onchain."),
        walletBox,
        button("Use connected broker wallet", connect, { id: "v3-broker-connect", secondary: true, disabled: !app.wallet })), preview))));
  document.title = "Prepare a broker deal · otc.fam";
  const field = (name) => form.elements.namedItem(name);
  const value = (name) => field(name).value.trim();
  if (copied) {
    for (const [key, name] of [["seller","seller"], ["buyer","buyer"], ["broker","broker"], ["base-token","baseToken"], ["quote-token","quoteToken"]]) field(key).value = copied.terms[name];
    field("allocation").value = formatAmount(copied.terms.allocation, copied.base.decimals).replaceAll(",", "");
    field("quote").value = formatAmount(copied.terms.quote, copied.quote.decimals).replaceAll(",", "");
    field("share").value = percent(copied.terms.brokerBps).slice(0, -1);
    delivery.value = String(copied.terms.delivery);
    // Preserve exact schedule offsets. A past fixed start must be edited before review.
    if (copied.terms.delivery) {
      field("cliff").value = String(copied.terms.cliffSeconds / 86_400n);
      field("duration").value = String(copied.terms.durationSeconds / 86_400n);
      for (const [name, seconds] of [["cliff", copied.terms.cliffSeconds], ["duration", copied.terms.durationSeconds]]) {
        if (seconds % 86_400n) field(name).value = `${seconds}s`;
      }
      if (copied.terms.fixedStart && copied.terms.fixedStart < 253_402_300_799n) field("start").value = date(copied.terms.fixedStart);
    }
    changed();
  }
  update();

  function update() {
    const account = app.wallet?.account;
    if (account && !brokerEdited && !field("broker").value) field("broker").value = account;
    walletBox.textContent = account
      ? `Connected wallet ${account}. You can also enter the broker recipient manually.`
      : "A wallet is optional for preparing a proposal. Connect to use its address as the broker recipient.";
  }

  async function connect(target) {
    target.disabled = true;
    try {
      await app.wallet.connect();
      if (stopped) return;
      if (app.wallet.account) {
        field("broker").value = app.wallet.account;
        brokerEdited = true;
        changed();
      }
      update();
    } catch (error) {
      if (!stopped) feedback.replaceChildren(message(explain(error), true));
    } finally {
      target.disabled = false;
      if (!stopped) target.focus({ preventScroll: true });
    }
  }

  function changed(event) {
    if (event?.target === field("broker")) brokerEdited = true;
    schedule.hidden = delivery.value === "0";
    field("cliff").required = !schedule.hidden;
    field("duration").required = !schedule.hidden;
    preview.replaceChildren();
    feedback.replaceChildren();
    const check = ++quoteCheck;
    clearTimeout(feeTimer);
    feeTimer = setTimeout(() => showFee(check), 140);
  }

  async function showFee(check) {
    let text = "Enter the payment token, quote and broker share to calculate the fee split.";
    try {
      if (value("quote-token") && value("quote")) {
        await protocol.checkNetwork();
        const token = await app.chain.token(value("quote-token"));
        const quote = parseAmount(value("quote"), token.decimals);
        const brokerBps = decimalShare(value("share"));
        if (brokerBps > 10_000n) throw say("Enter a broker share between 0% and 100%.");
        const fees = feesFor({ quote, brokerBps });
        text = `Broker receives ${tokenAmount(fees.brokerFee, token)} (${percent(brokerBps)} of ${tokenAmount(fees.feePool, token)}) on settlement. Treasury receives ${tokenAmount(fees.treasuryFee, token)}.`;
      }
    } catch (e) {
      text = e.plain ? e.message : "Check the payment token, quote precision and broker percentage.";
    }
    if (!stopped && check === quoteCheck) quotePreview.textContent = text;
  }

  const scheduleUnits = (text) => /^\d{1,20}s$/.test(text) ? BigInt(text.slice(0, -1)) : daysToSeconds(text);

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    const revision = quoteCheck;
    const submitter = event.submitter ?? form.querySelector("button");
    submitter.disabled = true;
    feedback.replaceChildren();
    try {
      const entries = Object.fromEntries([...new FormData(form)].map(([key, val]) => [key, val.trim()]));
      if (!/^0x[0-9a-fA-F]{40}$/.test(entries["base-token"]) || !/^0x[0-9a-fA-F]{40}$/.test(entries["quote-token"])) throw say("Enter both token contract addresses in full.");
      await protocol.checkNetwork();
      const [[treasury], base, quote, time] = await Promise.all([
        protocol.read("treasury", []), app.chain.token(entries["base-token"]), app.chain.token(entries["quote-token"]), app.chain.now(),
      ]);
      if (stopped || revision !== quoteCheck) return;
      const window = openFor(entries.hours);
      if (window.problem) throw say(window.note);
      const vesting = entries.delivery === "1";
      const fixedStart = vesting && entries.start ? parseUtc(entries.start) : 0;
      if (fixedStart && fixedStart <= time) throw say("Choose a fixed start later than the latest block time.");
      const terms = termsFrom({
        seller: entries.seller, buyer: entries.buyer, broker: entries.broker,
        baseToken: entries["base-token"], quoteToken: entries["quote-token"],
        allocation: parseAmount(entries.allocation, base.decimals), quote: parseAmount(entries.quote, quote.decimals),
        brokerBps: decimalShare(entries.share), expiry: time + Math.round(window.hours * 3600), nonce: randomNonce(),
        delivery: entries.delivery, fixedStart, cliffSeconds: vesting ? scheduleUnits(entries.cliff) : 0,
        durationSeconds: vesting ? scheduleUnits(entries.duration) : 0,
      });
      if (same(terms.broker, protocol.contract)) throw say("Enter a broker wallet that can receive the fee.");
      const id = dealId(domain, terms);
      const [verified] = await protocol.read("hashTerms", [terms]);
      if (verified !== id) throw say("The configured contract disagrees on the signing domain.");
      if (stopped || revision !== quoteCheck) return;
      const publish = button("Create private deal link", () => {
        const path = proposalPath(domain, terms);
        const saved = book.save(terms.broker, id, path, true);
        preview.replaceChildren(panel(h("h2", { tabindex: "-1" }, "Deal link created"),
          h("p", { class: "broker-callout" }, "Awaiting funding · Share this link with both parties. The named seller must deposit the full allocation."),
          !saved && message("This browser could not save the proposal. Keep a copy of the link."),
          share(path), h("a", { class: "button primary", href: path, testid: "v3-open-link" }, "Open deal preview")));
        preview.querySelector("h2").focus();
      }, { id: "v3-create" });
      preview.replaceChildren(panel(h("h2", { tabindex: "-1" }, "Review exact terms"), legs(terms, base, quote),
        feeDetails(terms, quote), h("details", { class: "broker-details" }, h("summary", {}, "Counterparties and signing terms"),
          canonicalTerms({ domain, id, terms, treasury, base, quote })), publish));
      preview.querySelector("h2").focus();
    } catch (error) {
      if (!stopped && revision === quoteCheck) {
        const text = error.code === "INVALID_ARGUMENT" ? "Enter valid wallet or token addresses. Check their capitalization and length."
          : error.message || explain(error);
        feedback.replaceChildren(message(text, true));
        submitter.disabled = false;
        submitter.focus({ preventScroll: true });
      }
    } finally {
      submitting = false;
      submitter.disabled = false;
    }
  }

  return { update, stop() { stopped = true; clearTimeout(feeTimer); } };
}
