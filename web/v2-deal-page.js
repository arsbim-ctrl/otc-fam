import { explain, same } from "./eth.js";
import { card, copyButton, h, leg, liveStatus, networkName } from "./ui.js";
import { dealAction, fees, NEW_VESTING, receiptEvents } from "./v2-chain.js";
import { sendV2 } from "./v2-transactions.js";
import {
  addressText, dealLink, economics, facts, money, panel, readNotice, refreshReads, replaceChanged, replacementForm, scheduledTerms, submitApproval,
  tokenWarning, transactionFlow, transactionStatus, txHash, utc, walletAction, wireButton,
} from "./v2-ui.js";

const LABELS = {
  DealFunded: "Deal funded", DealSettled: "Deal settled", DealCancelled: "Allocation refunded",
  GrantCreated: "Grant created", GrantClaimed: "Grant claimed",
};

function statusOf(deal, time) {
  if (deal.status !== "funded") return deal.status;
  if (deal.fixedStart && time >= deal.fixedStart) return "start-passed";
  return time >= deal.expiry ? "expired" : "funded";
}

function nextUnlock(grant) {
  const duration = grant.end - grant.start;
  const offset = ((grant.claimed + 1n) * duration + grant.allocation - 1n) / grant.allocation;
  const unlock = grant.start + offset;
  return unlock < grant.cliff ? grant.cliff : unlock;
}

