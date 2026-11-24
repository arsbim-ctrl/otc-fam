import { explain, same, say } from "./eth.js";
import { formatAmount, parseAmount, parseUtc } from "./units.js";
import { card, fact, h, notice, show } from "./ui.js";
import { checkedAddress, dealIdOf, pack, payment, unpack, validateTerms } from "./v3.js";
import { actionButton, displayNetwork, emptyPage, feeFacts, heading, keepLink, mono, nav, percent, problem, tokenWarning } from "./v3-common.js";

const control = (name, label, attrs = {}, value = "") => h("div", { class: "field" },
  h("label", { for: `v3-form-${name}` }, label),
  h("input", { id: `v3-form-${name}`, testid: `broker-input-${name}`, name, value, autocomplete: "off", required: true, ...attrs }));

const getTimeText = (time) => time > 0n && time <= 253_402_300_799n
  ? new Date(Number(time) * 1000).toISOString().slice(0, 19) + "Z" : "";

const shareOf = (text) => {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text.trim())) throw say("Enter a broker share with up to two decimal places, such as 20 or 0.");
  const [whole, fraction = ""] = text.trim().split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
};

function deadlineIn(text) {
  const hours = Number(text);
  if (!/^\d+(?:\.\d{1,3})?$/.test(text.trim()) || hours < 0.017 || hours > 8760) {
    throw say("Set a deadline from 0.017 hours (about a minute) to 8,760 hours (one year).");
  }
  return BigInt(Math.round(hours * 3600));
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt("0x" + [...bytes].map(value => value.toString(16).padStart(2, "0")).join(""));
}

