import { abi, authorize, dealState, payment, unpack } from "./v3.js";
import { approveExactly, explain, same, say, transact } from "./eth.js";
import { card, fact, h, leg, notice, transaction, utc } from "./ui.js";
import {
  actionButton, copyLink, createHref, deliveryText, displayNetwork, emptyPage, feeFacts, heading, listenForUpdates,
  mono, nav, percent, problem, rawTerms, readTokens, section, showBroker, statePill, tokenWarning, valueOf,
} from "./v3-common.js";

const failures = {
  InvalidAuthorization: "This signature does not authorize the exact terms for this wallet and network. Review the terms and sign again.",
  NotFunded: "The deal needs seller funding before it can settle.",
  DealExpired: "The deadline has passed. A funded allocation can still be refunded by the seller.",
  StartPassed: "The fixed vesting start has passed. A funded allocation can still be refunded by the seller.",
  NonceUsed: "This seller nonce was used for another authorization. Ask the broker for a fresh link.",
  NotSeller: "Only the named seller can fund or refund this deal.",
  NotBuyer: "Only the designated buyer can settle this deal.",
  BadParties: "Use three different wallets for broker, seller and buyer.",
  BadBroker: "Check the recipient and percentage of the broker’s fee.",
  BadTokens: "Compare both token contracts with the agreed addresses.",
  BadAmounts: "Both amounts must be positive and the quote plus fees must fit onchain.",
  BadSchedule: "Check the vesting start and the cliff and duration.",
};

function describe(error) {
  const data = [error?.data, error?.data?.data, error?.data?.originalError?.data].find(value => typeof value === "string");
  try {
    const name = data && abi.parseError(data)?.name;
    if (failures[name]) return failures[name];
  } catch { /* The existing wallet error handler covers the common token and RPC errors. */ }
  return explain(error);
}

function receiptCard(app, state, id) {
  const { data, receipts } = state;
  const { terms, treasury, block, base, quote, grant } = data;
  const descriptions = {
    BrokerDealFunded: `Seller escrowed ${valueOf(terms.allocation, base)}. No fees were paid.`,
    BrokerDealSettled: grant ? `Funded grant for the buyer with ${valueOf(terms.allocation, base)}.`
      : `Delivered ${valueOf(terms.allocation, base)} directly to the buyer.`,
    BrokerDealRefunded: `Seller withdrew the escrowed ${valueOf(terms.allocation, base)}. No fees were paid.`,
  };
  return section("Onchain receipts",
    h("dl", { class: "facts broker-scope" },
      fact("Network", displayNetwork(app.v3.domain.chainId)),
      fact("V3 verifying contract", mono(app.v3.contract)),
      fact("Deal ID", mono(id)),
      fact("Seller", mono(terms.seller)),
      fact("Buyer", mono(terms.buyer)),
      fact("Broker", mono(terms.broker)),
      fact("Base token", mono(terms.baseToken)),
      fact("Payment token", mono(terms.quoteToken))),
    receipts === null && h("p", { class: "hint" }, "The RPC could not return this deal’s events. Refresh to try the receipt lookup again."),
    receipts?.length === 0 && h("p", { class: "hint" }, "No events were found for this deal at the latest block."),
    receipts?.length > 0 && h("ol", { class: "receipts" }, receipts.map(event => {
      const names = { BrokerDealFunded: "Funding", BrokerDealSettled: "Settlement", BrokerDealRefunded: "Refund", BrokerGrantClaimed: "Claim" };
      const depth = block.number - event.block + 1;
      const settled = event.name === "BrokerDealSettled";
      return h("li", { "data-kind": event.name, "data-tx": event.hash, testid: settled ? "broker-settlement-receipt" : null },
        h("strong", {}, names[event.name]), h("span", {}, event.name === "BrokerGrantClaimed"
          ? `The beneficiary claimed ${valueOf(event.amount, base)}. No fees were paid.`
          : descriptions[event.name]),
        h("span", { class: "when" }, `Block ${event.block} · ${depth} confirmation${depth === 1 ? "" : "s"}`),
        transaction(event.hash, app.explorer, `broker-receipt-${event.hash}-${event.name}`),
        settled && feeFacts(payment(terms, event), quote, treasury),
        settled && event.grantId !== 0n && h("dl", { class: "facts" }, fact("Grant ID", mono(event.grantId)),
          grant && fact("Grant vault", mono(grant.custodian))));
    })));
}

