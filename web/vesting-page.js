import { fundingHistory, fundingReceipt, rememberFunding } from "./funding-receipt.js";
import { broadcast, cancelData, explain, fillData, same, transact } from "./eth.js";
import { action, amount, card, copyButton, fact, h, leg, networkName, NO_WALLET, when } from "./ui.js";
import { claimData, createData, feeFor, readTerms, spendingStep } from "./vesting.js";

const linkTo = (type, id) => location.href.split("#")[0] + "#/v2/" + type + "/" + id;
const link = (text, href, testid) => h("a", { class: "button secondary", href, testid }, text);
const addr = value => h("span", { class: "mono" }, value);
const facts = (...rows) => h("dl", { class: "facts" }, ...rows);
const status = text => h("span", { class: "status", testid: "deal-status", "data-status": text.toLowerCase() }, text);
const title = (name, state) => h("div", { class: "card-head" }, h("h1", {}, name), status(state));

function duration(seconds) {
  if (seconds === 0n) return "0 seconds";
  return seconds % 86400n === 0n ? seconds / 86400n + " days" : seconds + " seconds";
}

function summary(t, now, treasury) {
  const fee = feeFor(t.quote);
  const pay = value => amount(value, t.payment);
  const start = t.fixedStart ? when(Number(t.fixedStart), now) : "At settlement";
  return [
    leg("Buyer pays, including fee", t.quote + fee, t.payment, "pay"),
    h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
    leg(t.delivery ? "Buyer receives in a new vesting grant" : "Buyer receives at settlement", t.allocation, t.base, "receive"),
    facts(fact("Agreed quote", pay(t.quote)), fact("Buyer fee · 0.5%", pay(fee)), fact("Seller fee · 0.5%", pay(fee)),
      fact("Seller receives", pay(t.quote - fee)), fact("Treasury receives", pay(2n * fee), " · ", addr(treasury)),
      fact("Fee rounding", "Each side pays 0.5% rounded down to a whole payment-token base unit."),
      fact("Buyer / beneficiary", addr(t.buyer)), t.seller && fact("Seller", addr(t.seller)),
      fact("Offer expires", when(Number(t.expiry), now)),
      Boolean(t.delivery) && fact("Vesting starts", start),
      Boolean(t.delivery) && fact("Cliff and duration", duration(t.cliffSeconds) + " until the first claim · " + duration(t.durationSeconds) + " to full vesting"),
      Boolean(t.delivery) && fact("Unlocks", "Linear from the start. At the cliff the accrued amount becomes claimable.")),
  ];
}

function sellerForm() {
  const fields = {};
  function field(key, label, props = {}) {
    const id = "v2-" + key;
    fields[key] = h("input", { id, testid: key, autocomplete: "off", ...props });
    return h("div", { class: "field" }, h("label", { for: id }, label), fields[key]);
  }
  function select(key, label, choices) {
    fields[key] = h("select", { id: "v2-" + key, testid: key }, choices.map(([v,t]) => h("option", { value: v }, t)));
    return h("div", { class: "field" }, h("label", { for: fields[key].id }, label), fields[key]);
  }
  const delivery = select("delivery", "Delivery", [["immediate","Immediate transfer"],["vesting","New vesting grant"],["position","Existing locked position"]]);
  const start = select("startMode", "Vesting starts", [["settlement","At settlement"],["fixed","At a fixed time"]]);
  const date = field("startDate", "Fixed start · local time", { type: "datetime-local" });
  const unit = select("scheduleUnit", "Schedule units", [["days", "Days"], ["seconds", "Seconds"]]);
  const schedule = h("div", {}, start, date, unit, field("cliff","Cliff length", { value: "30", inputmode: "numeric" }),
    field("duration","Total duration including cliff", { value: "90", inputmode: "numeric" }));
  const warning = h("p", { class: "notice warn" }, "Existing grants, NFTs and locked positions cannot be transferred here. Fund a new deal with liquid ERC-20 tokens.");
  const controls = h("div", {});
  const element = card(h("h1", {}, "Create a funded deal"), h("p", { class: "lead" }, "Fund an allocation for one buyer. Review the payment and fees before approving tokens."),
    field("baseToken","Allocation token address"), field("allocation","Tokens to fund", { inputmode: "decimal" }),
    field("quoteToken","Payment token address"), field("quote","Quote before fees", { inputmode: "decimal" }),
    field("buyer","Buyer wallet address"), field("hours","Offer expires in hours", { value: "24", inputmode: "decimal" }),
    delivery, warning, schedule, controls);
  function sync() {
    schedule.hidden = fields.delivery.value !== "vesting";
    date.hidden = fields.startMode.value !== "fixed";
    warning.hidden = fields.delivery.value !== "position";
  }
  fields.delivery.addEventListener("change", sync);
  fields.startMode.addEventListener("change", sync);
  sync();
  return { element, controls, fields, values: () => Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim()])) };
}

