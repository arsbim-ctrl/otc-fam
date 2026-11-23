import { explainV2 as explain } from "./eth-v2.js";
import { approveExactly, same, transact, ZERO_ADDRESS } from "./eth.js";
import { createV2Data, fundedId } from "./eth-v2.js";
import { action, amount, card, copyButton, h, NO_WALLET } from "./ui.js";
import { isAddress, parseAmount } from "./units.js";
import { expirySeconds, fees, schedule } from "./vesting.js";
import { economics, receiptView, tokenWarning, utc, updateArea } from "./v2-ui.js";

const SECONDS_PER_DAY = 86_400n;

export function newDealPageV2(app) {
  const { chain, wallet, config } = app;
  let live = true, busy = false, notice, terms, sell, buy, funds, created, read = 0;
  const field = {};
  const input = (id, label, value = "", placeholder = "", extra = {}) => {
    const node = h("input", { id, testid: id, value, placeholder, autocomplete: "off", ...extra, oninput: update });
    field[id] = node;
    return h("div", { class: "field" }, h("label", { for: id }, label), node);
  };
  const delivery = h("select", { id: "delivery", testid: "delivery", onchange: update },
    h("option", { value: "0" }, "Immediate · tokens at settlement"), h("option", { value: "1" }, "New vesting · fully funded grant"),
    h("option", { value: "external" }, "Existing position · unsupported"));
  const summary = h("div", { class: "summary", testid: "preview" }), actions = h("div"), scheduleArea = h("div");
  const form = card(h("h1", {}, "Make a deal · v2"), h("p", { class: "lead" }, "Fund one allocation, commit the buyer and send one private link."),
    h("div", { class: "field" }, h("label", { for: "delivery" }, "Delivery"), delivery),
    input("existing-position", "Existing position, screenshot or URL (unsupported)", "", "Leave empty for a new allocation"),
    h("div", { class: "leg" }, input("sell-token", "Allocation token address"), input("sell-amount", "Allocation you fund", "", "0", { inputmode: "decimal" })),
    h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
    h("div", { class: "leg" }, input("buy-token", "Payment token address"), input("buy-amount", "Payment before fees", "", "0", { inputmode: "decimal" })),
    input("taker", "Designated buyer address"), input("expiry-hours", "Expires in hours (minimum 1 minute)", "24"),
    scheduleArea, summary, tokenWarning(), actions);
  const schedulePreview = h("p", { class: "note", testid: "schedule-preview" });
  scheduleArea.append(input("fixed-start", "Fixed start UTC (empty: settlement block)", "", "2026-12-01T12:00:00Z"),
    input("cliff-seconds", "Cliff in days", "30", "", { inputmode: "numeric" }),
    input("duration-seconds", "Duration in days", "90", "", { inputmode: "numeric" }), schedulePreview);
  form.classList.add("v2-card");
  app.main.replaceChildren(form);
  const text = key => field[key].value.trim();

  async function update() {
    if (!live || busy || created) return;
    const seq = ++read;
    scheduleArea.hidden = delivery.value !== "1";
    terms = null;
    schedulePreview.textContent = "";
    renderActions();
    let problem;
    try {
      if (delivery.value === "external" || text("existing-position")) throw new Error("Existing external vesting positions, revocable rights, screenshots and URLs are unsupported. Use a new token allocation. No wallet approval was requested.");
      const mode = Number(delivery.value);
      let fixedStart = 0n, cliffSeconds = 0n, durationSeconds = 0n;
      if (mode) {
        if (text("fixed-start")) {
          if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(text("fixed-start")) || (!Number.isFinite(Date.parse(text("fixed-start"))) || new Date(Date.parse(text("fixed-start"))).toISOString().replace(".000Z", "Z") !== text("fixed-start"))) throw new Error(`Fixed start “${text("fixed-start")}”: use UTC YYYY-MM-DDTHH:mm:ssZ.`);
          fixedStart = BigInt(Date.parse(text("fixed-start")) / 1000);
        }
        if (!["cliff-seconds", "duration-seconds"].every(k => /^\d+$/.test(text(k)))) throw new Error("Cliff and duration: enter whole days.");
        cliffSeconds = BigInt(text("cliff-seconds")) * SECONDS_PER_DAY;
        durationSeconds = BigInt(text("duration-seconds")) * SECONDS_PER_DAY;
        const dates = schedule({ delivery: mode, fixedStart, cliffSeconds, durationSeconds }, 0n);
        const timing = fixedStart
          ? `Start ${utc(dates.start)}. Cliff ${utc(dates.cliff)}. End ${utc(dates.end)}.`
          : "Start is set by the settlement block.";
        schedulePreview.textContent = `${cliffSeconds / SECONDS_PER_DAY}-day cliff, ${durationSeconds / SECONDS_PER_DAY}-day duration. ${timing} Accrual begins at start. The cliff releases the accrued portion.`;
      }
      const baseToken = text("sell-token"), quoteToken = text("buy-token"), buyer = text("taker");
      if (!isAddress(baseToken) || !isAddress(quoteToken)) throw new Error("Token addresses: enter both token contract addresses (0x and 40 hex digits).");
      if (same(baseToken, quoteToken)) throw new Error("Payment token: choose a different token from the allocation.");
      if (!isAddress(buyer) || same(buyer, ZERO_ADDRESS)) throw new Error("Designated buyer: enter a nonzero wallet address.");
      const [a, q, now] = await Promise.all([chain.token(baseToken), chain.token(quoteToken), chain.now()]);
      const allocation = parseAmount(text("sell-amount"), a.decimals, a.symbol), quote = parseAmount(text("buy-amount"), q.decimals, q.symbol);
      if (fees(quote).buyerTotal >= 1n << 256n) throw new Error("Payment before fees: lower the amount so the buyer total fits the token integer limit.");
      const seconds = expirySeconds(text("expiry-hours"));
      const t = { baseToken, quoteToken, buyer, allocation, quote, expiry: BigInt(now + seconds), delivery: mode, fixedStart, cliffSeconds, durationSeconds };
      schedule(t, now);
      const f = wallet?.account ? await Promise.all([chain.balanceOf(baseToken, wallet.account), chain.allowance(baseToken, wallet.account)]) : null;
      if (!live || seq !== read) return;
      [terms, sell, buy, funds] = [t, a, q, f];
      summary.replaceChildren(h("p", {}, `${mode ? "New vesting allocation" : "Immediate delivery"}: ${amount(allocation, a)} to ${buyer}.`), economics(quote, q));
    } catch (e) { problem = explain(e); }
    if (!live || seq !== read) return;
    if (problem) summary.replaceChildren(h("p", { class: "notice warn", testid: "validation", role: "status" }, problem));
    renderActions(problem);
  }
  function renderActions(problem) {
    let button, hint;
    if (busy) button = { label: "Waiting for confirmation…" };
    else if (problem) button = { label: "Check the terms above" };
    else if (!wallet) { button = { label: "Connect a wallet to fund" }; hint = NO_WALLET; }
    else if (!wallet.account) button = { label: "Connect wallet", run: () => act(() => wallet.connect()) };
    else if (wallet.chainId !== config.chainId) button = { label: "Switch network", run: () => act(() => wallet.switchTo(config.chainId)) };
    else if (!terms || !funds) button = { label: "Checking allocation…" };
    else if (funds[0] < terms.allocation) button = { label: `Not enough ${sell.symbol}` };
    else if (funds[1] < terms.allocation) button = { label: `Approve ${amount(terms.allocation, sell)}`, run: () => act(stage => approveExactly(app, sell, terms.allocation, funds[1], stage)) };
    else button = { label: "Fund the deal", run: create };
    updateArea(actions, action({ button, hint, notice }));
  }
  async function act(work) {
    if (busy) return;
    busy = true; notice = null; renderActions();
    for (const node of Object.values(field)) node.disabled = true;
    delivery.disabled = true;
    try { await work(text => { notice = { kind: "info", text }; renderActions(); }); }
    catch (e) { notice = { kind: "error", text: explain(e) }; }
    busy = false;
    for (const node of Object.values(field)) node.disabled = false;
    delivery.disabled = false;
    if (!created) await update();
  }
  async function create() {
    const t = { ...terms };
    await act(async stage => {
      const now = await chain.now();
      t.expiry = BigInt(now + expirySeconds(text("expiry-hours")));
      schedule(t, now);
      const receipt = await transact(app, config.contract, createV2Data(t), stage, "Funding the complete allocation");
      const id = fundedId(receipt, config.contract), link = `${location.href.split("#")[0]}#/v2/d/${id}`;
      created = true;
      if (live) app.main.replaceChildren(card(h("h1", {}, `Deal #${id} funded · v2`),
        h("p", { class: "held" }, "The full allocation is escrowed on-chain. Share this private link with the designated buyer."),
        h("div", { class: "linkbox" }, h("a", { testid: "deal-link", href: link }, link)), copyButton(link), economics(t.quote, buy), receiptView(receipt)));
    });
  }
  update();
  return { update, stop() { live = false; ++read; } };
}
