import { approveExactly, explain, same, say, transact } from "./eth.js";
import {
  blockTag, brokerMoney, dealPhase, fundData, grantClaimData, linkPayload, readPayload,
  refundData, settleData, typedTerms,
} from "./v3.js";
import { fact, h, notice, show, span, transaction, utc } from "./ui.js";
import {
  addressText, brokerView, compare, copyControls, deliveryLabel, domainLabel,
  exactTerms, feeFacts, linkFor, panel, quoteAmount, statusPill, tokenWarning, walletButton, walletSummary,
} from "./v3-view.js";

const PENDING_HASH = /^0x[\da-f]{64}$/i;
const eventTitle = { funded: "Escrow funding", settled: "Settlement receipt", refunded: "Seller refund" };
const completeStatus = { fund: "funded", settle: "settled", refund: "refunded", claim: "settled" };
const stepName = { fund: "Funding escrow", settle: "Settling deal", refund: "Refunding allocation", claim: "Claiming vested tokens" };

function readPending(key) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key));
    if (PENDING_HASH.test(value?.hash) && /^0x[\da-f]{40}$/i.test(value.account) && Object.hasOwn(stepName, value.action)) return value;
  } catch {}
  return null;
}

function storePending(key, value) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {}
}

export function brokerDealPage(app, payload) {
  const { v3, chain } = app;
  document.title = "Private broker deal · otc.fam";
  let terms;
  try {
    terms = readPayload(payload, v3.domain);
  } catch (error) {
    app.main.replaceChildren(brokerView(null, panel(h("h1", {}, "Broker deal unavailable"), notice({ kind: "error", text: explain(error) }))));
    return { update() {}, stop() {} };
  }
  let stopped = false;
  let refreshing = false;
  let model = null;
  let readError = "";
  let message = null;
  let busy = false;
  let id;
  let treasury;
  let base;
  let quote;
  let latestHash;
  let focusAfterAction;
  let showExact = false;

  function render() {
    if (stopped) return;
    const { phase, status, grant, receipts = [], receiptError = "" } = model ?? {};
    const fees = brokerMoney(terms.quote, terms.brokerBps);
    const actions = actionView(phase, status, grant);
    const receipt = receipts.find((event) => event.kind === "settled");
    const summary = panel(
      h("span", { class: "eyeline" }, domainLabel(v3.domain)),
      h("div", { class: "card-head" }, h("h1", {}, "Private broker deal"), h("div", { role: "status" }, phase && statusPill(phase))),
      h("p", { class: "broker-delivery" }, deliveryLabel(terms)),
      compare(terms, base, quote),
      h("dl", { class: "broker-facts" },
        fact("Named seller", addressText(terms.seller)), fact("Designated buyer", addressText(terms.buyer)),
        fact("Expires", utc(terms.expiry)),
        terms.delivery !== 0n && fact("Vesting", terms.fixedStart ? `Starts ${utc(terms.fixedStart)}` : "Starts at settlement",
          h("span", { class: "block" }, `Cliff ${span(terms.cliffSeconds)} · Duration ${span(terms.durationSeconds)}`))),
      tokenWarning(),
      h("details", { open: showExact, ontoggle: (e) => {
        if (e.currentTarget.isConnected) showExact = e.currentTarget.open;
      } }, h("summary", {}, "Exact terms for signing"), exactTerms(terms, v3.domain, id)));

    const actionsPanel = panel(h("h2", { tabindex: "-1", testid: "broker-action-title" }, actions.heading),
      h("p", { class: "lead", testid: "broker-next" }, actions.hint),
      h("div", { class: "broker-stack" },
        h("div", { class: "broker-stack broker-feedback" },
          readError && notice({ kind: "error", text: readError }),
          receiptError && notice({ kind: "warn", text: receiptError }),
          message && notice(message)),
        h("div", { class: "broker-wallet-slot" }, walletButton(app, refresh, report, busy)),
        h("div", { class: "broker-stack broker-action-buttons" },
          actions.available.map(([action, label, secondary]) =>
            h("button", { type: "button", class: secondary ? "secondary" : "primary", testid: `broker-${action}`,
              disabled: busy || Boolean(readError), onclick: (event) => run(action, event.currentTarget) }, label))),
        h("button", { type: "button", class: "secondary", onclick: refresh }, "Refresh chain data")));

    const activity = receipts.length > 0 && panel(h("h2", {}, "Onchain activity"),
      h("ol", { class: "broker-events" }, receipts.map((event) => h("li", {}, h("strong", {}, eventTitle[event.kind]), txLine(event)))));
    show(app.main, brokerView(null, h("div", { class: "broker-columns" },
      summary,
      h("aside", { class: "broker-stack", "aria-label": "Payment and next step" },
        status !== "settled" && panel(h("h2", {}, "Payment on settlement"), feeFacts(fees, quote, terms, treasury)), actionsPanel)),
    status === "settled" && h("div", { class: "broker-columns" },
      receipt && receiptView(receipt, quote, grant),
      grant && grantView(grant, base)),
    h("div", { class: "broker-columns" }, activity,
      panel(h("h2", {}, "Share this deal"),
        h("p", { class: "lead" }, "Anyone with the link can view the terms. Share it only with the intended parties."),
        copyControls(linkFor(v3.domain, terms))))));

    if (focusAfterAction && model?.status === focusAfterAction.status && (focusAfterAction.target !== "broker-receipt-title" || receipt)) {
      const { target } = focusAfterAction;
      focusAfterAction = null;
      if (!app.main.contains(document.activeElement)) app.main.querySelector(`[data-testid="${target}"]`)?.focus();
    }
  }

  function actionView(phase, status, grant) {
    const account = app.wallet?.account;
    const correctChain = Boolean(account) && app.wallet.chainId === app.config.chainId;
    const seller = correctChain && same(account, terms.seller);
    const buyer = correctChain && same(account, terms.buyer);
    const available = [];
    if (!phase) return {
      heading: "Check deal status",
      hint: readError ? "Actions require a verified chain reading. The proposal is shown from the link." : "Reading the escrow and token details onchain.",
      available,
    };
    if (phase === "settled") {
      if (buyer && grant?.claimable > 0n) available.push(["claim", "Claim vested tokens"]);
      const hint = grant ? (walletSummary(app, terms.buyer) ?? "The buyer can claim tokens as they vest.") : "The allocation and payment were delivered.";
      return { heading: "Deal settled", hint, available };
    }
    if (phase === "refunded") return { heading: "Allocation refunded", hint: "The seller withdrew the allocation. The deal is closed.", available };
    if (phase === "nonce-used") return { heading: "A new link is needed", hint: "The seller used this nonce on another deal. This link can no longer be funded.", available };
    if (seller && status === "funded") available.push(["refund", "Refund allocation", phase !== "expired"]);
    if (phase === "expired") return {
      heading: "Deal expired",
      hint: status === "funded" ? "Settlement has closed. The named seller can refund the escrow." : "Funding has closed and no allocation is held.",
      available,
    };
    if (phase === "unfunded") {
      if (seller) available.push(["fund", "Sign and fund"]);
      return {
        heading: "Waiting for the seller",
        hint: `The buyer cannot settle until the named seller funds the full allocation. ${walletSummary(app, terms.seller) ?? "Review the exact terms before signing to fund."}`,
        available,
      };
    }
    if (buyer) available.unshift(["settle", "Sign and settle"]);
    return {
      heading: "Ready to settle",
      hint: `The full allocation is held in escrow. ${walletSummary(app, seller ? null : terms.buyer) ??
        (seller ? "You can refund it until settlement." : "Review the exact terms before signing to settle.")}`,
      available,
    };
  }

  function txLine(event) {
    return h("div", { class: "broker-tx" }, transaction(event.hash, app.explorer),
      h("span", { class: "hint" }, `Confirmed · Block ${event.block} · ${event.confirmations} confirmation${event.confirmations === 1 ? "" : "s"}`));
  }

  function receiptView(receipt, payment, grant) {
    const { buyerFee, sellerFee, brokerFee, treasuryFee } = receipt;
    const fees = { buyerFee, sellerFee, brokerFee, treasuryFee, buyerTotal: terms.quote + buyerFee, sellerNet: terms.quote - sellerFee };
    return panel(h("h2", { tabindex: "-1", testid: "broker-receipt-title" }, "Settlement receipt"),
      h("div", { testid: "broker-settlement-receipt", "data-tx": receipt.hash }, txLine(receipt),
        h("dl", { class: "broker-facts" },
          fact("Chain", domainLabel(v3.domain)), fact("Contract", addressText(v3.contract)),
          fact("Deal ID", addressText(id)), fact("Seller", addressText(terms.seller)),
          fact("Buyer", addressText(terms.buyer)), fact("Broker recipient", addressText(terms.broker)),
          fact("Quote token", addressText(terms.quoteToken)), fact("Base token", addressText(terms.baseToken)),
          fact("Agreed quote", quoteAmount(terms.quote, payment), h("span", { class: "block mono" }, `${terms.quote} raw units`)),
          fact("Delivery", `${quoteAmount(terms.allocation, base)} · ${deliveryLabel(terms)}`,
            receipt.grantId > 0n && h("span", { class: "block mono" }, `Grant #${receipt.grantId}`),
            grant && h("span", { class: "block mono" }, grant.custodian))),
        feeFacts(fees, payment, terms, treasury),
        h("details", {}, h("summary", {}, "Exact payment and fees in raw units"),
          h("dl", { class: "broker-facts" },
            fact("Buyer paid", String(fees.buyerTotal)), fact("Seller received", String(fees.sellerNet)),
            fact("Buyer fee", String(buyerFee)), fact("Seller fee", String(sellerFee)),
            fact("Broker received", String(brokerFee)), fact("Treasury received", String(treasuryFee))))));
  }

  function grantView(grant, token) {
    return panel(h("h2", {}, `Vesting grant #${grant.id}`),
      h("dl", { class: "broker-facts" },
        fact("Beneficiary", addressText(grant.beneficiary)), fact("Vault", addressText(grant.custodian)),
        fact("Allocation", quoteAmount(grant.allocation, token)), fact("Vault balance", quoteAmount(grant.held, token)),
        fact("Start", utc(grant.start)), fact("Cliff", utc(grant.cliff)), fact("Fully vested", utc(grant.end)),
        fact("Claimed", quoteAmount(grant.claimed, token)), fact("Available to claim", quoteAmount(grant.claimable, token))));
  }

  async function snapshot() {
    treasury ??= await v3.setup();
    id ??= await v3.id(terms);
    const { number, time } = await chain.block();
    const block = blockTag(number);
    const deal = await v3.deal(id, block);
    if (!deal.status) throw say("The broker contract returned an unknown status.");
    if (deal.status !== "unfunded" && linkPayload(v3.domain, deal.terms) !== linkPayload(v3.domain, terms)) {
      throw say("The terms in this link do not match the funded deal.");
    }
    const used = deal.status === "unfunded" && await v3.used(terms, block);
    const phase = dealPhase(deal.status, terms, time, used);
    let grant;
    if (deal.grantId > 0n) {
      const data = await v3.grant(deal.grantId, block);
      grant = { ...data, held: await chain.balanceOf(data.token, data.custodian, block) };
    }
    return { ...deal, phase, grant, number };
  }

  async function refresh() {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const [next, baseToken, quoteToken] = await Promise.all([
        snapshot(), chain.token(terms.baseToken).catch(() => null), chain.token(terms.quoteToken).catch(() => null),
      ]);
      base = baseToken;
      quote = quoteToken;
      readError = "";
      if (!base || !quote) readError = "Token details could not be verified. Amounts are shown in raw units and actions are paused.";
      const lastReceipts = model?.status === next.status ? model.receipts : [];
      model = { ...next, receipts: lastReceipts };
      if (model.status !== "unfunded") {
        try {
          model.receipts = await v3.receipts(id, model.number);
          if (!model.receipts.some((event) => event.kind === model.status)) {
            model.receiptError = "The latest event is not available from this RPC. Refresh to check its receipt.";
          }
        } catch {
          model.receiptError = "The RPC could not return transaction history. Refresh to try again.";
        }
      }
      if (!busy) void resume();
    } catch (error) {
      readError = explain(error);
    } finally {
      refreshing = false;
      render();
    }
  }

  function report(error) {
    message = error ? { kind: "error", text: explain(error) } : null;
    render();
  }

  function stage(text) {
    message = { kind: "info", text };
    render();
  }

  const pendingKey = () => `otc.fam/v3/pending/${v3.domain.chainId}/${v3.contract}/${id}`;

  async function resume() {
    const pending = readPending(pendingKey());
    if (!pending || pending.hash === latestHash) return;
    latestHash = pending.hash;
    busy = true;
    stage(`${stepName[pending.action]}. Checking the submitted transaction onchain.`);
    try {
      await chain.confirmed(pending.hash, pending.account, pending.nonce == null ? null : BigInt(pending.nonce));
      storePending(pendingKey(), null);
      stage(`${stepName[pending.action]} confirmed.`);
    } catch (error) {
      if (error.replaced || error.message.includes("failed on the chain")) storePending(pendingKey(), null);
      report(error);
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function run(action, button) {
    if (busy || stopped) return;
    const hadFocus = document.activeElement === button;
    busy = true;
    button.disabled = true;
    message = null;
    const expected = action === "fund" || action === "refund" ? terms.seller : terms.buyer;
    const wallet = app.wallet;

    async function guard() {
      if (stopped) throw say("Return to the deal before sending the next request.");
      const [account, chainId] = await Promise.all([
        wallet.provider.request({ method: "eth_accounts" }).then((accounts) => accounts[0]),
        wallet.provider.request({ method: "eth_chainId" }),
      ]);
      if (!same(account, expected)) throw say("Your wallet changed. Select the designated address and try again.");
      if (Number(chainId) !== app.config.chainId) throw say("Your wallet changed network. Switch it back, then try again.");
    }

    const context = { ...app, wallet: {
      account: expected,
      nonceOf: (hash) => wallet.nonceOf(hash),
      async send(tx) {
        await guard();
        return wallet.provider.request({ method: "eth_sendTransaction", params: [{ from: expected, ...tx }] });
      },
    } };
    let approved = false;
    try {
      await guard();
      const current = await snapshot();
      if (!actionView(current.phase, current.status, current.grant).available.some(([kind]) => kind === action)) {
        throw say("The latest chain state no longer permits this action.");
      }
      let data;
      if (action === "fund" || action === "settle") {
        const token = action === "fund" ? base : quote;
        const units = action === "fund" ? terms.allocation : brokerMoney(terms.quote, terms.brokerBps).buyerTotal;
        const [balance, allowance] = await Promise.all([
          chain.balanceOf(token.address, expected),
          chain.allowance(token.address, expected, v3.contract),
        ]);
        if (balance < units) throw say(`This wallet needs ${quoteAmount(units, token)} to continue.`);
        await guard();
        stage("Review and sign the exact terms in your wallet.");
        const signature = await wallet.provider.request({
          method: "eth_signTypedData_v4", params: [expected, JSON.stringify(typedTerms(v3.domain, terms))],
        });
        data = action === "fund" ? fundData(terms, signature) : settleData(id, signature);
        if (allowance < units) {
          await approveExactly(context, token, units, allowance, stage, v3.contract);
          approved = true;
        }
      } else {
        data = action === "refund" ? refundData(id) : grantClaimData(current.grant.id);
      }
      await transact(context, v3.contract, data, stage, stepName[action], (hash, nonce) => {
        latestHash = hash;
        storePending(pendingKey(), { action, account: expected, hash, nonce: nonce?.toString() ?? null });
      });
      storePending(pendingKey(), null);
      if (hadFocus) focusAfterAction = {
        status: completeStatus[action],
        target: action === "settle" ? "broker-receipt-title" : "broker-action-title",
      };
      stage(`${stepName[action]} confirmed.`);
    } catch (error) {
      if (error.replaced || error.message.includes("failed on the chain")) storePending(pendingKey(), null);
      message = { kind: "error", text: explain(error) + (approved ? " The token approval already confirmed." : "") };
    } finally {
      busy = false;
      render();
      await refresh();
    }
  }

  render();
  void refresh();
  addEventListener("focus", refresh);
  const timer = setInterval(refresh, 8000);
  return { update() { render(); void refresh(); }, stop() {
    stopped = true;
    clearInterval(timer);
    removeEventListener("focus", refresh);
  } };
}
