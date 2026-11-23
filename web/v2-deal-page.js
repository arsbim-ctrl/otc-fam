import { explainV2 as explain } from "./eth-v2.js";
import { approveExactly, cancelData, fillData, same, transact } from "./eth.js";
import { encodeV2 } from "./eth-v2.js";
import { action, amount, card, fact, fromNow, h, leg, NO_WALLET, secondary } from "./ui.js";
import { fees, vesting } from "./vesting.js";
import { economics, receiptView, tokenWarning, utc, updateArea } from "./v2-ui.js";

const DAY = 86_400n;
const units = (count, unit) => `${count} ${unit}${count === 1n ? "" : "s"}`;

function scheduleLength(seconds) {
  const days = seconds / DAY, hours = seconds % DAY / 3_600n, minutes = seconds % 3_600n / 60n, remainder = seconds % 60n;
  if (seconds === 0n) return "0 days";
  return [[days, "day"], [hours, "hour"], [minutes, "minute"], [remainder, "second"]]
    .filter(([count]) => count > 0n).map(([count, unit]) => units(count, unit)).join(", ");
}

function relativeTime(delta) {
  const distance = delta < 0n ? -delta : delta;
  if (distance < DAY) return fromNow(Number(delta));
  const days = units((distance + DAY / 2n) / DAY, "day");
  return delta < 0n ? `${days} ago` : `in ${days}`;
}

