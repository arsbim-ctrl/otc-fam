import { approveExactly, broadcast, explain, same, say, word, ZERO_ADDRESS } from "./eth.js";
import {
  blockTag, brokerMoney, dealPhase, fundData, grantClaimData, linkPayload, readPayload,
  refundData, settleData, typedTerms, V3_TOPIC,
} from "./v3.js";
import { fact, h, notice, show, span, transaction, utc } from "./ui.js";
import {
  addressText, brokerView, compare, copyControls, deliveryLabel, domainLabel,
  exactTerms, feeFacts, linkFor, panel, quoteAmount, statusPill, tokenWarning, walletButton, walletSummary,
} from "./v3-view.js";

const PENDING_HASH = /^0x[\da-f]{64}$/i;
const eventTitle = { funded: "Escrow funding", settled: "Settlement receipt", refunded: "Seller refund" };
const completeStatus = { fund: "funded", settle: "settled", refund: "refunded", claim: "settled" };
const stepName = { approval: "Approving tokens", fund: "Funding escrow", settle: "Settling deal", refund: "Refunding allocation", claim: "Claiming vested tokens" };

const completionTopic = {
  fund: V3_TOPIC.BrokerDealFunded, settle: V3_TOPIC.BrokerDealSettled,
  refund: V3_TOPIC.BrokerDealRefunded, claim: V3_TOPIC.BrokerGrantClaimed,
};