function grantCard(data) {
  const { grant, grantId, base } = data;
  return section("Vesting grant",
    h("dl", { class: "facts broker-scope", testid: "broker-grant" },
      fact("Grant ID", mono(grantId)),
      fact("Beneficiary", mono(grant.beneficiary)),
      fact("Grant vault", mono(grant.custodian)),
      fact("Allocation", valueOf(grant.allocation, base)),
      fact("Vault balance", h("span", { testid: "broker-vault-balance" }, grant.held === null ? "Unavailable" : valueOf(grant.held, base))),
      fact("Starts", utc(grant.start)), fact("Cliff", utc(grant.cliff)), fact("Ends", utc(grant.end)),
      fact("Claimed", h("span", { testid: "broker-claimed" }, valueOf(grant.claimed, base))),
      fact("Claimable now", h("span", { testid: "broker-claimable" }, valueOf(grant.claimable, base)))));
}

function settleReason({ state, status, terms }) {
  if (state === "awaiting") return "The seller must escrow the full allocation before the buyer can settle.";
  if (state === "unavailable") return "The seller’s nonce has already been used. The broker can duplicate the terms with a fresh nonce.";
  if (state === "expired") return status === 1
    ? "Settlement has closed at the deadline or fixed vesting start. The seller can refund the escrow."
    : "The deadline or fixed vesting start has passed. No allocation was escrowed for this link.";
  if (state === "refunded") return "The seller withdrew the escrow. This deal cannot settle.";
  if (state === "settled") return "The payment, fees and delivery were executed together onchain.";
  return `Settlement requires the designated buyer ${terms.buyer}.`;
}