export function v2DealPage(app, id) {
  const { config, chain, wallet } = app;
  const state = { snapshot: null, error: null, activity: [], activityKey: null, historyError: false, run: null };
  let live = true;

  const badge = h("span", { class: "status v2-status", testid: "deal-status", "data-status": "loading" }, "Reading chain");
  const lead = h("p", { class: "lead", testid: "deal-summary" });
  const jump = h("button", { class: "v2-link-button v2-jump", type: "button", hidden: true, onclick: () => {
    document.getElementById("v2-grant")?.focus();
    document.getElementById("v2-grant")?.scrollIntoView({ block: "start" });
  } }, "View vesting schedule and claims");
  const readError = readNotice(() => reads.refresh());
  const dealBody = h("div", { class: "v2-grid", hidden: true });
  const swap = h("div", { class: "v2-panel" });
  const terms = h("div", { class: "v2-panel" });
  const grant = h("div", { class: "v2-grant-slot" });
  const receipts = h("div");
  const feedback = h("div");
  const hint = h("p", { class: "hint" });
  const transactionError = liveStatus();
  const button = h("button", { class: "primary", type: "button", testid: "primary-action", onclick: () => state.run?.(), hidden: true });
  const share = h("div", { class: "v2-share", hidden: true },
    h("p", { class: "hint" }, "Anyone with this link can read the terms. Only the designated buyer can settle."),
    copyButton(dealLink(config, id)));
  const controls = h("div", { class: "v2-actions" }, button, hint, feedback, transactionError.element);
  const actionSlot = h("div");
  const grantActions = h("div");
  const shell = card(h("div", { class: "v2-heading" },
    h("span", { class: "v2-kicker" }, "OTC V2"),
    h("div", { class: "card-head" }, h("h1", {}, `Private deal #${id}`), badge),
    lead, jump),
    readError.element, dealBody, grant, grantActions, receipts);
  shell.classList.add("v2-card");
  dealBody.append(h("div", { class: "v2-deal-left" }, swap, actionSlot, share), terms);
  const flow = transactionFlow(app, `otc-v2:${config.chainId}:${chain.contract}:deal:${id}`, render, (_job, receipt) => {
    mergeHistory(receiptEvents(receipt, chain.contract));
  });

  const reads = refreshReads(load, () => live && !flow.busy);
  const replacement = replacementForm(flow, refresh);
  controls.append(replacement);

  function mergeHistory(events) {
    const unique = new Map([...state.activity, ...events].map((event) => [`${event.hash}:${event.index}`, event]));
    state.activity = [...unique.values()].sort((a, b) => a.block === b.block ? Number(b.index - a.index) : (a.block < b.block ? 1 : -1));
  }

  function action(snapshot, status) {
    const { deal, quote, base, funds, grant } = snapshot;
    const me = wallet?.account;
    const seller = same(me, deal.seller);
    const buyer = same(me, deal.buyer);
    const send = (kind, label, operation, target = id) => () => flow.run(
      `Confirm ${label} in your wallet…`, () => sendV2(app, { kind, data: dealAction(operation, target), from: me }), refresh);
    const walletStep = () => walletAction(app, flow, refresh);

    if (grant) {
      if (grant.claimed === grant.allocation) return { hint: "The full allocation has been claimed." };
      if (grant.claimable === 0n) return { hint: `The next raw unit becomes claimable at ${utc(nextUnlock(grant))}, according to block time.` };
      if (me && !buyer) return { hint: `Connect the beneficiary wallet ${grant.beneficiary} to claim here.` };
      const step = walletStep();
      if (step.label || step.hint) return step;
      return {
        label: `Claim ${money(grant.claimable, base)}`, hint: "The transaction pays the recorded beneficiary.",
        run: send("claim", "the claim", "claim", grant.id),
      };
    }
    if (deal.status !== "funded") return {};
    if (seller) {
      const step = walletStep();
      if (step.label || step.hint) return step;
      return {
        label: "Cancel and reclaim allocation", hint: "The full allocation returns to the seller. There is no trading fee.",
        run: send("cancel", "the refund", "cancel"), refund: true,
      };
    }
    if (me && !buyer) return { hint: `This wallet cannot settle. Switch to the designated buyer ${deal.buyer} in your wallet.` };
    if (status !== "funded") return me ? { hint: "The seller can still reclaim the allocated tokens." } : walletStep();
    if (!snapshot.backed) return { hint: "The deal contract reports less than this allocation. Settlement is unavailable." };
    const step = walletStep();
    if (step.label || step.hint) return step;
    const total = fees(deal.quote).buyerTotal;
    const payment = money(total, quote);
    if (!funds || funds.account !== me) return { hint: "Checking your payment balance and approval…" };
    if (funds.balance < total) return { hint: `Settlement costs ${payment}. This wallet holds ${money(funds.balance, quote)}.` };
    if (funds.allowance < total) {
      return {
        label: `Approve ${payment}`, hint: "This approval allows the exact payment including the buyer fee. Settlement is a separate action.",
        run: () => flow.run("Confirm token approval in your wallet…",
          () => submitApproval(app, me, quote, total, funds.allowance), refresh),
      };
    }
    return {
      label: `Settle · pay ${payment}`, hint: deal.delivery === NEW_VESTING
        ? "One transaction pays the seller and treasury and fully funds your grant."
        : "One transaction pays the seller and treasury and delivers the full allocation to your wallet.",
      run: send("settle", "settlement", "fill"),
    };
  }

  function render() {
    if (!live) return;
    const snapshot = state.snapshot;
    const deal = snapshot?.deal;
    const status = deal ? statusOf(deal, snapshot.block.time) : state.error ? "unavailable" : "loading";
    const styles = {
      loading: ["", "Reading chain"], unavailable: ["not-found", "Unavailable"], none: ["not-found", "No such deal"],
      funded: ["open", "Funded"], settled: ["filled", "Settled"], cancelled: ["cancelled", "Refunded"],
      expired: ["expired", "Expired"], "start-passed": ["expired", "Start passed"],
    };
    badge.className = `status v2-status ${styles[status][0]}`;
    badge.dataset.status = status;
    badge.textContent = styles[status][1];
    dealBody.hidden = !deal || status === "none";
    readError.update(state.error);

    if (!deal || status === "none") {
      lead.textContent = status === "none" ? "This deal ID does not exist on the configured V2 contract."
        : state.error ? "The deal could not be verified right now." : "Reading the funded terms from the chain…";
      return;
    }

    const { base, quote, treasury, backed } = snapshot;
    const isVesting = deal.delivery === NEW_VESTING;
    const f = fees(deal.quote);
    const messages = {
      funded: backed ? "The full allocation is in escrow. Only the designated buyer can settle." : "The escrow balance is below the committed allocation.",
      settled: isVesting ? "Payment is complete and the grant is fully funded. Tokens unlock on the schedule below."
        : "Payment is complete. The full allocation was delivered directly to the buyer’s wallet.",
      cancelled: "The seller reclaimed the allocation. This deal is closed.",
      expired: "The settlement deadline has passed. The seller can reclaim the allocation.",
      "start-passed": "The fixed vesting start has passed. The seller can reclaim the allocation.",
    };
    lead.textContent = messages[status];
    jump.hidden = !snapshot.grant;
    share.hidden = deal.status !== "funded" || !same(deal.seller, wallet?.account);

    replaceChanged(swap, h("div", {},
      leg("Buyer pays", f.buyerTotal, quote, "pay"),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      leg(isVesting ? "Allocated to a new vesting grant" : "Delivered to the buyer’s wallet", deal.allocation, base, "receive")));
    replaceChanged(terms, panel("v2-terms", "Deal terms",
      facts(economics(deal.quote, quote)),
      facts([
        ["Delivery", isVesting ? "New vesting grant" : "Immediate delivery"],
        ["Seller", addressText(deal.seller)], ["Designated buyer", addressText(deal.buyer)],
        ["Treasury", addressText(treasury)], ["Expiry (UTC)", utc(deal.expiry)],
        ...(!snapshot.grant ? scheduledTerms(deal) : []),
      ], "facts v2-addresses"),
      tokenWarning()));

    replaceChanged(grant, snapshot.grant ? grantPanel(snapshot.grant, base) : h("span", { hidden: true }));
    const target = snapshot.grant ? grantActions : actionSlot;
    if (!target.contains(controls)) target.append(controls);
    const next = flow.busy || flow.job || state.error ? {} : action(snapshot, status);
    hint.textContent = next.hint ?? "";
    button.hidden = !flow.busy && !flow.job && !next.label;
    button.className = next.refund ? "secondary" : "primary";
    wireButton(button, state, flow.busy || (flow.job ? "Waiting for receipt…" : next.label || ""), next.run);
    replaceChanged(feedback, transactionStatus(config, flow));
    transactionError.update(flow.feedback?.kind === "error" ? flow.feedback.text : null);
    replacement.hidden = !flow.job;

    const activity = state.activity.map((event) => h("li", {},
      h("strong", {}, LABELS[event.name], event.amount === undefined ? "" : ` · ${money(event.amount, base)}`),
      h("span", { class: "hint" }, `Block ${event.block}`), txHash(config, event.hash)));
    replaceChanged(receipts, panel("v2-activity", "Transaction receipts",
      activity.length ? h("ol", { class: "v2-receipts" }, activity) : null,
      state.historyError ? h("p", { class: "hint" }, "The RPC could not read event history. Current balances and deal status are shown above.")
        : !activity.length && h("p", { class: "hint" }, "Reading funding and settlement events…")));
  }

  function grantPanel(grant, token) {
    const vestedPercent = Number(grant.vested * 10000n / grant.allocation) / 100;
    const section = panel("v2-grant", `Vesting grant #${grant.id}`,
      h("p", { class: "hint" }, "The cliff releases accrued tokens. The remainder vests linearly until the end."),
      h("label", { for: "vesting-progress", class: "sr-only" }, "Portion of the allocation vested"),
      h("progress", { id: "vesting-progress", max: 100, value: vestedPercent }),
      h("ol", { class: "v2-timeline", "aria-label": "Vesting schedule in UTC" },
        [["Start", grant.start], ["Cliff", grant.cliff], ["End", grant.end]].map(([name, time]) => h("li", {},
          h("strong", {}, name), h("span", {}, utc(time))))),
      facts([
        ["Allocation", money(grant.allocation, token)], ["Vested", money(grant.vested, token)],
        ["Claimed", money(grant.claimed, token)], ["Claimable", h("strong", { testid: "claimable" }, money(grant.claimable, token))],
        ["Locked", money(grant.allocation - grant.vested, token)],
      ], "facts v2-grant-balances"),
      facts([["Beneficiary", addressText(grant.beneficiary)], ["Vesting vault", addressText(grant.custodian)]], "facts v2-addresses"));
    section.querySelector("h2").tabIndex = -1;
    return section;
  }

  async function readSnapshot(current) {
    const account = wallet?.account;
    const onNetwork = wallet?.chainId === config.chainId;
    const block = await chain.block();
    if (!current()) return;
    await flow.check(block);
    if (!current()) return;
    const deal = await chain.terms(id, block.number);
    if (!current()) return;
    if (deal.status === "none") return { block, deal };
    const readingFunds = deal.status === "funded" && same(account, deal.buyer) && onNetwork;
    const [base, quote, treasury, escrow, grant, funds] = await Promise.all([
      chain.token(deal.baseToken), chain.token(deal.quoteToken), chain.beneficiaryTreasury(block.number),
      deal.status === "funded" ? chain.balanceOf(deal.baseToken, chain.contract, block.number) : null,
      deal.grantId ? chain.grant(deal.grantId, block.number) : null,
      readingFunds ? Promise.all([
        chain.balanceOf(deal.quoteToken, account, block.number), chain.allowance(deal.quoteToken, account, block.number),
      ]).then(([balance, allowance]) => ({ account, balance, allowance })) : null,
    ]);
    return { block, deal, base, quote, treasury, backed: escrow !== null && escrow >= deal.allocation, grant, funds };
  }

  async function load(current) {
    try {
      const snapshot = await readSnapshot(current);
      if (!current()) return;
      state.snapshot = snapshot;
      state.error = null;
      render();

      const historyKey = `${snapshot.deal.status}:${snapshot.grant?.claimed ?? ""}`;
      if (snapshot.deal.status !== "none" && state.activityKey !== historyKey) {
        await chain.history(id, snapshot.deal.grantId, snapshot.block.number).then((history) => {
          if (!current()) return;
          mergeHistory(history);
          state.activityKey = historyKey;
          state.historyError = false;
        }, () => { if (current()) state.historyError = true; });
      }
    } catch (error) {
      if (current()) state.error = explain(error, "read");
    }
    if (current()) render();
  }

  function refresh() {
    reads.invalidate();
    if (state.snapshot) state.snapshot.funds = null;
    render();
    return reads.refresh();
  }

  app.main.replaceChildren(shell);
  document.title = `Private deal #${id} · ${networkName(config.chainId)} · otc.fam`;
  const poll = setInterval(reads.refresh, 4000);
  addEventListener("focus", reads.refresh);
  render();
  reads.refresh();
  return {
    update: refresh,
    stop() {
      live = false;
      clearInterval(poll);
      removeEventListener("focus", reads.refresh);
    },
  };
}