function readPending(key) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key));
    if (PENDING_HASH.test(value?.hash) && /^0x[\da-f]{40}$/i.test(value.account) && Object.hasOwn(stepName, value.action)) {
      // Older records could use an estimated nonce. Only follow replacements using an exact one.
      return { ...value, nonce: value.to && /^\d+$/.test(value.nonce) ? value.nonce : null };
    }
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
  let refreshQueued = false;
  let model = null;
  let readError = "";
  let message = null;
  let busy = false;
  let id;
  let treasury;
  let base;
  let quote;
  let readingMetadata = false;
  let triedMetadata = false;
  let pending;
  let replacementReads = 0;
  let showExact = false;

  function render() {
    if (stopped) return;
    const { phase, status, grant, receipts = [], receiptError = "" } = model ?? {};
    const fees = brokerMoney(terms.quote, terms.brokerBps);
    const verified = Boolean(status && status !== "unfunded");
    const actions = actionView(phase, status, grant);
    const receipt = receipts.find((event) => event.kind === "settled");
    const summary = panel(
      h("span", { class: "eyeline" }, domainLabel(v3.domain)),
      h("div", { class: "card-head" }, h("h1", {}, "Private broker deal"), h("div", { role: "status" }, phase && statusPill(phase))),
      h("p", { class: "broker-delivery" }, deliveryLabel(terms)),
      compare(terms, base, quote, verified),
      h("dl", { class: "broker-facts" },
        fact("Named seller", addressText(terms.seller)), fact("Designated buyer", addressText(terms.buyer)),
        fact("Expires", utc(terms.expiry)),
        terms.delivery !== 0n && fact("Vesting", terms.fixedStart ? `Starts ${utc(terms.fixedStart)}` : "Starts at settlement",
          h("span", { class: "block" }, `Cliff ${span(terms.cliffSeconds)} · Duration ${span(terms.durationSeconds)}`))),
      tokenWarning(),
      h("details", { open: showExact, ontoggle: (e) => {
        if (e.currentTarget.isConnected) showExact = e.currentTarget.open;
      } }, h("summary", {}, "Exact terms for signing"), exactTerms(terms, v3.domain, id, { hasAllocation: verified || Boolean(base), hasQuote: verified || Boolean(quote) })));

    const actionsPanel = panel(h("h2", { tabindex: "-1", testid: "broker-action-title" }, actions.heading),
      h("p", { class: "lead", testid: "broker-next" }, actions.hint),
      h("div", { class: "broker-feedback" },
        h("div", { role: "alert", "aria-atomic": "true", testid: "broker-errors" },
          readError && h("p", { class: "notice error" }, readError),
          message?.kind === "error" && h("p", { class: "notice error" }, message.text)),
        h("div", { role: "status", "aria-atomic": "true" },
          triedMetadata && (!base || !quote) && h("p", { class: "notice warn", testid: "broker-metadata" },
            "Token display details are unavailable. Verified amounts may appear in raw units. Funding and settlement require both tokens’ display details."),
          receiptError && h("p", { class: "notice warn" }, receiptError),
          message?.kind === "info" && h("p", { class: "notice info" }, message.text))),
      h("div", { class: "broker-stack" },
        h("div", { class: "broker-pending-slot" }, pending && h("p", { class: "hint broker-pending", testid: "broker-pending" },
          "Submitted transaction ", transaction(pending.hash, app.explorer), ". Sending is paused while its outcome is unknown.")),
        h("div", { class: "broker-wallet-slot" }, walletButton(app, refresh, report, busy)),
        h("div", { class: "broker-stack broker-action-buttons" },
          actions.available.map(([action, label, secondary]) =>
            h("button", { type: "button", class: secondary ? "secondary" : "primary", testid: `broker-${action}`,
              "aria-disabled": blocked(action) ? "true" : null, onclick: () => run(action) }, label))),
        h("button", { type: "button", class: "secondary", testid: "broker-refresh", onclick: () => refresh(true) },
          pending ? "Check transaction" : "Refresh chain data")));

    const focusedAction = document.activeElement?.closest(".broker-action-buttons") ? document.activeElement.dataset.testid : null;
    const activity = receipts.length > 0 && panel(h("h2", {}, "Onchain activity"),
      h("ol", { class: "broker-events" }, receipts.map((event) => h("li", {}, h("strong", {}, eventTitle[event.kind]), txLine(event)))));
    show(app.main, brokerView(null, h("div", { class: "broker-columns" },
      summary,
      h("aside", { class: "broker-stack", "aria-label": "Payment and next step" },
        h("div", { class: "broker-payment-slot" },
          status !== "settled" && panel(h("h2", {}, "Payment on settlement"), feeFacts(fees, quote, terms, treasury, verified))),
        actionsPanel)),
    status === "settled" && h("div", { class: "broker-columns" },
      receipt && receiptView(receipt, quote, grant),
      grant && grantView(grant, base)),
    h("div", { class: "broker-columns" }, activity,
      panel(h("h2", {}, "Share this deal"),
        h("p", { class: "lead" }, "Anyone with the link can view the terms. Share it only with the intended parties."),
        copyControls(linkFor(v3.domain, terms))))));
    if (focusedAction && document.activeElement?.dataset.testid !== focusedAction) {
      (app.main.querySelector(`[data-testid="${CSS.escape(focusedAction)}"]`) ??
        app.main.querySelector('[data-testid="broker-refresh"]'))?.focus({ preventScroll: true });
    }
  }

  function blocked(action) {
    return stopped || busy || Boolean(pending || readError) ||
      ((action === "fund" || action === "settle") && (!base || !quote));
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
    const [verifiedTreasury, { number, time }] = await Promise.all([v3.setup(), chain.block()]);
    treasury = verifiedTreasury;
    if (!Number.isSafeInteger(number) || number < 0 || !Number.isSafeInteger(time) || time <= 0) {
      throw say("The RPC could not verify the current block.");
    }
    const block = blockTag(number);
    const deal = await v3.deal(id, block);
    if (!deal.status) throw say("The broker contract returned an unknown status.");
    if (deal.status !== "unfunded" && linkPayload(v3.domain, deal.terms) !== linkPayload(v3.domain, terms)) {
      throw say("The terms in this link do not match the funded deal.");
    }
    const used = deal.status === "unfunded" && await v3.used(terms, block);
    const phase = dealPhase(deal.status, terms, time, used);
    let grant;
    if ((deal.status === "settled" && terms.delivery === 1n) !== (deal.grantId > 0n)) {
      throw say("The deal’s delivery and grant ID do not match.");
    }
    if (deal.grantId > 0n) {
      const data = await v3.grant(deal.grantId, block);
      if (deal.status !== "settled" || !same(data.token, terms.baseToken) || !same(data.beneficiary, terms.buyer) ||
          same(data.custodian, ZERO_ADDRESS) || data.allocation !== terms.allocation || data.claimed + data.claimable > data.allocation) {
        throw say("The grant does not match the verified deal.");
      }
      const held = await chain.balanceOf(data.token, data.custodian, block);
      if (held < data.claimable) throw say("The verified grant balance is smaller than the claimable amount.");
      grant = { ...data, held };
    }
    return { ...deal, phase, grant, number };
  }

  async function readTokenDetails() {
    if (readingMetadata || (base && quote)) return;
    readingMetadata = true;
    [base, quote] = await Promise.all([
      base || chain.token(terms.baseToken).catch(() => null),
      quote || chain.token(terms.quoteToken).catch(() => null),
    ]);
    readingMetadata = false;
    triedMetadata = true;
    render();
  }

  async function refresh(requested = false) {
    if (stopped) return;
    if (refreshing) {
      if (requested === true) refreshQueued = true;
      return;
    }
    refreshing = true;
    try {
      if (!id) {
        id = await v3.id(terms);
        pending = readPending(pendingKey());
      }
      void readTokenDetails();
      const next = await snapshot();
      readError = "";
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
      if (!busy && pending) await checkPending(model);
    } catch (error) {
      readError = `Deal state could not be verified. Actions are paused. ${explain(error)}`;
    } finally {
      refreshing = false;
      render();
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
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

  function recordPending(value) {
    pending = value;
    storePending(pendingKey(), value);
  }

  function finishPending(kind, text) {
    if (stopped) return;
    recordPending(null);
    replacementReads = 0;
    message = { kind, text };
  }

  async function receiptMatches(receipt, tx, grantId) {
    if (!same(receipt.transactionHash, tx.hash) || !same(receipt.from, tx.account) ||
        !same(receipt.to, tx.to ?? v3.contract)) return false;
    if (receipt.status === "0x0") return true;
    if (tx.action === "approval") {
      const sent = await chain.rpc("eth_getTransactionByHash", [tx.hash]);
      return same(sent?.hash, tx.hash) && same(sent.from, tx.account) && same(sent.to, tx.to) &&
        same(sent.input, tx.approvalData) && same(sent.blockHash, receipt.blockHash);
    }
    const subject = tx.action === "claim" && (tx.grantId || grantId) ? `0x${word(tx.grantId || grantId)}` : id;
    return receipt.logs?.some((log) => same(log.address, v3.contract) &&
      same(log.topics[0], completionTopic[tx.action]) && same(log.topics[1], subject));
  }

  async function checkPending(current) {
    const tx = pending;
    const expectedStatus = completeStatus[tx.action];
    const event = !current.receiptError && current.receipts?.find((item) =>
      item.kind === expectedStatus && same(item.hash, tx.hash));
    if (event) {
      finishPending("info", `${stepName[tx.action]} confirmed.`);
      return;
    }
    // Claims can repeat, so the deal's Settled status never resolves a claim.
    const reflected = tx.action === "fund" ? current.status !== "unfunded"
      : (tx.action === "refund" || tx.action === "settle") && ["refunded", "settled"].includes(current.status);
    try {
      const receipt = await chain.rpc("eth_getTransactionReceipt", [tx.hash]);
      if (receipt) {
        if (!["0x0", "0x1"].includes(receipt.status) || !await receiptMatches(receipt, tx, current.grant?.id)) {
          throw say("The receipt does not match this action.");
        }
        if (Number(receipt.blockNumber) > current.number) {
          message = { kind: "info", text: "The receipt is available. Waiting for the deal state to reach the receipt’s block." };
          return;
        }
        if (receipt.status === "0x1") finishPending("info", `${stepName[tx.action]} confirmed.`);
        else finishPending("error", "The submitted transaction failed onchain. Check the current deal before trying again.");
        return;
      }
      if (reflected) {
        finishPending("info", "The deal has advanced onchain. The submitted hash is still unconfirmed.");
        return;
      }
      replacementReads = await chain.overtaken(tx.hash, tx.account, pending.nonce === null ? null : BigInt(pending.nonce))
        ? replacementReads + 1 : 0;
      if (replacementReads >= 3) {
        finishPending("info", "The wallet used this transaction’s nonce for another transaction. The deal shows the latest verified chain state.");
        return;
      }
      message = { kind: "info", text: "The submitted transaction has no receipt yet. Check its status again or use your wallet’s activity." };
    } catch (error) {
      replacementReads = 0;
      if (reflected) finishPending("info", "The deal has advanced onchain. The submitted hash is still unconfirmed.");
      else report(say(`The submitted transaction could not be checked. ${explain(error)} Use Check transaction to retry.`));
    }
  }

  async function run(action) {
    if (blocked(action)) return;
    busy = true;
    message = null;
    render();
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
    async function sendTracked(context, to, data, showStage, label, kind, grantId) {
      const { hash } = await broadcast(context, to, data, showStage, label);
      const record = { action: kind, account: expected, hash, to, nonce: null,
        ...(grantId && { grantId: grantId.toString() }),
        ...(kind === "approval" && { approvalData: data }),
      };
      recordPending(record);
      replacementReads = 0;
      showStage(`${label}. Waiting for confirmation.`);
      void wallet.nonceOf(hash).then((nonce) => {
        if (!stopped && nonce !== null && same(pending?.hash, hash)) recordPending({ ...pending, nonce: String(nonce) });
      }).catch(() => {});
      return record;
    }

    async function approveAndConfirm(context, to, data, showStage, label) {
      const tx = await sendTracked(context, to, data, showStage, label, "approval");
      const receipt = await chain.receipt(tx.hash, tx.account);
      if (!await receiptMatches(receipt, tx)) throw say("The receipt does not match this token approval.");
      if (stopped) throw say("Return to the deal to continue.");
      if (receipt.status === "0x0") {
        recordPending(null);
        throw say("The submitted token approval failed onchain.");
      }
      if (receipt.status !== "0x1") throw say("The token approval status could not be verified.");
      recordPending(null);
    }

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
          await approveExactly(context, token, units, allowance, stage, v3.contract, approveAndConfirm);
          approved = true;
        }
      } else {
        data = action === "refund" ? refundData(id) : grantClaimData(current.grant.id);
      }
      await sendTracked(context, v3.contract, data, stage, stepName[action], action, current.grant?.id);
    } catch (error) {
      message = { kind: "error", text: (pending ? "The submitted transaction could not be checked. " : "") + explain(error) +
        (pending ? " Use Check transaction to retry." : "") + (approved ? " The token approval already confirmed." : "") };
    } finally {
      busy = false;
      render();
      await refresh(true);
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