export function dealPageV2(app, idText) {
  const { config, chain, wallet } = app;
  const id = /^\d{1,78}$/.test(idText) && BigInt(idText) < 2n ** 256n ? BigInt(idText) : null;
  let live = true, busy = false, reading = 0, d, base, quote, grant, now, balance, allowance, treasury, beneficiaryBalance, notice, receipt, history = null, historyKey = null, readFailed = false;
  const content = h("div"), grantArea = h("div"), actions = h("div"), receipts = h("div");
  const shell = card(h("h1", {}, `Deal #${idText.slice(0, 78)} · v2`), content, grantArea, tokenWarning(), actions, receipts);
  shell.classList.add("v2-card");
  app.main.replaceChildren(shell);
  async function load() {
    const seq = ++reading;
    try {
      const snapshot = id === null ? { deal: { status: "none" } } : await chain.snapshot(id);
      const deal = snapshot.deal;
      if (deal.status === "none") {
        if (live) content.replaceChildren(h("p", { testid: "deal-status", "data-status": "not-found" }, "Deal not found. Check the private link."));
        return;
      }
      const values = await Promise.all([chain.token(deal.baseToken), chain.token(deal.quoteToken), snapshot.time,
        snapshot.grant, chain.treasury(),
        wallet?.account ? chain.balanceOf(deal.quoteToken, wallet.account) : null,
        wallet?.account ? chain.allowance(deal.quoteToken, wallet.account) : null,
        deal.grantId ? chain.balanceOf(deal.baseToken, deal.buyer) : null]);
      if (!live || seq !== reading) return;
      // Receipts come from contract events; reread them only when the deal or its claims change.
      const key = `${deal.status}:${snapshot.grant?.claimed ?? ""}`;
      if (key !== historyKey && deal.status !== "funded") {
        const found = await chain.history(deal).catch(() => null);
        if (!live || seq !== reading) return;
        if (found) { history = found; historyKey = key; }
      }
      if (readFailed) notice = null;
      readFailed = false;
      d = deal; [base, quote, now, grant, treasury, balance, allowance, beneficiaryBalance] = values;
      render();
    } catch (e) {
      if (!live || seq !== reading) return;
      readFailed = true;
      notice = { kind: "error", text: `Could not refresh on-chain status. ${explain(e)}` };
      // Disable transactions against a stale snapshot until a successful refresh.
      d = null;
      renderActions();
    }
  }
  function render() {
    if (!live || !d) return;
    const status = d.status === "funded" && BigInt(now) >= d.expiry ? "expired" : d.status;
    const mode = d.delivery ? "New vesting · funded grant" : "Immediate · tokens at settlement";
    const statusLabel = {
      funded: "Funded — allocation escrowed",
      expired: "Expired — seller can refund",
      cancelled: "Cancelled — allocation returned",
      settled: !d.delivery ? "Settled — tokens delivered"
        : grant?.claimed === d.allocation ? "Settled — fully claimed" : "Settled — vesting continues",
    }[status];
    const startLabel = d.fixedStart
      ? `Start ${utc(d.fixedStart)}. Cliff ${utc(d.fixedStart + d.cliffSeconds)}. End ${utc(d.fixedStart + d.durationSeconds)}.`
      : "Start at settlement block.";
    updateArea(content, h("div", {},
      h("p", { class: `status ${status}`, testid: "deal-status", "data-status": status }, statusLabel),
      h("p", { class: "hint", testid: "your-role" }, role(status)),
      h("h2", { testid: "delivery-mode", class: `delivery ${d.delivery ? "new-vesting" : "immediate"}` }, mode),
      leg("Buyer total including fee", fees(d.quote).buyerTotal, quote, "pay"),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      leg(d.delivery ? "Grant allocation · unlocks over time" : "Buyer receives immediately", d.allocation, base, "receive"),
      h("p", { class: "held", testid: "funding-status" }, d.status === "funded" ? `On-chain funded: the full ${amount(d.allocation, base)} is escrowed in ${config.contract}.` : d.status === "settled" ? d.delivery ? "Settled: the grant was fully funded in this vault. Claims pay from the vault as tokens unlock." : "Settled: tokens were delivered immediately." : "Cancelled: allocation returned to the seller."),
      economics(d.quote, quote),
      h("dl", { class: "facts" }, fact("Seller", h("span", { class: "mono", testid: "maker" }, d.seller)), fact("Designated buyer / beneficiary", d.buyer),
        fact("Treasury · all protocol fees", treasury), fact("Contract / custodian", config.contract),
        fact("Expires", h("span", { testid: "expires", "data-expiry": String(d.expiry) }, utc(d.expiry))),
        d.delivery && fact("Committed schedule", `${startLabel} Cliff after ${scheduleLength(d.cliffSeconds)}. Duration ${scheduleLength(d.durationSeconds)}. Accrual starts at start.`))));
    if (grant) renderGrant();
    renderActions();
    renderReceipts();
  }
  // Who the connected wallet is relative to this deal. Actions stay as before; this only says why.
  function role(status) {
    const me = wallet?.account;
    if (!me) return "Viewing without a wallet connected. Anyone with this link can read the deal.";
    const seller = same(me, d.seller), buyer = same(me, d.buyer);
    if (seller && buyer) return "You are the seller and the designated buyer / beneficiary.";
    if (seller) return {
      funded: "You are the seller. You can cancel and refund the allocation; only the designated buyer can settle.",
      expired: "You are the seller. This deal expired: cancel to refund the allocation.",
      settled: "You are the seller. Settlement paid you directly.",
      cancelled: "You are the seller. The allocation was returned to you.",
    }[status];
    if (buyer) return `You are the designated buyer / beneficiary.${status === "funded" ? " Only you can settle this deal." : d.delivery && status === "settled" ? " Every claim pays this wallet." : ""}`;
    if (grant) return `You can trigger a claim, but tokens pay only the recorded beneficiary ${grant.beneficiary}.`;
    return "You are neither the seller nor the designated buyer. You can read this deal but not settle or cancel it.";
  }
  function renderReceipts() {
    const list = [...history ?? []];
    // Keep this session's receipt visible if the event read failed or lags.
    if (receipt && !list.some(r => r.receipt?.transactionHash === receipt.transactionHash)) list.push({ receipt });
    updateArea(receipts, h("div", {}, list.length > 0 && h("h2", {}, "On-chain receipts"),
      list.map(r => receiptView(r.receipt, r.kind === "Claim" ? `Claim of ${amount(r.claimed, base)} to the beneficiary` : r.kind))));
  }
  function renderGrant() {
    const v = vesting(grant, now);
    const time = BigInt(now), { start, cliff, end } = grant;
    const position = timestamp => Number((timestamp - start) * 10_000n / (end - start)) / 100;
    const cliffPosition = position(cliff);
    let timing;
    if (BigInt(now) < grant.cliff) timing = `Claiming becomes possible at ${utc(grant.cliff)} (subject to raw-unit rounding).`;
    else if (v.claimable === 0n && v.claimed < grant.allocation) {
      const duration = grant.end - grant.start;
      const next = grant.start + ((grant.claimed + 1n) * duration + grant.allocation - 1n) / grant.allocation;
      timing = `No tokens are claimable now. The next raw unit vests at ${utc(next)}. All remaining units unlock at ${utc(grant.end)}.`;
    } else timing = v.claimed === grant.allocation ? "Fully claimed. Nothing remains in this grant." : "Claimable tokens pay only the recorded buyer beneficiary. Remaining locked tokens continue vesting.";
    // This shell is stable. Polling writes only text and the timeline value.
    if (!grantArea.firstElementChild) {
      grantArea.append(h("section", { class: "vesting", "aria-label": "Vesting schedule" }, h("h2", {}, `Grant #${grant.id}`),
        h("dl", { class: "facts" }, fact("Start UTC", utc(grant.start)), fact("Cliff UTC", utc(grant.cliff)), fact("End UTC", utc(grant.end)), fact("Beneficiary", grant.beneficiary),
          ...["vested", "claimed", "claimable", "locked", "beneficiary-balance"].map(k => fact(k === "beneficiary-balance" ? "Beneficiary wallet balance" : k[0].toUpperCase() + k.slice(1), h("span", { testid: k })))),
        h("div", { class: "vesting-timeline", style: `--cliff: ${cliffPosition}%` },
          h("progress", { max: "100", value: "0", "aria-label": "Time elapsed in vesting schedule", testid: "vesting-timeline" }),
          h("span", { class: "vesting-start", "aria-hidden": "true" }, "Start"),
          h("span", { class: "vesting-cliff", "aria-hidden": "true" }, "Cliff"),
          h("span", { class: "vesting-end", "aria-hidden": "true" }, "End")),
        h("p", { class: "hint", testid: "chain-now" }),
        h("p", { class: "hint", testid: "vesting-countdown" }),
        h("p", { testid: "claim-timing", class: "hint" })));
    }
    for (const k of ["vested", "claimed", "claimable", "locked"]) grantArea.querySelector(`[data-testid="${k}"]`).textContent = amount(v[k], base);
    grantArea.querySelector('[data-testid="beneficiary-balance"]').textContent = amount(beneficiaryBalance, base);
    const timeline = grantArea.querySelector("progress");
    timeline.value = time <= start ? 0 : time >= end ? 100 : position(time);
    const nowText = `Chain now: ${utc(time)}`;
    const cliffText = time < cliff ? `Cliff ${relativeTime(cliff - time)}`
      : time === cliff ? "Cliff reached" : `Cliff passed ${relativeTime(cliff - time)}`;
    const endText = time < end ? `Ends ${relativeTime(end - time)}`
      : time === end ? "Ends now" : `Ended ${relativeTime(end - time)}`;
    const startText = time < start ? `Starts ${relativeTime(start - time)}. ` : "";
    const countdown = `${startText}${cliffText}. ${endText}.`;
    timeline.setAttribute("aria-valuetext", `${nowText}. Start: ${utc(start)}. Cliff: ${utc(cliff)}. End: ${utc(end)}. ${countdown}`);
    grantArea.querySelector('[data-testid="chain-now"]').textContent = nowText;
    grantArea.querySelector('[data-testid="vesting-countdown"]').textContent = countdown;
    grantArea.querySelector('[data-testid="claim-timing"]').textContent = timing;
  }
  function renderActions() {
    let button, hint, extra;
    if (busy) button = { label: "Waiting for confirmation…" };
    else if (!d) button = { label: "Refresh on-chain status", run: load };
    else if (!wallet) { hint = NO_WALLET; button = { label: "Connect a wallet to continue" }; }
    else if (!wallet.account) button = { label: "Connect wallet", run: () => act(() => wallet.connect()) };
    else if (wallet.chainId !== config.chainId) button = { label: "Switch network", run: () => act(() => wallet.switchTo(config.chainId)) };
    else if (d.status === "funded") {
      if (same(wallet.account, d.seller)) extra = secondary("cancel-action", "Cancel and refund allocation", () => act(stage => transact(app, config.contract, cancelData(id), stage, "Returning allocation to seller")));
      if (BigInt(now) >= d.expiry) hint = "This deal expired. Only the seller can refund the allocation.";
      else if (!same(wallet.account, d.buyer)) hint = `Only designated buyer ${d.buyer} can settle. Switch wallet accounts to continue.`;
      else {
        const total = fees(d.quote).buyerTotal;
        if (balance < total) hint = `Buyer total is ${amount(total, quote)}; wallet holds ${amount(balance, quote)}.`;
        else if (allowance < total) button = { label: `Approve ${amount(total, quote)}`, run: () => act(stage => approveExactly(app, quote, fees(d.quote).buyerTotal, allowance, stage)) };
        else button = { label: d.delivery ? "Settle and fund vesting grant" : "Settle immediate delivery", run: () => act(stage => transact(app, config.contract, fillData(id), stage, "Settling the deal atomically")) };
      }
    } else if (grant) {
      const v = vesting(grant, now);
      button = { label: v.claimable ? "Claim vested tokens" : v.claimed === grant.allocation ? "Fully claimed" : "Nothing claimable yet", run: v.claimable ? () => act(stage => transact(app, config.contract, encodeV2("claim", grant.id), stage, "Claiming to the recorded beneficiary")) : null };
      hint = `Every claim goes to ${grant.beneficiary}. Triggering a claim gives this wallet no ownership rights.`;
    }
    updateArea(actions, action({ button, hint, extra, notice }));
  }
  async function act(work) {
    if (busy) return;
    busy = true; notice = null; renderActions();
    try {
      const result = await work(text => { notice = { kind: "info", text }; renderActions(); });
      if (result?.transactionHash) { receipt = result; historyKey = null; }
      notice = null;
    } catch (e) { notice = { kind: "error", text: explain(e) }; }
    await load(); busy = false; if (live) renderActions();
  }
  const poll = setInterval(() => { if (!busy) load(); }, 5000);
  load();
  return { update() { if (!busy) load(); }, stop() { live = false; ++reading; clearInterval(poll); } };
}