export function brokerDealPage(app, packed) {
  const { main, chain, v3, wallet } = app;
  document.title = "Broker deal · otc.fam";
  let proposal;
  try {
    proposal = unpack(packed);
    if (proposal.domain.chainId !== v3.domain.chainId || !same(proposal.domain.verifyingContract, v3.contract)) {
      throw say(`This link is for chain ${proposal.domain.chainId} and contract ${proposal.domain.verifyingContract}. Wallet actions require that site deployment.`);
    }
  } catch (error) {
    main.replaceChildren(card(nav(), heading("Broker deal"), problem(explain(error))));
    return emptyPage;
  }

  const { id, domain, terms } = proposal;
  const link = location.href;
  const key = `otcfam:v3:pending:${domain.chainId}:${v3.contract}:${id}`;
  const created = app.createdBrokerDeal?.id === id ? app.createdBrokerDeal : null;
  app.createdBrokerDeal = null;

  let stopped = false, refreshing = false, queued = false, fresh = false;
  let data = null, receipts = [], readError = "", progress = "", message = null, busy = false;
  let pending = restorePending();
  const stopWatching = listenForUpdates(() => update());
  render();
  void refresh();

  function restorePending() {
    try {
      const record = JSON.parse(sessionStorage.getItem(key));
      if (record && /^0x[\da-f]{64}$/i.test(record.hash) && [terms.seller, terms.buyer].some(a => same(a, record.from))) {
        // Earlier V3 records could contain an estimated nonce. The hash still identifies the broadcast.
        const nonce = record.nonceVerified === true && /^[0-9]+$/.test(record.nonce) ? BigInt(record.nonce) : null;
        return { hash: record.hash, from: record.from, nonce };
      }
    } catch { /* Wallet and chain reconciliation also works without session storage. */ }
    return null;
  }

  function remember(record) {
    pending = record;
    try {
      if (record) {
        const { hash, from, nonce } = record;
        sessionStorage.setItem(key, JSON.stringify({ hash, from, nonce: nonce?.toString() ?? null, nonceVerified: nonce !== null }));
      } else sessionStorage.removeItem(key);
    } catch { /* The current page still tracks the hash. */ }
  }

  function clear(record) {
    if (pending !== record) return;
    fresh = false;
    remember(null);
  }

  function replacementObserved(record) {
    if (stopped || record.checking || record.observations >= 3) return !stopped && record.observations >= 3;
    record.checking = true;
    void (async () => {
      const { hash, from } = record;
      const tx = await chain.rpc("eth_getTransactionByHash", [hash]);
      if (pending !== record || stopped) return;
      if (tx !== null) {
        const matches = same(tx?.hash, hash) && same(tx.from, from) && /^0x[0-9a-f]+$/i.test(tx.nonce);
        const nonce = matches ? BigInt(tx.nonce) : null;
        if (matches && record.nonce === null) {
          record.nonce = nonce;
          remember(record);
        }
        if (!matches || nonce !== record.nonce || tx.blockNumber != null) {
          record.observations = 0;
          return;
        }
      }
      // Account count is evidence only after an exact nonce was observed for this hash and sender.
      const displaced = record.nonce !== null && BigInt(await chain.rpc("eth_getTransactionCount", [from, "latest"])) > record.nonce;
      record.observations = displaced ? (record.observations ?? 0) + 1 : 0;
    })().catch(() => { record.observations = 0; }).finally(() => { record.checking = false; });
    return false;
  }

  async function followPending() {
    const record = pending;
    if (!record || busy) return;
    const receipt = await chain.rpc("eth_getTransactionReceipt", [record.hash]);
    if (pending !== record || busy || stopped) return;
    if (same(receipt?.transactionHash, record.hash) && (receipt.status === "0x1" || receipt.status === "0x0")) {
      clear(record);
      if (receipt.status === "0x0") message = { kind: "error", text: "The transaction reverted. The page has checked the deal again." };
    } else if (replacementObserved(record)) {
      clear(record);
      message = { kind: "warn", text: "Your wallet replaced the transaction. The latest onchain state is shown below." };
    }
  }

  async function confirmBroadcast(hash, from) {
    const record = { hash, from, nonce: null };
    remember(record);
    stage("");
    try {
      const receipt = await chain.confirmed(hash, from, null, () => replacementObserved(record));
      if (!stopped) clear(record);
      return receipt;
    } catch (error) {
      if (!stopped && (error?.replaced || error?.reverted)) clear(record);
      throw error;
    }
  }

  function actionOwner(current) {
    if (current.state === "awaiting") return same(wallet?.account, current.terms.seller) ? "fund" : null;
    if (current.status === 1) {
      if (same(wallet?.account, current.terms.seller)) return "refund";
      if (current.state === "funded" && same(wallet?.account, current.terms.buyer)) return "settle";
    }
    if (current.grant && same(wallet?.account, current.grant.beneficiary)) return "claim";
    return null;
  }

  async function refresh() {
    if (stopped) return;
    if (refreshing) {
      queued = true;
      return;
    }
    refreshing = true;
    try {
      await followPending();
      const block = await v3.block();
      const proposalData = await v3.readProposal(proposal, block.number);
      const current = {
        ...proposalData, block,
        state: dealState(proposalData.status, proposalData.terms, block.time, proposalData.used),
      };
      const [assets, grant, events] = await Promise.all([
        readTokens(chain, proposalData.terms),
        proposalData.grantId === 0n ? null : v3.grant(proposalData.grantId, block.number),
        proposalData.status === 0 ? [] : v3.receipts(id, block.number, proposalData.grantId).catch(() => null),
      ]);
      [current.base, current.quote] = assets;
      current.grant = grant;
      const actor = actionOwner(current);
      const account = wallet?.account;
      if (actor === "fund" || actor === "settle") {
        const token = actor === "fund" ? current.base : current.quote;
        const need = actor === "fund" ? current.terms.allocation : payment(current.terms).buyerTotal;
        const [held, allowance] = await Promise.all([
          chain.balanceOf(token.address, account), chain.allowance(token.address, account, v3.contract),
        ]);
        current.check = { token, need, held, allowance, account, actor };
      }
      data = current;
      receipts = events;
      fresh = true;
      readError = "";
    } catch (error) {
      fresh = false;
      readError = pending ? "The submitted transaction is still being tracked. Try refreshing again." : describe(error);
    } finally {
      refreshing = false;
      if (!stopped) render();
      if (queued) {
        queued = false;
        void refresh();
      }
    }
  }

  function update() {
    if (stopped) return;
    render();
    void refresh();
  }

  async function run(task) {
    if (busy || pending) return;
    busy = true;
    message = null;
    try {
      await task();
    } catch (error) {
      message = pending
        ? { kind: "warn", text: "The submitted transaction is still being tracked. Use Refresh from chain to check its status." }
        : { kind: error?.replaced ? "warn" : "error", text: describe(error) };
    } finally {
      busy = false;
      progress = "";
      if (!stopped) {
        render();
        void refresh();
      }
    }
  }

  function stage(text) {
    progress = text;
    if (!stopped) render();
  }

  async function send(kind, check, from) {
    await wallet.readChain();
    if (wallet.chainId !== Number(domain.chainId) || !same(wallet.account, from)) {
      throw say("The wallet changed. Connect the designated wallet on the deal’s network and try again.");
    }
    const block = await v3.block();
    const latest = await v3.readProposal(proposal, block.number);
    const status = dealState(latest.status, latest.terms, block.time, latest.used);
    if ((kind === "fund" && status !== "awaiting") || (kind === "settle" && status !== "funded")
        || (kind === "refund" && latest.status !== 1) || (kind === "claim" && latest.grantId === 0n)) {
      throw say("The deal’s onchain state changed. Review the latest state and available actions.");
    }

    const track = hash => confirmBroadcast(hash, from);
    if (check && check.allowance < check.need) {
      await approveExactly(app, check.token, check.need, check.allowance, stage, v3.contract, from, undefined, track);
    } else {
      let args = [kind === "claim" ? latest.grantId : id];
      if (kind === "fund" || kind === "settle") {
        stage(`Review and sign the exact deal terms in your ${kind === "fund" ? "seller" : "buyer"} wallet.`);
        const signature = await authorize(wallet, domain, latest.terms, from);
        args = [kind === "fund" ? latest.terms : id, signature];
      }
      const wording = { fund: "Funding deal", settle: "Settling deal", refund: "Refunding escrow", claim: "Claiming vested tokens" };
      await transact(app, v3.contract, abi.encodeFunctionData(kind, args), stage, wording[kind],
        undefined, from, track);
    }
    fresh = false;
  }

  function actions() {
    if (!data) return null;
    const current = data;
    const owner = actionOwner(current);
    const noMore = (current.status > 1 && !current.grant) || current.state === "unavailable"
      || (current.state === "expired" && current.status === 0);
    const needs = {
      awaiting: ["Seller", current.terms.seller], funded: ["Buyer", current.terms.buyer],
      expired: ["Seller", current.terms.seller], settled: ["Beneficiary", current.grant?.beneficiary],
    }[current.state];
    const disabled = busy || Boolean(pending) || !fresh;
    const button = (label, task, id = "broker-primary", off = false, style = "primary") =>
      actionButton(id, label, () => run(task), disabled || off, style);
    let controls;
    if (!noMore && !wallet) {
      controls = h("p", { class: "hint" }, "Wallet-free preview. Open this link in a browser with the required wallet to act.");
    } else if (!noMore && !wallet.account) {
      controls = button("Connect wallet", async () => { stage("Confirm the connection in your wallet."); await wallet.connect(); });
    } else if (!noMore && wallet.chainId !== Number(domain.chainId)) {
      controls = [h("p", { class: "hint" }, "Your wallet is on another network. This deal’s actions require the network above."),
        button(`Switch to ${displayNetwork(domain.chainId)}`, async () => { stage("Confirm the switch in your wallet."); await wallet.switchTo(Number(domain.chainId)); })];
    } else if (owner === "fund" || owner === "settle") {
      const check = current.check;
      if (check?.actor === owner && same(check?.account, wallet.account)) {
        const label = check.allowance < check.need ? `Approve ${valueOf(check.need, check.token)}`
          : owner === "fund" ? "Sign and fund deal" : "Sign and settle deal";
        controls = [h("p", { class: `hint${check.held < check.need ? " held bad" : ""}` },
          `This wallet holds ${valueOf(check.held, check.token)}. This action requires ${valueOf(check.need, check.token)}.`),
        button(label, () => send(owner, check, check.account), "broker-primary", check.held < check.need)];
      } else {
        controls = h("p", { class: "hint" }, "Checking the designated wallet’s balance and allowance…");
      }
    } else if (owner === "refund") {
      const from = wallet.account;
      controls = button("Refund escrow", () => send("refund", null, from), "broker-refund", false, "secondary");
    } else if (owner === "claim") {
      const from = wallet.account;
      controls = button("Claim vested tokens", () => send("claim", null, from), "broker-claim", current.grant.claimable === 0n);
    } else if (!noMore) {
      controls = h("p", { class: "hint" }, "This wallet can inspect the deal. Switch accounts in your wallet to take an available action.");
    }
    return h("div", { class: "broker-actions" },
      h("p", { class: "lead", testid: "broker-status-reason" }, settleReason(current)),
      !noMore && needs?.[1] && h("p", { class: "hint" }, `${needs[0]} wallet required `, mono(needs[1])),
      // Reserve the action region so wallet requests and refreshes leave the focused control in place.
      h("div", { class: "action" }, controls),
      h("div", { class: "broker-message" }, progress && notice({ kind: "info", text: progress }),
        pending && h("p", { class: "notice info", role: "status" }, "Submitted · awaiting network confirmation ", transaction(pending.hash, app.explorer, "broker-pending-transaction")),
        message && notice(message)));
  }

  function render() {
    if (stopped) return;
    const t = data?.terms ?? terms;
    const base = data?.base ?? { address: t.baseToken, decimals: null };
    const quote = data?.quote ?? { address: t.quoteToken, decimals: null };
    const tokenLeg = (label, units, token, side) => token.decimals == null
      ? h("div", { class: "leg" }, fact(label, `${units} raw units`, h("span", { class: "block mono" }, token.address)))
      : leg(label, units, token, side);
    showBroker(main, h("div", { class: "broker-layout" },
      nav(),
      card(h("div", { class: "card-head" }, heading("Private broker deal"), data && statePill(data.state)),
        created && h("p", { class: "delivery", role: "status" }, created.saved
          ? "Link created and saved to broker history in this browser."
          : "Link created. Copy it now to keep a record in case browser storage is unavailable."),
        h("div", { class: "broker-legs" },
          tokenLeg("Buyer receives", t.allocation, base, "brok-allocation"),
          tokenLeg("Buyer pays including fee", payment(t).buyerTotal, quote, "brok-payment")),
        h("p", { class: "delivery", testid: "broker-delivery" }, deliveryText(t)),
        tokenWarning(),
        h("dl", { class: "facts broker-scope" },
          fact("Seller", mono(t.seller)), fact("Buyer", mono(t.buyer)), fact("Broker", mono(t.broker)),
          fact("Deadline", utc(t.expiry)), fact("Network", displayNetwork(domain.chainId)),
          fact("V3 verifying contract", mono(v3.contract)), fact("Deal ID", mono(id, "broker-deal-id"))),
        h("div", {}, readError && problem(`Could not refresh chain data. ${readError}`),
          !data && !readError && h("p", { class: "hint", role: "status" }, "Reading the deal’s onchain status…")),
        h("div", { class: "broker-link-actions" }, copyLink(link),
          h("a", { class: "button secondary", href: createHref(domain, t), testid: "broker-duplicate" }, "Duplicate terms"),
          actionButton("broker-refresh", "Refresh from chain", refresh, false, "secondary"))),
      section("Exact payment and fees",
        h("p", { class: "delivery" }, `Broker share · ${percent(t.brokerBps)} of the fee pool`),
        feeFacts(payment(t), quote, data?.treasury), rawTerms(domain, t)),
      data && section("Wallet actions", actions()),
      data?.grant && grantCard(data),
      data?.status > 0 && receiptCard(app, { data, receipts }, id)),
    () => main.querySelector('[data-testid="broker-refresh"]'));
  }

  return { update, stop() { stopped = true; stopWatching(); } };
}
