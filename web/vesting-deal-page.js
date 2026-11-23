import { cancelData, fillData, same } from "./eth.js";
import { action, amount, card, copyButton, fact, h, head, leg, networkName, NO_WALLET, notice, secondary } from "./ui.js";
import { claimData, economics, MAX_UINT, NEW_VESTING, v2Approval, v2Reason } from "./vesting-chain.js";
import { deliveryName, draw, fees, mono, operation, receiptLink, schedule, transactionStatus, utc } from "./vesting-ui.js";

export function vestingDealPage(app, idText) {
  const { config, chain, wallet } = app;
  const id = /^\d{1,78}$/.test(idText) && BigInt(idText) <= MAX_UINT ? BigInt(idText) : 0n;
  const state = { snapshot: null, error: null, events: null, eventsKey: "" };
  let live = true, reading = 0;
  const tx = operation(app, "deal:" + id, { render, refresh: load });
  const timer = setInterval(() => { if (!tx.state.busy) load(); }, 5000);

  async function load() {
    if (!live) return;
    const read = ++reading;
    if (id === 0n) {
      state.snapshot = { deal: { status: "none" } };
      return render();
    }
    try {
      const block = await chain.block();
      const deal = await chain.deal(id, block.number);
      let snapshot = { deal };
      if (deal.status !== "none") {
        const account = wallet?.account;
        const walletReady = account && wallet.chainId === config.chainId;
        const grantRead = deal.grantId ? chain.grant(deal.grantId, block.number) : null;
        const fundsRead = walletReady && same(account, deal.buyer) && deal.status === "funded" ? Promise.all([
          chain.balanceOf(deal.quoteToken, account), chain.allowance(deal.quoteToken, account),
        ]) : null;
        const [base, payment, treasury, escrow, grant, funds] = await Promise.all([
          chain.token(deal.baseToken), chain.token(deal.quoteToken), chain.treasury(block.number),
          chain.balanceOf(deal.baseToken, config.contract, block.number), grantRead, fundsRead,
        ]);
        const beneficiaryBalance = grant ? await chain.balanceOf(grant.token, grant.beneficiary, block.number) : null;
        snapshot = { deal, now: BigInt(block.timestamp), base, payment, treasury, escrow, grant, funds, account, beneficiaryBalance };
        const eventKey = [deal.status, deal.grantId, grant?.claimed, tx.state.receipt].join(":");
        if (state.events === null || state.eventsKey !== eventKey) {
          chain.events(id, block.number).then((events) => {
            if (!live || read !== reading) return;
            state.events = events;
            state.eventsKey = eventKey;
            render();
          }).catch(() => {});
        }
      }
      if (read !== reading) return;
      state.snapshot = snapshot;
      state.error = null;
    } catch (error) {
      if (read !== reading) return;
      state.error = v2Reason(error);
    }
    render();
  }

  function render() {
    if (!live) return;
    const root = view();
    root.classList.add("v2-card");
    draw(app.main, root);
  }

  function view() {
    const snapshot = state.snapshot;
    const version = h("p", { class: "version-label" }, "OTC deal · V2");
    if (!snapshot) {
      return card(version, h("h1", {}, "Private deal"),
        state.error ? notice({ kind: "error", text: state.error }) : h("p", { class: "lead" }, "Reading the deal from the chain…"),
        state.error && secondary("v2-retry", "Try again", load));
    }
    const { deal, now, base, payment, treasury, escrow, grant } = snapshot;
    if (deal.status === "none") return card(version, head("Private deal", "not-found"),
      h("p", { class: "lead" }, "No V2 deal matches this link on " + networkName(config.chainId) + "."),
      h("a", { class: "button secondary", href: "#/v2/new" }, "Create a private deal"));

    const stale = Boolean(deal.fixedStart && now >= deal.fixedStart);
    const expired = deal.status === "funded" && now >= deal.expiry;
    const quote = economics(deal.quote);
    const backed = escrow >= (grant ? grant.allocation - grant.claimed : deal.allocation);
    const status = expired ? "expired" : deal.status;
    const copy = () => copyButton(location.href, "v2-copy");
    return card(version, head("Private deal #" + id, status),
      h("p", { class: "lead" }, deliveryName(deal.delivery)),
      leg("Buyer pays", quote.buyerTotal, payment, "pay"),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      leg(deal.delivery === NEW_VESTING ? "Grant allocation" : "Buyer receives", deal.allocation, base, "receive"),
      deal.status === "funded" && h("p", { class: backed ? "held" : "notice warn", testid: "v2-funding" },
        backed ? "The full allocation is escrowed on-chain." : "The on-chain escrow balance is below the promised allocation."),
      deal.status === "settled" && !grant && h("p", { class: "held" }, "Payment and immediate delivery settled in one transaction."),
      deal.status === "cancelled" && h("p", { class: "hint v2-foot" }, "The seller refunded the allocation. The deal can no longer settle."),
      fees(deal.quote, payment, treasury),
      h("dl", { class: "facts v2-fees", "aria-label": "Deal terms" },
        fact("Seller", mono(deal.seller)), fact("Designated buyer", mono(deal.buyer)),
        fact("Expiry", utc(deal.expiry)), fact("Escrow contract", mono(config.contract))),
      !grant && schedule(deal),
      grant && grantPanel(snapshot, backed),
      state.error && notice({ kind: "warn", text: "The latest block could not be read. " + state.error }),
      buttons(snapshot, expired, stale, backed),
      deal.status === "funded" && h("div", { class: "row" }, copy()),
      eventHistory(base));
  }

  function grantPanel(snapshot, backed) {
    const { grant, base, now, beneficiaryBalance } = snapshot;
    const locked = grant.allocation - grant.vested;
    const duration = grant.end - grant.start;
    const nextVested = grant.claimed + 1n;
    const nextOffset = (nextVested * duration + grant.allocation - 1n) / grant.allocation;
    const nextAccrual = grant.start + nextOffset;
    const next = nextAccrual > grant.cliff ? nextAccrual : grant.cliff;
    const progress = grant.vested * 10000n / grant.allocation;
    let availability = "Vesting follows the latest block time. Claims pay the recorded beneficiary.";
    if (grant.claimed === grant.allocation) availability = "All tokens have been claimed.";
    else if (now < grant.cliff) availability = "Claims open at the cliff on " + utc(grant.cliff) + ".";
    else if (grant.claimable === 0n) availability = "The next raw unit can be claimed from " + utc(next) + ", once a block reaches that time.";
    return h("section", { class: "v2-grant", "aria-labelledby": "grant-heading" },
      h("h2", { id: "grant-heading" }, "Vesting grant #" + snapshot.deal.grantId),
      h("p", { class: "hint" }, availability),
      !backed && notice({ kind: "warn", text: "The custody balance is below this grant’s remaining allocation." }),
      h("progress", { max: "10000", value: String(progress), "aria-label": "Vested proportion of allocation" }),
      h("dl", { class: "facts v2-fees", "aria-label": "Vesting balances" },
        fact("Vested", amount(grant.vested, base)), fact("Claimed", amount(grant.claimed, base)),
        fact("Claimable", h("span", { testid: "v2-claimable" }, amount(grant.claimable, base))),
        fact("Locked", amount(locked, base)), fact("Beneficiary balance", amount(beneficiaryBalance, base)),
        fact("Beneficiary", mono(grant.beneficiary))),
      h("dl", { class: "facts v2-fees", "aria-label": "Vesting dates" },
        fact("Start", utc(grant.start)), fact("Cliff", utc(grant.cliff)), fact("End", utc(grant.end))));
  }

  function eventHistory(token) {
    if (!state.events?.length) return null;
    return h("details", { class: "v2-history" }, h("summary", {}, "On-chain events and receipts"),
      h("ol", {}, [...state.events].reverse().map(({ name, hash, quantity }) =>
        h("li", {}, h("strong", {}, quantity === null ? name : name + " · " + amount(quantity, token)), receiptLink(config, hash)))));
  }

  function buttons(snapshot, expired, stale, backed) {
    const { deal, payment, grant, funds } = snapshot;
    const me = wallet?.account;
    const seller = same(me, deal.seller);
    const buyer = same(me, deal.buyer);
    const refundable = deal.status === "funded" && seller;
    const purchasable = deal.status === "funded" && !expired && !stale && backed;
    const claimable = grant && grant.claimable > 0n && backed;
    let button, hint;
    const extra = [];
    if (tx.state.busy) button = { label: "Working…" };
    else if (tx.state.pending) button = { label: "Check transaction", run: tx.resume };
    else if (!state.error && (purchasable || refundable || claimable)) {
      if (!wallet) {
        hint = NO_WALLET;
      } else if (!me) {
        button = { label: "Connect wallet", run: () => tx.wallet(() => wallet.connect()) };
      } else if (wallet.chainId !== config.chainId && (buyer || refundable)) {
        button = { label: "Switch to " + networkName(config.chainId), run: () => tx.wallet(() => wallet.switchTo(config.chainId)) };
      } else if (purchasable && buyer) {
        const total = economics(deal.quote).buyerTotal;
        if (!funds || !same(me, snapshot.account)) button = { label: "Checking wallet balance…" };
        else if (funds[0] < total) hint = "Your balance is " + amount(funds[0], payment) + ". You need " + amount(total, payment) + ".";
        else if (funds[1] < total) button = {
          label: "Approve " + amount(total, payment),
          run: () => tx.transact("approve", payment.address, () => v2Approval(app, payment, total, funds[1])),
        };
        else button = {
          label: deal.delivery === NEW_VESTING ? "Settle and fund grant" : "Settle for immediate delivery",
          run: () => tx.transact("settle", config.contract, fillData(id)),
        };
      } else if (claimable && buyer) {
        button = { label: "Claim " + amount(grant.claimable, snapshot.base), run: () => tx.transact("claim", config.contract, claimData(deal.grantId)) };
      } else if (purchasable && !seller) {
        hint = "This wallet cannot settle. The deal is reserved for " + deal.buyer + ".";
      } else if (claimable) {
        hint = "Connect the beneficiary’s wallet to claim here.";
      }
      if (refundable && wallet?.chainId === config.chainId) {
        extra.push(secondary("v2-refund", "Refund allocation", () => tx.transact("refund", config.contract, cancelData(id))));
      }
    }
    if (stale && deal.status === "funded" && !expired) {
      extra.push(notice({ kind: "warn", text: "The fixed start passed before settlement. The seller can refund the deal." }));
    }
    const feedback = transactionStatus(config, tx).filter(Boolean);
    return button || hint || extra.length || feedback.length ? action({ button, hint, extra: [...extra, ...feedback] }) : null;
  }

  load();
  if (tx.state.pending) tx.resume();
  return {
    update: load,
    stop() {
      live = false;
      clearInterval(timer);
    },
  };
}
