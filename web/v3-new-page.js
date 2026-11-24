import { explain, say } from "./eth.js";
import { formatAmount, isAddress, openFor, parseAmount, parseUtc } from "./units.js";
import { h, notice } from "./ui.js";
import { brokerMoney, linkPayload, normalizeTerms, readPayload } from "./v3.js";
import { brokerView, compare, copyControls, domainLabel, exactTerms, feeFacts, panel, tokenWarning } from "./v3-view.js";
import { saveDraft } from "./v3-drafts.js";

const field = (label, id, input, help) => h("div", { class: "field" },
  h("label", { for: id }, label), input, help && h("p", { class: "note", id: `${id}-note` }, help));
const input = (id, attrs) => h("input", { id, testid: id, name: id, autocomplete: "off", ...attrs });
const nonce = () => BigInt(`0x${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`);

function utcInput(seconds) {
  const date = new Date(Number(seconds) * 1000);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 19) : "";
}

function pctBps(text) {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) throw say("Enter a broker fee-pool share between 0 and 100 with up to two decimal places.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

export function newBrokerPage(app, duplicate) {
  const { v3, chain } = app;
  let stopped = false;
  let version = 0;
  const alerts = h("div", { class: "broker-messages" });
  const result = h("div", { class: "broker-stack" });
  const report = (text) => alerts.replaceChildren(...(text ? [notice({ kind: "error", text })] : []));
  const seller = input("broker-seller", { placeholder: "0x…", class: "mono", required: true });
  const buyer = input("broker-buyer", { placeholder: "0x…", class: "mono", required: true });
  const broker = input("broker-recipient", { placeholder: "0x…", class: "mono", required: true, value: app.wallet?.account ?? "" });
  const baseToken = input("broker-base-token", { placeholder: "0x…", class: "mono", required: true });
  const quoteToken = input("broker-quote-token", { placeholder: "0x…", class: "mono", required: true });
  const allocation = input("broker-allocation", { placeholder: "1000", inputmode: "decimal", required: true });
  const quote = input("broker-quote", { placeholder: "123.456789", inputmode: "decimal", required: true });
  const share = input("broker-share", { value: "0", inputmode: "decimal", required: true });
  const hours = input("broker-expiry-hours", { value: "24", inputmode: "decimal", required: true });
  const delivery = h("select", { id: "broker-delivery", testid: "broker-delivery" },
    h("option", { value: "0" }, "Immediate delivery"), h("option", { value: "1" }, "New vesting grant"));
  const cliff = input("broker-cliff", { value: "2592000", inputmode: "numeric", "aria-describedby": "broker-cliff-note" });
  const duration = input("broker-duration", { value: "7776000", inputmode: "numeric", "aria-describedby": "broker-duration-note" });
  const start = input("broker-fixed-start", { type: "datetime-local", step: "1", "aria-describedby": "broker-fixed-start-note" });
  const vesting = h("div", { class: "broker-field-grid", hidden: true },
    field("Fixed start (UTC, optional)", "broker-fixed-start", start, "Leave blank to start at settlement."),
    field("Cliff (seconds)", "broker-cliff", cliff, "2,592,000 seconds is 30 days."),
    field("Duration (seconds)", "broker-duration", duration, "7,776,000 seconds is 90 days."));
  const submit = h("button", { type: "submit", class: "primary", testid: "broker-review" }, "Review exact terms");
  let draftNonce = nonce();

  function invalidate() {
    version++;
    vesting.hidden = delivery.value !== "1";
    result.replaceChildren();
    report(null);
  }

  async function preview(event) {
    event.preventDefault();
    report(null);
    const attempt = ++version;
    submit.disabled = true;
    try {
      const addresses = [seller, buyer, broker, baseToken, quoteToken].map((el) => el.value.trim());
      if (!addresses.every(isAddress)) throw say("Enter the full 0x address for each wallet and token.");
      if (addresses.slice(0, 3).some((address) => address.toLowerCase() === v3.contract)) throw say("A party cannot use the escrow contract as its wallet.");
      const [base, payment, now, treasury] = await Promise.all([
        chain.token(addresses[3]), chain.token(addresses[4]), chain.now(), v3.setup(),
      ]);
      const expires = openFor(hours.value.trim());
      if (expires.problem) throw say(expires.note);
      const schedule = delivery.value === "1";
      const fixedStart = schedule && start.value ? parseUtc(start.value) : 0;
      if (fixedStart && fixedStart <= now) throw say("Choose a fixed vesting start after the current block time.");
      const terms = normalizeTerms({
        seller: addresses[0], buyer: addresses[1], broker: addresses[2],
        baseToken: base.address, quoteToken: payment.address,
        allocation: parseAmount(allocation.value, base.decimals, base.symbol),
        quote: parseAmount(quote.value, payment.decimals, payment.symbol),
        expiry: now + Math.floor(expires.hours * 3600), nonce: draftNonce,
        delivery: delivery.value, fixedStart, cliffSeconds: schedule ? cliff.value.trim() : 0,
        durationSeconds: schedule ? duration.value.trim() : 0, brokerBps: pctBps(share.value),
      });
      const id = await v3.id(terms);
      if (stopped || attempt !== version) return;
      const payload = linkPayload(v3.domain, terms);
      const hash = `#/v3/d/${payload}`;
      const title = h("h2", { tabindex: "-1" }, "Review the proposal");
      const create = h("button", { class: "primary", type: "button", testid: "broker-create", onclick: () => {
        if (stopped || attempt !== version) return;
        const stored = saveDraft(v3.domain, { id, payload });
        create.disabled = true;
        create.textContent = "Private link created";
        linkBox.hidden = false;
        if (!stored) linkBox.prepend(notice({ kind: "warn", text: "This browser could not save the draft. Copy the link to keep it." }));
        linkBox.querySelector("button").focus();
        draftNonce = nonce();
      } }, "Create private link");
      const linkBox = h("div", { class: "broker-stack broker-share-result", hidden: true },
        h("p", { class: "hint", role: "status" }, "Share with the seller to fund, then with the designated buyer to settle."),
        copyControls(hash), h("a", { class: "button secondary", testid: "broker-deal-link", href: hash }, "Open deal preview"));
      result.replaceChildren(panel(title, compare(terms, base, payment),
        h("h3", {}, "Payment on settlement"), feeFacts(brokerMoney(terms.quote, terms.brokerBps), payment, terms, treasury),
        h("details", {}, h("summary", {}, "Exact terms for signing"), exactTerms(terms, v3.domain, id)),
        tokenWarning(), h("div", { class: "broker-stack broker-share-result" }, create, linkBox)));
      title.focus();
    } catch (error) {
      if (!stopped && attempt === version) report(explain(error));
    } finally {
      submit.disabled = false;
    }
  }

  document.title = "Prepare a broker deal · otc.fam";
  const form = h("form", { onsubmit: preview, oninput: invalidate },
    h("fieldset", {}, h("legend", {}, "Wallets"), h("div", { class: "broker-field-grid" },
      field("Seller address", "broker-seller", seller), field("Buyer address", "broker-buyer", buyer),
      field("Broker recipient address", "broker-recipient", broker),
      field("Broker share of fee pool (%)", "broker-share", share, "For example, 20 means 20% of the two 0.5% fees."))),
    h("fieldset", {}, h("legend", {}, "Trade"), h("div", { class: "broker-field-grid" },
      field("Base token address", "broker-base-token", baseToken), field("Allocation", "broker-allocation", allocation),
      field("Quote token address", "broker-quote-token", quoteToken), field("Quote amount", "broker-quote", quote))),
    h("fieldset", {}, h("legend", {}, "Delivery and timing"),
      h("div", { class: "broker-field-grid" }, field("Delivery", "broker-delivery", delivery),
        field("Expires after (hours)", "broker-expiry-hours", hours)), vesting),
    alerts, submit);
  app.main.replaceChildren(brokerView("new", h("div", { class: "broker-columns" },
    panel(h("span", { class: "eyeline" }, domainLabel(v3.domain)), h("h1", {}, duplicate ? "Duplicate broker deal" : "Prepare a private deal"),
      h("p", { class: "lead" }, "Agree terms and share one link. The seller funds the escrow, and the named buyer settles it."), form),
    h("aside", { class: "broker-stack", "aria-label": "Proposal review" }, result))));
  if (duplicate) {
    (async () => {
      const terms = readPayload(duplicate, v3.domain);
      const [base, payment] = await Promise.all([chain.token(terms.baseToken), chain.token(terms.quoteToken)]);
      if (stopped || version) return;
      seller.value = terms.seller;
      buyer.value = terms.buyer;
      broker.value = terms.broker;
      baseToken.value = terms.baseToken;
      quoteToken.value = terms.quoteToken;
      allocation.value = formatAmount(terms.allocation, base.decimals).replaceAll(",", "");
      quote.value = formatAmount(terms.quote, payment.decimals).replaceAll(",", "");
      share.value = `${terms.brokerBps / 100n}.${String(terms.brokerBps % 100n).padStart(2, "0")}`;
      delivery.value = String(terms.delivery);
      if (terms.delivery) {
        cliff.value = String(terms.cliffSeconds);
        duration.value = String(terms.durationSeconds);
        start.value = utcInput(terms.fixedStart);
        if (!terms.fixedStart) start.value = "";
      }
      invalidate();
    })().catch((error) => !stopped && report(explain(error)));
  }
  return { update() {}, stop() { stopped = true; } };
}
