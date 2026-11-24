import { approveExactly, same, say, transact } from "./eth.js";
import { flow } from "./flow.js";
import { amount, card, fact, h, networkName, notice, show, TOKEN_WARNING, transaction, utc } from "./ui.js";
import { abi, claimable, digest, expiration, fees, isId, unpack } from "./broker-terms.js";
import { rememberDeal } from "./broker-store.js";
import { brokerError, signTerms } from "./broker.js";
import { brokerButton, brokerNav, deliveryText, errorText, heading, moneyFacts, mono, shareText, startText, tokenFacts, treasuryFact } from "./broker-ui.js";

const jump = (label, target) => h("button", { class: "broker-text-button", type: "button", onclick: () => {
  const section = document.getElementById(target);
  section?.scrollIntoView({ block: "start" });
  section?.focus({ preventScroll: true });
} }, label);

const refundWindow = "The seller can refund until settlement is mined, even while the buyer signs or approves payment.";
const raceNotice = (action, status) => {
  if (action === "Settlement" && status === "refunded") {
    return "The seller refunded the deal before settlement. No deal payment was taken. Ask the broker for a new deal link.";
  }
  if (action === "Refund" && status === "settled") {
    return "The buyer settled the deal before the refund. The allocation was delivered. View the settlement receipt.";
  }
  return null;
};

const withoutWallet = "Open this link in a browser with a wallet when you are ready to act.";