export function creationPage(app, duplicate) {
  const { main, v3, chain } = app;
  let source;
  try {
    if (duplicate) {
      const { domain, terms } = unpack(duplicate);
      if (domain.chainId !== v3.domain.chainId || !same(domain.verifyingContract, v3.contract)) {
        throw say("Open the deal’s original network and deployment to duplicate these terms.");
      }
      source = terms;
    }
  } catch (error) {
    main.replaceChildren(card(nav(), heading("Prepare a broker deal"), problem(explain(error))));
    return emptyPage;
  }

  document.title = "Prepare a broker deal · otc.fam";
  let running = true, making = false, previewRequest = 0;
  const termsNote = h("div", { testid: "broker-form-message" });
  const preview = h("div", { class: "broker-preview", testid: "broker-fee-preview", "aria-live": "polite" });
  const delivery = h("select", { id: "v3-form-delivery", name: "delivery", testid: "broker-input-delivery" },
    h("option", { value: "0" }, "Immediate delivery"), h("option", { value: "1" }, "New funded vesting grant"));
  delivery.value = source?.delivery.toString() ?? "0";
  const schedule = h("div", { class: "broker-schedule", hidden: delivery.value !== "1" },
    h("div", { class: "broker-fields" },
      control("cliff", "Cliff (seconds)", { inputmode: "numeric", maxlength: 20 }, source?.cliffSeconds.toString() ?? "2592000"),
      control("duration", "Duration (seconds)", { inputmode: "numeric", maxlength: 20 }, source?.durationSeconds.toString() ?? "7776000")),
    control("fixedStart", "Fixed start in UTC (optional)", { required: false, placeholder: "YYYY-MM-DD HH:MM:SS" }, getTimeText(source?.fixedStart ?? 0n)),
    h("p", { class: "note" }, "Leave the fixed start blank to start vesting at settlement."));
  const form = h("form", { class: "broker-form", oninput: (event) => {
    schedule.hidden = delivery.value !== "1";
    for (const input of schedule.querySelectorAll("input")) input.disabled = schedule.hidden;
    if (["quoteToken", "quote", "share"].includes(event.target.name)) void updatePreview();
  }, onsubmit: create },
  h("fieldset", {}, h("legend", {}, "Wallets"),
    control("broker", "Broker wallet", { class: "mono", maxlength: 42, spellcheck: "false" }, source?.broker ?? app.wallet?.account ?? ""),
    control("seller", "Seller wallet", { class: "mono", maxlength: 42, spellcheck: "false" }, source?.seller),
    control("buyer", "Buyer wallet", { class: "mono", maxlength: 42, spellcheck: "false" }, source?.buyer)),
  h("fieldset", {}, h("legend", {}, "Exchange"),
    control("baseToken", "Base token address", { class: "mono", maxlength: 42, spellcheck: "false" }, source?.baseToken),
    control("allocation", "Base allocation", { inputmode: "decimal", maxlength: 350 }),
    control("quoteToken", "Payment token address", { class: "mono", maxlength: 42, spellcheck: "false" }, source?.quoteToken),
    h("div", { class: "broker-fields" },
      control("quote", "Agreed quote", { inputmode: "decimal", maxlength: 350 }),
      control("share", "Broker share (%)", { inputmode: "decimal", maxlength: 6 }, source ? percent(source.brokerBps).slice(0, -1) : "0"))),
  h("fieldset", {}, h("legend", {}, "Delivery and deadline"),
    h("div", { class: "field" }, h("label", { for: "v3-form-delivery" }, "Delivery"), delivery),
    schedule,
    control("hours", "Valid for (hours after preparation)", { inputmode: "decimal", maxlength: 9 }, "24")),
  h("button", { type: "submit", class: "primary", testid: "broker-create" }, "Create shareable link"), termsNote);

  for (const input of schedule.querySelectorAll("input")) input.disabled = schedule.hidden;
  const submit = form.querySelector("button[type=submit]");
  const connect = actionButton("broker-fill-wallet", "Use connected wallet", async () => {
    try {
      if (!app.wallet.account) await app.wallet.connect();
      if (!app.wallet.account) throw say("Unlock your wallet or enter the broker address above.");
      form.elements.broker.value = app.wallet.account;
      form.elements.broker.focus();
    } catch (error) {
      show(termsNote, problem(explain(error)));
    }
  }, false, "secondary");
  if (app.wallet) form.elements.broker.closest(".field").append(connect);
  main.replaceChildren(h("div", { class: "broker-layout" }, nav(),
    card(heading("Prepare a broker deal"), h("p", { class: "lead" },
      "Set the terms both parties will sign. The seller funds the link, and the designated buyer settles it."),
    source && h("p", { class: "delivery" }, "Duplicating terms. This link will use a new nonce and deadline."), form),
    card(h("h2", {}, "Payment preview"), h("p", { class: "lead" },
      "Each side pays 0.50% of the agreed quote, rounded down in raw units. The broker’s share comes from those fees and is paid at settlement."),
    preview, h("dl", { class: "facts" },
      fact("Network", displayNetwork(v3.domain.chainId)),
      fact("V3 deal contract", mono(v3.contract))), tokenWarning())));

  void updatePreview();
  if (source) void prefillAmounts();

  function value(name) { return form.elements[name].value; }

  async function prefillAmounts() {
    try {
      const [base, quote] = await Promise.all([chain.token(source.baseToken), chain.token(source.quoteToken)]);
      if (!running) return;
      form.elements.allocation.value ||= formatAmount(source.allocation, base.decimals).replaceAll(",", "");
      form.elements.quote.value ||= formatAmount(source.quote, quote.decimals).replaceAll(",", "");
      void updatePreview();
    } catch (error) {
      if (running) show(termsNote, problem(explain(error)));
    }
  }

  async function updatePreview() {
    const request = ++previewRequest;
    let view;
    try {
      const quote = await chain.token(checkedAddress(value("quoteToken"), "Payment token"));
      const units = parseAmount(value("quote"), quote.decimals, quote.symbol);
      const brokerBps = shareOf(value("share"));
      if (brokerBps > 10_000n) throw say("Enter a broker share between 0% and 100%.");
      view = h("div", {}, h("p", { class: "delivery" }, `Broker share · ${percent(brokerBps)} of the fee pool`),
        feeFacts(payment({ quote: units, brokerBps }), quote));
    } catch {
      view = h("p", { class: "hint" }, "Enter a payment token, quote and broker percentage to see the exact split.");
    }
    if (running && request === previewRequest) show(preview, view);
  }

  async function create(event) {
    event.preventDefault();
    if (making) return;
    making = true;
    submit.disabled = true;
    show(termsNote, notice({ kind: "info", text: "Checking the terms against the network…" }));
    try {
      const seller = checkedAddress(value("seller"), "Seller"), buyer = checkedAddress(value("buyer"), "Buyer");
      const broker = checkedAddress(value("broker"), "Broker"), brokerBps = shareOf(value("share"));
      const baseToken = checkedAddress(value("baseToken"), "Base token"), quoteToken = checkedAddress(value("quoteToken"), "Payment token");
      const baseText = value("allocation"), quoteText = value("quote"), openFor = deadlineIn(value("hours"));
      const delivery = BigInt(value("delivery"));
      const seconds = (name) => {
        if (!/^\d+$/.test(value(name).trim())) throw say("Enter the cliff and duration as whole seconds.");
        return BigInt(value(name).trim());
      };
      const cliffSeconds = delivery === 1n ? seconds("cliff") : 0n;
      const durationSeconds = delivery === 1n ? seconds("duration") : 0n;
      const fixedStart = delivery === 1n && value("fixedStart").trim() ? BigInt(parseUtc(value("fixedStart"))) : 0n;
      const [base, quoteTokenInfo, block] = await Promise.all([chain.token(baseToken), chain.token(quoteToken), v3.block()]);
      const terms = {
        seller, buyer, baseToken, quoteToken, broker, brokerBps, delivery, fixedStart, cliffSeconds, durationSeconds,
        allocation: parseAmount(baseText, base.decimals, base.symbol), quote: parseAmount(quoteText, quoteTokenInfo.decimals, quoteTokenInfo.symbol),
        expiry: BigInt(block.time) + openFor, nonce: randomNonce(),
      };
      validateTerms(terms, v3.contract, BigInt(block.time));
      const id = dealIdOf(v3.domain, terms), encoded = pack(v3.domain, terms);
      await v3.readProposal({ id, terms }, block.number);
      if (!running) return;
      app.createdBrokerDeal = { id, saved: keepLink(v3.domain, id, encoded) };
      location.hash = `#/v3/d/${encoded}`;
    } catch (error) {
      if (running) show(termsNote, problem(error?.plain ? explain(error) : error.message));
    } finally {
      making = false;
      submit.disabled = false;
      if (running && document.activeElement === document.body) submit.focus();
    }
  }

  return { update() {}, stop() { running = false; } };
}