export function vestingPage(app, kind, rawId) {
  const { main, wallet, config, chain } = app;
  const form = kind === "new" && sellerForm();
  const id = /^[1-9]\d{0,77}$/.test(rawId) && BigInt(rawId) < (1n << 256n) ? BigInt(rawId) : null;
  let review, seller, submitted, treasury, message, busy, active = true, generation = 0;
  const net = networkName(config.chainId);
  document.title = (form ? "Create a funded deal" : kind === "g" ? "Vesting grant" : "Funded deal") + " · otc.fam";
  const button = (label, run, hint) => action({ button: { label, run }, hint, notice: message && { kind: "error", text: message } });
  const change = (label, run, hint) => button(label, () => execute(label, run), hint);
  function walletAction() {
    if (!wallet) return button("Wallet required", null, NO_WALLET);
    if (!wallet.account) return change("Connect wallet", () => wallet.connect());
    if (wallet.chainId !== config.chainId) return change("Switch to " + net, () => wallet.switchTo(config.chainId), "Switch networks before sending a transaction.");
    return null;
  }

  async function execute(label, work) {
    if (busy || !active) return;
    ++generation;
    message = null;
    const panel = main.querySelector(".action");
    if (form) Object.values(form.fields).forEach(field => { field.disabled = true; });
    const stage = text => {
      busy = text;
      if (panel && active) panel.replaceChildren(h("p", { class: "hint", role: "status" }, text));
    };
    stage(label);
    try { await work(stage); }
    catch (error) { message = explain(error); }
    finally {
      busy = null;
      if (form) Object.values(form.fields).forEach(field => { field.disabled = false; });
      await refresh();
    }
  }

  async function spend(token, required, account, label, send) {
    const step = await spendingStep(app, token, required, account);
    const total = amount(required, token);
    if (step.kind === "unlimited") return button("Amount requires unlimited approval", null, "Choose a smaller amount to keep the allowance bounded.");
    if (step.kind === "short") return button("Insufficient " + token.symbol, null, "You need " + total + " and hold " + amount(step.balance, token) + ".");
    if (step.kind === "ready") return change(label, send);
    const resetting = step.kind === "reset";
    return change(resetting ? "Reset existing allowance to zero" : "Approve " + total, step.run,
      (resetting ? "Your current allowance is " + amount(step.allowance, token) + ". Reset it before approving " + total + "." :
        "Only this amount can be spent.") + " Spender: " + config.contract);
  }

  function historyLinks() {
    return fundingHistory(config, wallet?.account).map(hash => link("Funding transaction " + hash, linkTo("tx", hash)));
  }

  async function sellerView(now) {
    if (!review || !same(seller, wallet?.account)) {
      review = null;
      const controls = form.fields.delivery.value === "position" ? button("Choose a supported delivery", null) : walletAction() || change("Review terms and fees", async () => {
        seller = wallet.account;
        review = await readTerms(form.values(), chain, seller);
      });
      form.controls.replaceChildren(controls, ...historyLinks());
      return form.element;
    }
    const t = review;
    const expired = t.expiry <= now || (t.fixedStart !== 0n && t.fixedStart <= now);
    const controls = walletAction() || (expired ? button("Review dates again", null, "A reviewed date has passed. Edit terms to update it.") :
      await spend(t.base, t.allocation, seller, "Fund deal with " + amount(t.allocation, t.base), async stage => {
        submitted = await broadcast(app, config.contract, createData(t), stage, "Funding the allocation", seller);
        rememberFunding(config, seller, submitted);
        if (active) {
          main.replaceChildren(recoveryCard(submitted, "Pending"));
          location.hash = "#/v2/tx/" + submitted;
        }
      }));
    return card(h("h1", {}, "Review funded offer"), h("p", { class: "lead" }, "Funding moves the full allocation into escrow. You can cancel until the buyer settles."),
      ...summary({ ...t, seller }, now, treasury), controls, h("button", { class: "secondary", type: "button", onclick: () => {
        if (!busy) { review = null; message = null; refresh(); }
      } }, "Edit terms"));
  }

  async function receiptView(hash) {
    let receipt, error;
    try {
      if (!treasury) treasury = await chain.deployment(config.chainId);
      receipt = await fundingReceipt(chain, hash);
    } catch (e) { error = explain(e); }
    if (receipt?.state === "Funded") {
      const dealUrl = linkTo("d", receipt.id);
      return card(title("Deal #" + receipt.id, "Funded"), h("p", { class: "lead" }, "Funding confirmed. Send the deal link to the named buyer."),
        h("div", { class: "linkbox" }, h("a", { href: dealUrl, testid: "deal-link" }, dealUrl)), copyButton(dealUrl));
    }
    return recoveryCard(hash, receipt?.state ?? "Checking", error);
  }

  function recoveryCard(hash, state, error) {
    const url = linkTo("tx", hash);
    return card(title("Funding transaction", state),
      h("p", { class: "lead" }, error || (state === "Failed" ? "Funding reverted. You can create another offer." :
        "Waiting for confirmation. Save this link to recover the deal number.")),
      h("div", { class: "linkbox" }, h("a", { href: url, testid: "recovery-link" }, url)),
      copyButton(url), state === "Failed" && link("Create a deal", "#/v2/new"));
  }

  async function dealView(block, now) {
    const d = await chain.deal(id, block);
    if (d.status === "Missing") return missing();
    [d.base, d.payment] = await Promise.all([chain.token(d.baseToken), chain.token(d.quoteToken)]);
    const state = d.status === "Funded" && d.expiry <= now ? "Expired" : d.status;
    const notes = {
      Funded: "The seller has funded the allocation. Only the named buyer can settle this offer.",
      Expired: "The offer expired. The seller can cancel to recover the allocation.",
      Cancelled: "The seller recovered the allocation.",
      Settled: d.delivery ? "Payment settled. The full allocation backs the buyer’s grant." : "Payment settled and the allocation was delivered to the buyer.",
    };
    let controls;
    const account = wallet?.account;
    if (d.status === "Funded") {
      controls = walletAction();
      if (!controls && same(account, d.seller)) controls = change("Cancel and recover " + amount(d.allocation, d.base),
        stage => transact(app, config.contract, cancelData(id), stage, "Cancelling and returning the allocation", account));
      if (!controls && state === "Funded") controls = same(account, d.buyer)
        ? await spend(d.payment, d.quote + feeFor(d.quote), account, "Settle · pay " + amount(d.quote + feeFor(d.quote), d.payment),
          stage => transact(app, config.contract, fillData(id), stage, "Settling deal #" + id, account))
        : button("Reserved for another wallet", null, "Connect the named buyer " + d.buyer + " to settle.");
    }
    return card(title("Deal #" + id, state), h("p", { class: "lead" }, notes[state]),
      d.grantId > 0n && link("Open vesting grant #" + d.grantId, linkTo("g", d.grantId), "grant-link"),
      ...summary(d, now, treasury), controls, copyButton(location.href));
  }

  async function grantView(block, now) {
    const g = await chain.grant(id, block);
    if (!g.dealId) return missing();
    const token = await chain.token(g.token), value = n => amount(n, token);
    const vested = g.claimable + g.claimed;
    const state = g.claimed === g.allocation ? "Claimed" : now < g.start ? "Scheduled" : now < g.cliff ? "Before cliff" : now >= g.end ? "Fully vested" : "Vesting";
    const account = wallet?.account;
    let controls;
    if (g.claimed < g.allocation) controls = walletAction() || (!same(account, g.beneficiary)
      ? button("Beneficiary wallet required", null, "Connect " + g.beneficiary + " to claim.")
      : g.claimable === 0n ? button("Nothing to claim yet", null, "Claimable updates with new blocks.")
      : change("Claim " + value(g.claimable), stage => transact(app, config.contract, claimData(id), stage, "Claiming vested tokens for the beneficiary", account)));
    return card(title("Grant #" + id, state), h("p", { class: "lead" }, "Claims go directly to the beneficiary. Reopen this link to collect later unlocks."),
      leg("Claimable now", g.claimable, token, "claimable"),
      facts(fact("Allocation", value(g.allocation)), fact("Vested", value(vested)), fact("Claimed", value(g.claimed)),
        fact("Unvested", value(g.allocation - vested)), fact("Remaining in custody for this grant", value(g.allocation - g.claimed)),
        fact("Beneficiary", addr(g.beneficiary)), fact("Custodian", addr(g.custodian)),
        fact("Start", when(Number(g.start), now)), fact("Cliff", when(Number(g.cliff), now)), fact("End", when(Number(g.end), now))),
      controls, copyButton(location.href), link("View deal #" + g.dealId, linkTo("d", g.dealId)));
  }

  function missing() {
    return card(title(kind === "g" ? "Grant" : "Deal", "Missing"), h("p", { class: "lead" }, "No record at this link on " + net + ". Check the number with the sender."));
  }
  async function refresh() {
    if (!active || busy) return;
    const version = ++generation;
    let element;
    try {
      if (kind === "tx" || submitted) {
        element = await receiptView(submitted || rawId);
      } else {
        if (!treasury) treasury = await chain.deployment(config.chainId);
        const block = await chain.rpc("eth_getBlockByNumber", ["latest", false]);
        const now = Number(block.timestamp);
        element = form ? await sellerView(now) : !id ? missing() : kind === "g" ? await grantView(block.number, now) : await dealView(block.number, now);
      }
    } catch (error) {
      element = card(h("h1", {}, "Could not read this page"), h("p", { class: "notice error" }, explain(error)),
        h("button", { class: "secondary", onclick: refresh }, "Try again"), ...(form ? historyLinks() : []));
    }
    if (active && version === generation && main.firstElementChild !== element) main.replaceChildren(element);
  }
  main.replaceChildren(kind === "tx" ? recoveryCard(rawId, "Pending") :
    card(h("p", { class: "loading" }, "Reading the funded deal contract…")));
  if (form) form.fields.delivery.addEventListener("change", refresh);
  refresh();
  const timer = setInterval(() => { if (!form || review) refresh(); }, 5000);
  return { update() {
    // Remove actions immediately when the signer or network changes.
    if (!busy && active) main.querySelectorAll(".action button").forEach(b => { b.disabled = true; });
    refresh();
  }, stop() { active = false; clearInterval(timer); } };
}