export function brokerDealPage(app, api, id, encoded) {
  document.title = "Broker deal preview · otc.fam";
  let shared;
  try {
    if (!isId(id)) throw say("This deal ID needs 0x and 64 hex digits. Ask for the full deal link.");
    if (encoded) {
      const { domain, terms } = unpack(encoded);
      if (digest(domain, terms) !== id) throw say("The terms in this link do not match the deal ID. Ask the broker for the original link.");
      if (domain.chainId !== api.domain.chainId || !same(domain.verifyingContract, api.contract)) {
        throw say(`This link is for BrokerDeals at ${domain.verifyingContract} on chain ${domain.chainId}. Open it on the site for that deployment.`);
      }
      shared = terms;
      rememberDeal(domain, terms, "seen");
    }
  } catch (e) {
    app.main.replaceChildren(h("div", { class: "broker-view" }, brokerNav(), heading("Deal link unavailable",
      "Check the link and its deployment before connecting."), card(notice({ kind: "error", text: errorText(e) }))));
    return { update() {}, stop() {} };
  }

  const s = { terms: shared };
  let active = true, turn = 0;
  const pending = flow({ app, s, key: `otc:v3:tx:${api.domain.chainId}:${api.contract}:${id}`, render, trackSent: true, settle: async (receipt, label) => {
    if (receipt?.transactionHash && !s.notice) s.notice = { kind: "success", text: `${label} confirmed in block ${Number(receipt.blockNumber)}.` };
    await refresh();
    const conflict = !s.problem && !receipt && s.notice?.kind === "error" && raceNotice(label, s.deal?.status);
    if (conflict) s.notice = { kind: "warn", text: conflict };
  } });

  async function refresh() {
    const run = ++turn;
    try {
      const block = await api.block();
      const deal = await api.deal(id, block.number);
      const terms = deal.terms ?? shared;
      if (!terms) throw say("The chain has no funded deal with this ID. Ask the broker for the full terms link.");
      const raw = (address) => ({ address, decimals: 0, symbol: "raw units" });
      const [base, quote, grant, receipts] = await Promise.all([
        app.chain.token(terms.baseToken).catch(() => raw(terms.baseToken)),
        app.chain.token(terms.quoteToken).catch(() => raw(terms.quoteToken)),
        deal.grantId ? api.grant(deal.grantId, block.number).catch(() => null) : null,
        deal.status === "unfunded" ? [] : (
          !s.problem && s.deal?.status === deal.status && s.block?.number === block.number && s.receipts
            ? s.receipts : api.receipts(deal, block.number).catch(() => null)),
      ]);
      if (!active || run !== turn) return;
      Object.assign(s, { deal, block, terms, base, quote, grant, receipts, problem: null });
    } catch (e) {
      if (!active || run !== turn) return;
      s.problem = errorText(e);
    }
    render();
  }

  function run(label, work) {
    if (!s.busy) pending.act(label, null, async (stage, sent) => {
      try { return await work(stage, sent); } catch (e) { throw brokerError(e, s.terms); }
    });
  }

  async function walletMatches(expected) {
    const wallet = app.wallet;
    const [accounts, chain] = await Promise.all([
      wallet.provider.request({ method: "eth_accounts" }), wallet.provider.request({ method: "eth_chainId" }),
    ]);
    if (!same(accounts[0], expected)) throw say(`This step requires wallet ${expected}. Switch to that account and try again.`);
    if (Number(chain) !== api.domain.chainId) throw say(`Your wallet is on chain ${Number(chain)}. Switch to chain ${api.domain.chainId} and retry.`);
  }

  function sendAction(verb, expected) {
    const terms = s.terms, grantId = s.deal.grantId;
    const title = { fund: "Funding", settle: "Settlement", refund: "Refund", claim: "Claim" }[verb];
    run(title, async (stage, sent) => {
      await walletMatches(expected);
      const guard = {
        account: expected,
        nonceOf: (hash) => app.wallet.nonceOf(hash),
        send: async (tx) => {
          await walletMatches(expected);
          return app.wallet.provider.request({ method: "eth_sendTransaction", params: [{ from: expected, ...tx }] });
        },
      };
      const scoped = { ...app, wallet: guard };
      let args = [verb === "claim" ? grantId : id];
      if (verb === "fund" || verb === "settle") {
        const funding = verb === "fund", token = funding ? s.base : s.quote;
        const required = funding ? terms.allocation : fees(terms.quote, terms.brokerBps).total;
        const balance = await app.chain.balanceOf(token.address, expected);
        if (balance < required) throw say(`Wallet ${expected} holds ${amount(balance, token)}. It needs ${amount(required, token)} to ${verb}.`);
        stage(`Review the exact terms in your wallet and sign as the ${funding ? "seller" : "buyer"}.`);
        const signature = await signTerms(app.wallet, api.domain, terms, expected);
        await walletMatches(expected);
        if (!funding) {
          const current = await api.deal(id, (await api.block()).number);
          const conflict = raceNotice(title, current.status);
          if (conflict) throw say(conflict);
        }
        const allowance = await app.chain.allowance(token.address, expected, api.contract);
        if (allowance < required) await approveExactly(scoped, token, required, allowance, stage, api.contract);
        args = [funding ? terms : id, signature];
      }
      return transact(scoped, api.contract, abi.encodeFunctionData(verb, args), stage, title, sent);
    });
  }

  function actionFor(status, expired, canClaim) {
    const { terms } = s, wallet = app.wallet, account = wallet?.account;
    const refund = s.deal?.status === "funded" && same(account, terms.seller);
    const expected = status === "unfunded" ? terms.seller : status === "funded" ? terms.buyer
      : status === "expired" && s.deal?.status === "funded" ? terms.seller : canClaim ? terms.buyer : null;
    if (!expected) return null;
    if (s.busy) return brokerButton(s.busy.label + "…", null, "primary-action");
    if (!wallet) return h("p", { class: "hint", testid: "no-wallet" }, withoutWallet);
    if (!account) return brokerButton("Connect wallet", () => run("Connect wallet", async () => wallet.connect()), "primary-action");
    if (status === "expired" && !refund) {
      return h("p", { class: "hint", role: "status" }, "This wallet has no action on the expired deal.");
    }
    if (wallet.chainId !== api.domain.chainId) {
      return h("div", { class: "broker-actions" }, notice({ kind: "warn",
        text: `Wallet is on ${networkName(wallet.chainId)} (chain ${wallet.chainId}). Switch to ${networkName(api.domain.chainId)} to act.` }),
      brokerButton(`Switch to ${networkName(api.domain.chainId)}`, () => run("Switch network", async () => wallet.switchTo(api.domain.chainId)), "primary-action"));
    }
    if (refund) return brokerButton("Refund allocation to seller", () => sendAction("refund", terms.seller), "refund-action", "secondary");
    if (!same(account, expected)) return notice({ kind: "warn", text: `Connected wallet ${account}. To act here, switch to ${expected}.` });
    if (status === "unfunded" && !expired) return brokerButton("Sign terms and fund", () => sendAction("fund", expected), "primary-action");
    if (status === "funded") return brokerButton("Sign terms and settle", () => sendAction("settle", expected), "primary-action");
    if (canClaim) return brokerButton("Claim vested tokens", () => sendAction("claim", expected), "primary-action");
    return null;
  }

  function grantCard() {
    const g = s.grant, available = claimable(g, s.block.time);
    return card(h("h2", {}, `Vesting grant #${s.deal.grantId}`),
      h("dl", { class: "facts broker-money" },
        fact("Originally funded", amount(g.allocation, s.base)), fact("Current vault balance", g.held === null ? "RPC unavailable" : amount(g.held, s.base)),
        fact("Claimable", h("span", { testid: "grant-claimable" }, amount(available, s.base))), fact("Claimed", h("span", { testid: "grant-claimed" }, amount(g.claimed, s.base))),
        fact("Start", utc(g.start)), fact("Cliff", utc(g.cliff)), fact("Fully vested", utc(g.end)),
        fact("Beneficiary", mono(g.beneficiary)), fact("Grant vault", mono(g.custodian))),
      g.held !== null && g.held < g.allocation - g.claimed && notice({ kind: "warn", text: "The vault balance is below the remaining allocation. Check the token before claiming." }),
      h("p", { class: "hint" }, "Only the designated beneficiary can claim. Claims pay no broker or treasury fee."));
  }

  function exactTerms(terms, base, quote, title) {
    return h("section", { class: "card broker-exact-terms", id: "broker-exact-terms", tabindex: "-1" },
      h("h2", {}, title), h("dl", { class: "facts broker-terms" },
        fact("Deal ID", mono(id)),
        fact("Network", `${networkName(api.domain.chainId)} · chain ${api.domain.chainId}`),
        fact("Verifying contract", mono(api.contract)),
        terms && [
          fact("Signing domain", `${api.domain.name} · version ${api.domain.version}`),
          fact("Seller", mono(terms.seller)), fact("Buyer", mono(terms.buyer)), fact("Broker", mono(terms.broker)), treasuryFact(app.config),
          ...tokenFacts(terms, base, quote), fact("Deadline", `${utc(terms.expiry)} · ${terms.expiry}`),
          fact("Seller nonce", mono(String(terms.nonce))), fact("Delivery mode", terms.delivery === 0n ? "0 · Immediate" : "1 · New vesting"),
          fact("Fixed start (raw seconds)", `${terms.fixedStart}${terms.delivery && !terms.fixedStart ? " · settlement time" : ""}`),
          fact("Cliff (seconds)", String(terms.cliffSeconds)), fact("Duration (seconds)", String(terms.durationSeconds)),
          fact("Broker share (bps)", String(terms.brokerBps)),
        ]));
  }

  function transactionProgress() {
    const busy = s.busy;
    return busy && [
      busy.hint && h("p", { class: "notice info", role: "status", testid: "wallet-step" }, busy.hint),
      busy.hash && h("dl", { class: "facts", testid: "pending-transaction" }, fact("Submitted transaction", transaction(busy.hash, app.explorer))),
      busy.retry && brokerButton("Check transaction again", pending.retry, "retry-transaction", "secondary"),
      busy.waiting && brokerButton("Stop waiting and refresh", () => pending.stopWaiting("Checking the current onchain state."), "stop-waiting", "secondary"),
    ];
  }

  async function recover() {
    await refresh();
    if (!s.problem) pending.retry();
  }

  function render() {
    if (!active) return;
    if (s.problem) {
      show(app.main, h("div", { class: "broker-view" }, brokerNav(),
        heading("Broker deal", "Live funding and payment details are unavailable.", "unverified"),
        h("div", { class: "broker-grid" },
          card(h("div", { class: "broker-actions" }, notice({ kind: "error", text: s.problem }),
            h("p", { class: "hint" }, "Refresh chain status to retry."),
            brokerButton("Refresh chain status", recover, "refresh-action", "secondary"),
            s.busy?.hash && transactionProgress())),
          exactTerms(shared ?? s.terms, null, null, shared ? "Deal terms from the link" : s.terms ? "Last read deal terms" : "Deal reference"))));
      return;
    }
    const { terms, base, quote, deal, block, grant } = s;
    const expired = terms && block ? expiration(terms, block.time) : "";
    const status = !deal ? "loading" : expired && ["unfunded", "funded"].includes(deal.status) ? "expired" : deal.status;
    const expected = status === "unfunded" ? ["Seller must fund", terms.seller] : status === "funded" ? ["Buyer can settle", terms.buyer]
      : status === "expired" && deal?.status === "funded" ? ["Seller can refund", terms.seller]
        : grant && claimable(grant, block.time) > 0n ? ["Beneficiary can claim", terms.buyer] : null;
    const closed = status === "expired" ? `${expired} Settlement is no longer possible. ${deal.status === "funded" ? "Only the seller can refund the allocation." : "The broker can prepare a new link with a new nonce."}` : null;
    const captions = {
      loading: "Reading the funding status from the chain.",
      unfunded: "The buyer can settle after the named seller funds the full allocation.",
      funded: "The full allocation is in escrow. The designated buyer can settle.",
      settled: "Payment and delivery confirmed onchain.",
      expired: closed,
      refunded: "The allocation returned to the seller. No fees were paid.",
    };
    const ready = terms && base && quote;
    const settlement = s.receipts?.find((entry) => entry.kind === "settled");
    const refunded = status === "refunded", settled = status === "settled";
    const closedWithoutSettlement = refunded || status === "expired";
    const allocationLabel = refunded ? "Returned to seller" : status === "expired"
      ? deal.status === "funded" ? "Still in escrow" : "Allocation in escrow"
      : settled ? deal.grantId ? "Funded into grant vault" : "Buyer received" : "Buyer receives";
    show(app.main, h("div", { class: "broker-view" }, brokerNav(), heading("Broker deal", captions[status], status),
      !ready ? card(h("p", { class: "hint", role: "status" }, "Reading funding and token details…"))
        : h("div", { class: `broker-grid broker-deal broker-layout-${status}` },
          card(h("div", { class: "broker-trade" },
            h("div", {}, h("p", {}, closedWithoutSettlement || settled ? "Buyer paid" : "Buyer pays"),
              h("strong", { testid: "headline-total" }, amount(closedWithoutSettlement ? 0n : terms.quote + fees(terms.quote, terms.brokerBps).buyerFee, quote))),
            h("div", {}, h("p", {}, allocationLabel),
              h("strong", {}, amount(status === "expired" && deal.status === "unfunded" ? 0n : terms.allocation, base)))),
          !closedWithoutSettlement && h("p", { class: "broker-delivery", testid: "delivery-plan" }, deliveryText(terms)),
          !closedWithoutSettlement && !settled && terms.delivery === 1n && h("p", { class: "hint" }, `Start · ${startText(terms)}`),
          !refunded && !settled && h("p", { class: "hint" }, `Deadline · ${utc(terms.expiry)}`),
          h("div", { class: "broker-actions" },
            expected && h("dl", { class: "facts" }, fact(expected[0], mono(expected[1]))),
            !closedWithoutSettlement && !settled && h("p", { class: "broker-warning" }, TOKEN_WARNING),
            status === "funded" && h("p", { class: "notice warn", testid: "refund-window" }, refundWindow),
            deal?.status === "settled" || deal?.status === "refunded"
              ? jump("View onchain receipts", "broker-receipts") : jump("Review exact terms", "broker-exact-terms"),
            actionFor(status, expired, Boolean(grant && claimable(grant, block.time) > 0n)),
            transactionProgress(),
            s.notice && notice(s.notice))),
          !closedWithoutSettlement && (!settled || settlement) && card(h("h2", {}, settlement ? "Confirmed payment split" : "Proposed payment split"),
            moneyFacts(terms, quote, settlement), h("p", { class: "hint" }, `Broker share · ${shareText(terms.brokerBps)}. Fees apply only when settlement succeeds.`)),
          exactTerms(terms, base, quote, ["settled", "refunded", "expired"].includes(status) ? "Agreed terms" : "Exact terms to sign"),
          deal?.status && deal.status !== "unfunded" && h("section", { class: "card broker-receipts", id: "broker-receipts", tabindex: "-1" }, h("h2", {}, "Onchain receipts"),
            h("p", { class: "hint" }, `${networkName(api.domain.chainId)} · chain ${api.domain.chainId} · BrokerDeals v3`),
            h("dl", { class: "facts" }, fact("Contract", mono(api.contract)), fact("Deal ID", mono(id))),
            !s.receipts?.length ? notice({ kind: "warn", text: "The RPC node did not return the deal logs. Refresh to recover transaction hashes." })
              : h("ol", { class: "receipts", testid: "receipts" }, s.receipts.map((entry) => h("li", { "data-kind": entry.kind, "data-tx": entry.hash },
                h("strong", {}, entry.kind === "funded" ? "Funding confirmed" : entry.kind === "settled" ? "Settlement confirmed" : "Refund confirmed"),
                h("p", { class: "hint" }, entry.kind === "funded" ? `${amount(terms.allocation, base)} ${deal.status === "funded" ? "in escrow" : "funded"} · no fees`
                  : entry.kind === "refunded" ? `${amount(terms.allocation, base)} returned to the seller · no fees`
                    : `${amount(terms.quote + entry.buyerFee, quote)} paid by the buyer · ${amount(terms.allocation, base)} ${entry.grantId ? `delivered to grant #${entry.grantId}` : "delivered to the buyer"}`),
                h("p", { class: "hint" }, `Block ${entry.block} · ${block.number - entry.block + 1} confirmation${block.number === entry.block ? "" : "s"}`),
                transaction(entry.hash, app.explorer))))),
          grant && grantCard(),
          Boolean(deal?.grantId) && !grant && card(notice({ kind: "warn", text: "The node has not returned the grant details. Refresh to check the beneficiary and vault." })),
          deal?.status === "settled" && !app.wallet?.account && grant && claimable(grant, block.time) === 0n
            && h("p", { class: "hint" }, "The beneficiary can connect when tokens become claimable."))));
  }
  function update() { render(); refresh(); }
  render();
  refresh();
  pending.resume(() => {});
  addEventListener("focus", update);
  const poll = setInterval(() => { if (!document.hidden) refresh(); }, 12_000);
  return { update, stop() { active = false; clearInterval(poll); removeEventListener("focus", update); pending.stop(); } };
}
