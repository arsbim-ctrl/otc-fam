import { approveExactly, cancelData, explain, fillData, same, transact } from "./eth.js";
import { claimData, DELIVERY, feeBreakdown } from "./eth-v2.js";
import { action, amount, card, copyButton, fact, h, leg, networkName, NO_WALLET, notice, secondary } from "./ui.js";
import { transactionTracker } from "./v2-transactions.js";
import { displayDelivery, economics, replaceIfChanged, schedule, spanAddress, tokenWarning, txDetails, txReference, utc, version } from "./v2-ui.js";

export function v2DealPage(app, id) {
  const { main, config, chain, wallet } = app;
  const tracker = transactionTracker(app, `deal:${id}`);
  const s = { data: null, error: null, busy: null, notice: null, txHash: null, events: [], eventsKey: null, eventsError: false };
  let live = true, polling = false, reads = 0, activityRead = 0;

  const state = h("span", { class: "status", testid: "deal-status" });
  const lead = h("p", { class: "lead" });
  const termsSlot = h("div"), claimSlot = h("div"), controls = h("div"), history = h("div");
  const wrap = card(
    h("div", { class: "card-head" }, h("h1", {}, `Private deal #${id}`), h("div", { class: "v2-badges" }, state, version())),
    lead, h("div", { class: "v2-detail-grid" }, termsSlot, h("div", {}, claimSlot, controls, history)));
  main.replaceChildren(wrap);
  document.title = `Deal #${id} · otc.fam V2`;

  async function load() {
    const read = ++reads;
    try {
      const snapshot = await chain.snapshot();
      const { block, time } = snapshot;
      const deal = await chain.deal(id, block);
      if (deal.status === "none") {
        if (read === reads) Object.assign(s, { data: { deal }, error: null });
        return;
      }
      const account = wallet?.account;
      const funded = deal.status === "funded";
      const forBuyer = funded && same(deal.buyer, account) && wallet.chainId === config.chainId;
      const [base, payment, treasury, grant, backing] = await Promise.all([
        chain.token(deal.baseToken), chain.token(deal.quoteToken), chain.treasury(block),
        deal.grantId ? chain.grant(deal.grantId, block) : null,
        funded || deal.grantId ? chain.balanceOf(deal.baseToken, config.contract, block) : null,
      ]);
      let funds;
      if (forBuyer) {
        funds = await Promise.all([chain.balanceOf(deal.quoteToken, account, block), chain.allowance(deal.quoteToken, account, block)]).then(
          ([balance, allowance]) => ({ balance, allowance, account }),
          (e) => ({ error: explain(e), account }),
        );
      }
      if (read !== reads || !live) return;
      Object.assign(s, { data: { deal, base, payment, treasury, time, grant, backing, funds }, error: null });
      const key = `${deal.status}:${grant?.claimed ?? 0n}`;
      if (key !== s.eventsKey) loadActivity(key, block);
    } catch (e) {
      if (read === reads) s.error = explain(e);
    } finally {
      if (read === reads) render();
    }
  }

  async function loadActivity(key, block) {
    const read = ++activityRead;
    s.eventsKey = key;
    try {
      const events = await chain.activity(id, block);
      if (read === activityRead) Object.assign(s, { events, eventsError: false });
    } catch {
      if (read === activityRead) s.eventsError = true;
    }
    render();
  }

  function render() {
    if (!live) return;
    const d = s.data?.deal;
    if (!d || d.status === "none") {
      state.hidden = true;
      lead.textContent = s.error ? "The deal could not be read." : d ? "No V2 deal with this number exists at the linked contract." : "Reading deal from the chain…";
      for (const slot of [termsSlot, claimSlot, history]) replaceIfChanged(slot);
      replaceIfChanged(controls, s.error && action({ button: { label: "Try again", run: load }, notice: { kind: "error", text: s.error } }));
      return;
    }

    const { base, payment, treasury, time, grant, backing } = s.data;
    const vesting = d.delivery === DELIVERY.vesting;
    const ended = time >= d.expiry || (d.fixedStart !== 0n && time >= d.fixedStart);
    const refundable = d.status === "funded" && ended;
    const short = (d.status === "funded" || grant) && backing < d.allocation - (grant?.claimed ?? 0n);
    const label = short ? "Backing shortfall" : refundable ? "Refund available" : { funded: "Funded", settled: "Settled", cancelled: "Refunded" }[d.status];
    state.hidden = false;
    state.textContent = label;
    state.dataset.status = refundable ? "expired" : d.status;
    state.className = `status ${short || refundable ? "expired" : d.status === "funded" ? "open" : d.status === "settled" ? "filled" : "cancelled"}`;
    const intro = d.status === "funded"
      ? refundable ? "The settlement window ended. The seller can withdraw the escrow."
        : "The designated buyer can settle after verifying the terms below."
      : d.status === "cancelled" ? "The seller withdrew the funded allocation."
      : vesting ? "Payment settled and the grant was funded. The schedule below determines when units can be claimed."
      : "Payment and immediate delivery settled in one transaction.";
    if (lead.textContent !== intro) lead.textContent = intro;

    const isSeller = same(wallet?.account, d.seller);
    const { buyerTotal } = feeBreakdown(d.quote);
    const deadline = d.fixedStart && d.fixedStart < d.expiry ? d.fixedStart : d.expiry;
    const terms = [
      economics(d.quote, payment, treasury),
      h("dl", { class: "facts" },
        fact("Delivery", displayDelivery(d.delivery)), fact("Seller", spanAddress(d.seller)), fact("Designated buyer", spanAddress(d.buyer)),
        fact("Settlement deadline", utc(deadline)), fact("Escrow contract", spanAddress(config.contract))),
      !grant && schedule(d),
    ];
    replaceIfChanged(termsSlot,
      leg("Buyer pays", buyerTotal, payment, "pay"),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      leg(vesting ? "Allocation to vest" : "Buyer receives", d.allocation, base, "receive"),
      d.status === "funded"
        ? h("section", { class: "v2-section", "aria-label": "Deal terms" }, h("h2", {}, "Deal terms"), terms)
        : h("details", { class: "v2-section", open: termsSlot.querySelector("details")?.open }, h("summary", {}, "Deal terms"), terms),
      tokenWarning());
    replaceIfChanged(claimSlot, grant && grantPanel(grant, time, base));
    replaceIfChanged(controls,
      s.error && notice({ kind: "error", text: `Showing the last successful read. ${s.error}` }),
      short && notice({ kind: "error", text: "The token balance does not cover this allocation. The contract blocks release when backing is insufficient." }),
      !short && !s.error && d.status === "funded" && h("p", { class: "held" }, `${amount(d.allocation, base)} escrowed on-chain.`),
      isSeller && d.status === "funded" && !ended && h("section", { class: "v2-share" },
        h("h2", {}, "Share private link"), h("p", { class: "hint" }, "Only the named buyer can settle. Anyone with the link can read the terms."),
        h("p", { class: "linkbox mono" }, h("a", { href: location.href, testid: "deal-link" }, location.href)),
        copyButton(location.href)),
      actions(d, refundable, short),
      txDetails(s.notice?.kind === "success" ? "Confirmed transaction" : "Transaction", s.txHash, config.chainId));
    replaceIfChanged(history, activityPanel());
  }

  function grantPanel(grant, time, base) {
    const available = grant.vested - grant.claimed;
    const at = nextClaimTime(grant);
    const availability = available > 0n ? `${amount(available, base)} can be claimed now.`
      : grant.claimed === grant.allocation ? "All units have been claimed."
      : `Next units become claimable at ${utc(at)}.`;
    const progress = Number(grant.vested * 10_000n / grant.allocation);
    return h("section", { class: "v2-section v2-grant", "aria-labelledby": "grant-title" },
      h("h2", { id: "grant-title" }, `Vesting grant #${s.data.deal.grantId}`),
      h("p", { class: "hint" }, "Claims pay the recorded beneficiary. Units accrue from start and first become available at the cliff."),
      h("dl", { class: "v2-grant-metrics" },
        metric("Vested", grant.vested, "vested"), metric("Claimed", grant.claimed, "claimed"),
        metric("Claimable", available, "claimable"), metric("Locked", grant.allocation - grant.vested, "locked")),
      h("meter", { class: "v2-meter", min: "0", max: "10000", value: progress, "aria-label": "Vested portion of allocation",
        "aria-valuetext": `${amount(grant.vested, base)} of ${amount(grant.allocation, base)} vested` }),
      h("dl", { class: "v2-timeline" }, point("Start", grant.start), point("Cliff", grant.cliff), point("End", grant.end)),
      h("p", { class: "hint", testid: "claim-availability" }, availability),
      h("dl", { class: "facts" }, fact("Beneficiary", spanAddress(grant.beneficiary)), fact("Custodian", spanAddress(grant.custodian))));

    function metric(label, units, id) {
      return h("div", {}, h("dt", {}, label), h("dd", { testid: id }, amount(units, base)));
    }
    function point(label, timestamp) {
      return h("div", { class: time >= timestamp ? "reached" : null }, h("dt", {}, label), h("dd", {}, utc(timestamp)));
    }
  }

  function nextClaimTime(grant) {
    const duration = grant.end - grant.start;
    const first = grant.start + ((grant.claimed + 1n) * duration + grant.allocation - 1n) / grant.allocation;
    return first > grant.cliff ? first : grant.cliff;
  }

  function activityPanel() {
    if (s.events.length === 0 && !s.eventsError) return null;
    return h("section", { class: "v2-section v2-activity", "aria-label": "On-chain activity" }, h("h2", {}, "On-chain activity"),
      s.eventsError && action({ button: { label: "Retry activity read", run: retryActivity },
        notice: { kind: "warn", text: "This RPC could not return the deal’s event history. The terms and balances come from separate on-chain reads." } }),
      h("ol", {}, [...s.events].reverse().map((event) => h("li", {},
        h("span", {}, event.kind, event.amount !== null && ` · ${amount(event.amount, s.data.base)}`),
        txReference(config.chainId, event.hash)))));
  }

  function actions(d, refundable, short) {
    if (s.busy) return action({ button: { label: s.busy }, hint: s.stage });
    if (tracker.pending) return action({ button: { label: "Check transaction", run: resume }, notice: s.notice,
      extra: txDetails("Submitted transaction", tracker.pending.hash, config.chainId) });
    if (s.error) return action({ button: { label: "Refresh on-chain status", run: load }, notice: s.notice });
    const account = wallet?.account;
    const isSeller = same(account, d.seller);
    const { grant, payment, funds, base } = s.data;
    const mayClaim = !short && grant && grant.vested > grant.claimed;
    const mayRefund = isSeller && d.status === "funded";
    const maySettle = d.status === "funded" && !refundable && !short;
    if (!maySettle && !mayRefund && !mayClaim && !(refundable && !account)) {
      return s.notice && action({ notice: s.notice });
    }
    if (!wallet) return action({ notice: { kind: "info", text: NO_WALLET } });
    if (!account) return action({ button: { label: "Connect wallet", run: connect }, notice: s.notice });
    if ((mayRefund || mayClaim || same(account, d.buyer)) && wallet.chainId !== config.chainId) {
      return action({ button: { label: `Switch to ${networkName(config.chainId)}`, run: switchNetwork },
        hint: `Your wallet is on ${networkName(wallet.chainId)}.`, notice: s.notice });
    }
    if (mayRefund) return action({ extra: secondary("cancel-action", "Cancel deal & refund escrow", cancel),
      hint: "The allocation returns to the seller wallet.", notice: s.notice });
    if (mayClaim) return action({ button: { label: `Claim ${amount(grant.vested - grant.claimed, base)}`, run: claim },
      hint: same(account, grant.beneficiary) ? "Claims transfer available units to your beneficiary address."
        : `This wallet may trigger the claim. The tokens will go to ${grant.beneficiary}.`, notice: s.notice });
    if (!maySettle || !same(account, d.buyer)) return action({ notice: { kind: "warn", text: "Connect the designated buyer wallet to settle this deal." } });
    if (!funds || !same(account, funds.account)) return action({ hint: "Checking your token balance and allowance…" });
    if (funds.error) return action({ button: { label: "Retry balance read", run: load }, notice: { kind: "error", text: funds.error } });

    const { buyerTotal } = feeBreakdown(d.quote);
    const pay = amount(buyerTotal, payment);
    if (funds.balance < buyerTotal) return action({ notice: { kind: "warn", text: `This wallet holds ${amount(funds.balance, payment)}. Settlement requires ${pay}.` } });
    if (funds.allowance < buyerTotal) return action({
      button: { label: `Approve ${pay}`, run: approve },
      hint: "This approval includes the buyer fee. Payment moves only when settlement confirms.", notice: s.notice,
    });
    return action({ button: { label: `Settle & pay ${pay}`, run: fill },
      hint: d.delivery === DELIVERY.vesting ? "One transaction pays the seller and treasury and funds the buyer’s grant."
        : "One transaction pays the seller and treasury and delivers the allocation to the buyer.", notice: s.notice });
  }

  async function run(label, work) {
    if (!live || s.busy) return;
    Object.assign(s, { busy: label, stage: "", notice: null, txHash: null });
    render();
    try {
      await work((stage) => { s.stage = stage; render(); });
    } catch (e) {
      s.notice = { kind: "error", text: explain(e) };
      s.txHash = e.transactionHash;
    }
    await load();
    s.busy = null;
    render();
  }

  const receiptMessages = { approval: "Approval confirmed.", fill: "Settlement confirmed.", cancel: "Refund confirmed.", claim: "Claim confirmed." };
  const completed = (receipt, operation) => {
    s.notice = { kind: "success", text: receiptMessages[operation] };
    s.txHash = receipt.transactionHash;
    s.eventsKey = null;
  };
  const appFor = (operation) => ({ ...app, waitForReceipt: (tx) => tracker.waitForReceipt(tx, operation) });
  const send = (operation, data, label, what) => run(label, async (stage) =>
    completed(await transact(appFor(operation), config.contract, data, stage, what), operation));
  const connect = () => run("Connecting…", () => wallet.connect());
  const switchNetwork = () => run("Switching network…", () => wallet.switchTo(config.chainId));
  const retryActivity = () => { s.eventsKey = null; load(); };
  const resume = () => run("Checking transaction…", async () => {
    const operation = tracker.pending.action;
    const receipt = await tracker.check(0);
    if (receipt) completed(receipt, operation);
    else s.notice = { kind: "info", text: "This request is still pending on the read-only network." };
  });
  const approve = () => run("Approving payment…", async (stage) => {
    const account = wallet.account;
    const { time, block } = await chain.snapshot();
    const d = await chain.deal(id, block);
    if (!same(account, wallet.account) || !same(account, d.buyer)) throw new Error("Review the designated buyer before approving.");
    if (d.status !== "funded" || time >= d.expiry || (d.fixedStart && time >= d.fixedStart)) {
      throw new Error("This deal can no longer settle.");
    }
    const t = s.data;
    const { buyerTotal } = feeBreakdown(d.quote);
    const allowance = await chain.allowance(d.quoteToken, account, block);
    if (!same(account, wallet.account)) throw new Error("Your wallet changed accounts. Review the buyer before approving.");
    completed(await approveExactly(appFor("approval"), t.payment, buyerTotal, allowance, stage), "approval");
  });
  const fill = () => send("fill", fillData(id), "Settling…", "Settling the deal");
  const cancel = () => send("cancel", cancelData(id), "Refunding…", "Cancelling the deal");
  const claim = () => send("claim", claimData(s.data.deal.grantId), "Claiming…", "Claiming vested tokens");

  const refreshOnFocus = async () => {
    if (s.busy || polling) return;
    polling = true;
    try { await load(); } finally { polling = false; }
  };
  const poll = setInterval(refreshOnFocus, 5000);
  addEventListener("focus", refreshOnFocus);
  load().then(() => { if (live && tracker.pending) resume(); });
  return {
    update: () => { if (!s.busy) load(); },
    stop() {
      live = false;
      clearInterval(poll);
      removeEventListener("focus", refreshOnFocus);
    },
  };
}
