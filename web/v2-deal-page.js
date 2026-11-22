import { explainV2 as explain } from "./eth-v2.js";
import { approveExactly, cancelData, fillData, same, transact } from "./eth.js";
import { encodeV2 } from "./eth-v2.js";
import { action, amount, card, fact, h, leg, NO_WALLET, secondary } from "./ui.js";
import { fees, vesting } from "./vesting.js";
import { economics, receiptView, tokenWarning, utc, updateArea } from "./v2-ui.js";

export function dealPageV2(app, idText) {
  const { config, chain, wallet } = app;
  const id = /^\d{1,78}$/.test(idText) && BigInt(idText) < 2n ** 256n ? BigInt(idText) : null;
  let live = true, busy = false, reading = 0, d, base, quote, grant, now, balance, allowance, treasury, beneficiaryBalance, notice, receipt, readFailed = false;
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
    updateArea(content, h("div", {},
      h("p", { class: `status ${status}`, testid: "deal-status", "data-status": status }, status === "settled" && d.delivery ? grant?.claimed === d.allocation ? "Settled · fully claimed" : "Settled · vesting continues" : status),
      h("h2", { testid: "delivery-mode", class: `delivery ${d.delivery ? "new-vesting" : "immediate"}` }, mode),
      leg("Buyer total including fee", fees(d.quote).buyerTotal, quote, "pay"),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      leg(d.delivery ? "Grant allocation · unlocks over time" : "Buyer receives immediately", d.allocation, base, "receive"),
      h("p", { class: "held", testid: "funding-status" }, d.status === "funded" ? `On-chain funded: the full ${amount(d.allocation, base)} is escrowed in ${config.contract}.` : d.status === "settled" ? d.delivery ? "Settled: the grant was fully funded in this vault. Claims pay from the vault as tokens unlock." : "Settled: tokens were delivered immediately." : "Cancelled: allocation returned to the seller."),
      economics(d.quote, quote),
      h("dl", { class: "facts" }, fact("Seller", h("span", { class: "mono", testid: "maker" }, d.seller)), fact("Designated buyer / beneficiary", d.buyer),
        fact("Treasury · all protocol fees", treasury), fact("Contract / custodian", config.contract),
        fact("Expires", h("span", { testid: "expires", "data-expiry": String(d.expiry) }, utc(d.expiry))),
        d.delivery && fact("Committed schedule", `${d.fixedStart ? `Start ${utc(d.fixedStart)}; cliff ${utc(d.fixedStart + d.cliffSeconds)}; end ${utc(d.fixedStart + d.durationSeconds)}` : `Start at settlement block; cliff +${d.cliffSeconds} seconds; end +${d.durationSeconds} seconds`}. Accrual starts at start.`))));
    if (grant) renderGrant();
    renderActions();
  }
  function renderGrant() {
    const v = vesting(grant, now);
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
          ...["vested", "claimed", "claimable", "locked", "beneficiary-balance"].map(k => fact(k === "beneficiary-balance" ? "Beneficiary wallet balance" : k, h("span", { testid: k })))),
        h("progress", { max: "100", value: "0", "aria-label": "Allocation vested", testid: "vesting-timeline" }),
        h("p", { testid: "claim-timing", class: "hint" })));
    }
    for (const k of ["vested", "claimed", "claimable", "locked"]) grantArea.querySelector(`[data-testid="${k}"]`).textContent = amount(v[k], base);
    grantArea.querySelector('[data-testid="beneficiary-balance"]').textContent = amount(beneficiaryBalance, base);
    grantArea.querySelector('progress').value = Number(v.vested * 10000n / grant.allocation) / 100;
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
      if (result?.transactionHash) { receipt = result; if (live) receipts.replaceChildren(receiptView(receipt)); }
      notice = null;
    } catch (e) { notice = { kind: "error", text: explain(e) }; }
    await load(); busy = false; if (live) renderActions();
  }
  const poll = setInterval(() => { if (!busy) load(); }, 5000);
  load();
  return { update() { if (!busy) load(); }, stop() { live = false; ++reading; clearInterval(poll); } };
}
