import { approveExactly, same, say, transact } from "./eth.js";
import { flow } from "./flow.js";
import { h, networkName, NO_WALLET, show } from "./ui.js";
import { brokerError, directory, effectiveStatus, feesFor, readProposal, roleFor, signTerms, toHex, txData } from "./v3-protocol.js";
import { button, canonicalTerms, feeDetails, grantView, header, legs, message, panel, receiptView, section, share, shell, stageBadge, tokenAmount, tokenWarning, walletRole } from "./v3-view.js";

const statusText = {
  awaiting: "The named seller must deposit the full allocation before the buyer can settle.",
  funded: "The allocation is in onchain escrow. Only the designated buyer can settle.",
  settled: "This deal settled onchain. Payment, fees and delivery completed in one transaction.",
  expired: "The deadline or fixed vesting start has passed. Settlement is closed.",
  refunded: "The seller withdrew the allocation from escrow. The deal is closed.",
  unavailable: "The seller used this nonce for another deal. Ask the broker to issue a new link.",
};

export function brokerDealPage(app, protocol, { payload, id: onchainId, duplicate }) {
  const domain = protocol.domain;
  const proposal = payload ? readProposal(domain, payload) : null;
  const id = proposal?.id ?? onchainId.toLowerCase();
  const book = directory(domain), path = location.hash;
  const s = { record: null, busy: null, notice: null, error: "", checking: false };
  let stopped = false, revision = 0, lastBlock, eventsKey, loading = false;
  const pendingKey = `otcfam:v3:pending:${domain.chainId}:${protocol.contract}:${id}`;
  const presses = flow({
    app, s, key: pendingKey, render, explainError: brokerError,
    async settle(receipt) {
      await load(true);
      if (receipt?.status === "0x1" && !s.error) s.notice = { kind: "info", text: "Transaction confirmed. The deal reflects the latest onchain status." };
    },
  });
  document.title = "Broker deal · otc.fam";

  async function load(force = false) {
    if (!force && loading) return;
    const run = ++revision;
    loading = true;
    let changed = true;
    const account = app.wallet?.account, chainId = app.wallet?.chainId;
    if (force) {
      s.checking = true;
      render();
    }
    try {
      await protocol.checkNetwork();
      const block = await app.chain.block();
      if (!force && block.number === lastBlock?.number && block.time === lastBlock.time && !s.error) {
        changed = false;
        return;
      }
      const at = toHex(block.number);
      const [deal, [treasury]] = await Promise.all([protocol.deal(id, at), protocol.read("treasury", [], at)]);
      if (stopped || run !== revision) return;
      const terms = deal.terms ?? proposal?.terms;
      if (!terms) throw say("No funded deal has this ID. To preview an unfunded proposal, use the original link.");
      if (same(terms.broker, protocol.contract)) throw say("This proposal names the escrow contract as broker recipient.");
      const role = roleFor(terms, account);
      const track = role && deal.status === "awaiting" && proposal;
      const [base, quote, nonce, grant] = await Promise.all([
        app.chain.token(terms.baseToken), app.chain.token(terms.quoteToken),
        deal.status === "awaiting" ? protocol.read("usedNonce", [terms.seller, terms.nonce], at) : [false],
        deal.grantId ? protocol.grant(deal.grantId, at) : null,
      ]);
      const record = { ...deal, terms, nonceUsed: nonce[0], role, block, treasury, domain, base, quote, grant };
      record.state = effectiveStatus(record, block.time);
      const histories = `${deal.status}:${grant?.claimed ?? 0n}`;
      const actionToken = role === "seller" && record.state === "awaiting" ? base
        : role === "buyer" && record.state === "funded" ? quote : null;
      const [receipts, balance, allowance] = await Promise.all([
        deal.status === "awaiting" ? []
          : !force && eventsKey === histories && s.record?.receipts?.length && s.record.receipts.every((r) => r.confirmed)
            ? s.record.receipts : protocol.receipts(id, deal.grantId, block.number),
        actionToken && chainId === domain.chainId ? app.chain.balanceOf(actionToken.address, account) : 0n,
        actionToken && chainId === domain.chainId ? app.chain.allowance(actionToken.address, account, protocol.contract) : 0n,
      ]);
      if (stopped || run !== revision) return;
      if (track && chainId === domain.chainId) book.save(account, id, path);
      s.record = { ...record, receipts, balance, allowance, account, chainId };
      s.error = "";
      lastBlock = block;
      eventsKey = histories;
    } catch (error) {
      if (run === revision) s.error = brokerError(error);
    } finally {
      if (!stopped && run === revision) {
        loading = false;
        s.checking = false;
        if (changed) render();
      }
    }
  }

  function runAction(label, work) {
    return () => {
      if (s.busy || s.checking || s.error) return;
      presses.act(label, null, work);
    };
  }

  function walletAction(label, work, options) {
    const control = button(label, runAction(label, work), options);
    // Keep keyboard focus on the action while runAction blocks presses during a wallet request or refresh.
    if (s.busy || s.checking || s.error) control.setAttribute("aria-disabled", "true");
    return control;
  }

  function walletFor(account) {
    const provider = app.wallet.provider;
    async function ensure() {
      const [accounts, chain] = await Promise.all([
        provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
      ]);
      if (Number(chain) !== domain.chainId) throw say("Your wallet changed networks. Switch back before trying again.");
      if (!same(accounts[0], account)) throw say("Your wallet changed accounts. Select the required wallet before trying again.");
    }
    const wallet = {
      account, nonceOf: (hash) => app.wallet.nonceOf(hash),
      async send(tx) {
        await ensure();
        return provider.request({ method: "eth_sendTransaction", params: [{ from: account, ...tx }] });
      },
    };
    return { scoped: { ...app, wallet }, provider, ensure };
  }

  function reviewTerms() {
    const box = app.main.querySelector("[data-signing-terms]");
    box.querySelector("details").open = true;
    box.querySelector("h2").focus();
  }

  function amountAction(record, action) {
    const { terms, base, quote, balance, allowance, account } = record;
    const funding = action === "fund";
    const token = funding ? base : quote;
    const total = funding ? terms.allocation : feesFor(terms).buyerTotal;
    if (balance < total) return [
      h("p", { class: "notice warn", role: "status" }, `This wallet has ${tokenAmount(balance, token)}. It needs ${tokenAmount(total, token)} to ${funding ? "fund" : "settle"}.`),
      button("Check balance again", () => load(true), { secondary: true, disabled: Boolean(s.busy || s.checking) }),
    ];
    if (allowance < total) return [
      h("p", { class: "broker-muted" }, `Approve ${tokenAmount(total, token)} for the escrow contract. The next step asks for your signature on the exact terms.`),
      walletAction(`Approve ${token.symbol || "token"}`, async (stage) => {
        const { scoped, ensure } = walletFor(account);
        await ensure();
        return approveExactly(scoped, token, total, allowance, stage, protocol.contract);
      }),
    ];
    const label = funding ? "Sign and fund deal" : "Sign and settle deal";
    return [
      h("p", { class: "broker-muted" }, "Your wallet will ask for an EIP-712 signature and then a separate transaction confirmation."),
      button("Review exact signing terms", reviewTerms, { secondary: true, id: "v3-review-terms" }),
      walletAction(label, async (stage, sent) => {
        const { scoped, provider, ensure } = walletFor(account);
        await ensure();
        stage("Sign the exact deal terms in your wallet.");
        const signature = await signTerms(provider, account, domain, terms);
        const data = funding ? txData("fund", terms, signature) : txData("settle", id, signature);
        await ensure();
        return transact(scoped, protocol.contract, data, stage, funding ? "Funding deal" : "Settling deal", (hash, nonce) => sent(hash, nonce, account));
      }),
    ];
  }

  function sendAction(label, name, options, ...args) {
    const account = s.record.account;
    return walletAction(label, async (stage, sent) => {
      const { scoped, ensure } = walletFor(account);
      await ensure();
      return transact(scoped, protocol.contract, txData(name, ...args), stage, label, (hash, nonce) => sent(hash, nonce, account));
    }, options);
  }

  function prompt(record) {
    const { chainId, account, terms, state, role, grant, status } = record;
    const claim = state === "settled" && grant?.claimable > 0n;
    const refund = status === "funded";
    const actor = state === "awaiting" ? ["seller", terms.seller]
      : state === "funded" ? ["buyer", terms.buyer] : claim ? ["beneficiary", grant.beneficiary]
        : refund ? ["seller", terms.seller] : null;
    const explainActor = actor && h("p", { class: "broker-callout" }, `Wallet required · ${actor[0]} `, h("span", { class: "mono" }, actor[1]));
    if (!app.wallet) return [explainActor, actor && h("p", { class: "broker-muted" }, NO_WALLET)];
    if (!account) return [explainActor, actor && walletAction("Connect wallet", () => app.wallet.connect())];
    if (chainId !== domain.chainId) return [
      explainActor, h("p", { class: "notice warn", role: "status", testid: "v3-wrong-chain" },
        `Your wallet is on another network. Switch to ${networkName(domain.chainId)} (${domain.chainId}) to act.`),
      walletAction(`Switch to ${networkName(domain.chainId)}`, () => app.wallet.switchTo(domain.chainId)),
    ];
    const accountLine = h("p", { class: "broker-muted", testid: "v3-role", role: "status" }, `${walletRole(terms, account)} connected`);
    if (state === "awaiting" && role === "seller") return [accountLine, ...amountAction(record, "fund")];
    if (state === "funded" && role === "buyer") return [accountLine, ...amountAction(record, "settle")];
    if (claim && same(account, grant.beneficiary)) return [
      accountLine, sendAction("Claim vested tokens", "claim", { id: "v3-claim" }, grant.id),
    ];
    if (refund && role === "seller") return [
      accountLine,
      h("p", { class: "broker-muted" }, state === "funded"
        ? "The buyer can settle while the deal is funded. You can withdraw the allocation first if the deal is cancelled."
        : "Withdraw the expired allocation. No settlement fees will be paid."),
      sendAction("Refund allocation", "refund", { id: "v3-refund", secondary: true }, id),
    ];
    return [accountLine, explainActor,
      actor && h("p", { class: "notice warn", role: "status", testid: "v3-wrong-wallet" }, `Select the named ${actor[0]} wallet to take this action.`)];
  }

  function render() {
    if (stopped) return;
    const record = s.record;
    if (!record) {
      show(app.main, shell("deal", header("Broker deal", ""),
        s.error ? panel(message(s.error, true), button("Retry", () => load(true), { secondary: true })) : h("p", { role: "status" }, "Reading deal from the chain…")));
      return;
    }
    const { terms, base, quote, grant, block, state, receipts } = record;
    const latest = [...receipts].reverse();
    const final = latest.find((r) => r.kind === state) ?? latest.find((r) => r.kind === "funded");
    const next = panel(
      h("h2", {}, "What happens next"),
      h("p", { class: "broker-muted", testid: "v3-status-detail" }, statusText[state]),
      prompt(record),
      s.checking && h("p", { class: "broker-muted", role: "status" }, "Reading current chain and wallet state…"),
      s.error && message(s.error, true),
      s.busy && h("p", { class: "broker-callout", role: "status" }, s.busy.hint || s.busy.label),
      s.busy?.waiting && button("Stop waiting", () => presses.stopWaiting("Stopped waiting. The latest onchain status will update when the transaction confirms."), { secondary: true, id: "v3-stop-waiting" }),
      s.notice && !s.busy && !s.error && message(s.notice.text, s.notice.kind === "error"),
      s.error && button("Retry", () => load(true), { secondary: true, id: "v3-retry" }));
    const receiptPanel = final && section("Onchain activity",
      receiptView(app, record, final),
      latest.filter((receipt) => receipt !== final).map((receipt) => h("details", {
        class: "broker-details", "data-broker-detail": receipt.hash,
      }, h("summary", {}, receipt.kind === "claimed" ? `Claimed ${tokenAmount(receipt.amount, base)}` : "Funding transaction"),
      receiptView(app, record, receipt))));
    const signing = panel(canonicalTerms(record));
    signing.setAttribute("data-signing-terms", "");
    const left = h("div", { class: "broker-stack" },
      grant && panel(grantView(grant, base, block.time)),
      receiptPanel,
      section(state === "settled" ? "Agreed fee split" : "Fee split on settlement", feeDetails(terms, quote)),
      signing);
    const view = shell("deal",
      header(terms.delivery ? "Broker deal · vesting" : "Broker deal · immediate", "Review funding, delivery and the wallets named in this deal.", stageBadge(state)),
      h("div", { class: "broker-columns" }, panel(legs(terms, base, quote), tokenWarning()), next),
      h("div", { class: "broker-columns" }, left, section("Deal link", share(path),
        button("Duplicate terms", () => duplicate(record), { secondary: true, id: "v3-duplicate" }))));
    const opened = new Set([...app.main.querySelectorAll("details[open]")].map((node) => node.dataset.brokerDetail));
    view.querySelectorAll("details").forEach((node) => { if (opened.has(node.dataset.brokerDetail)) node.open = true; });
    show(app.main, view);
  }

  const poll = setInterval(() => { if (!s.busy && !s.checking && !document.hidden) load(); }, 3500);
  const wake = () => { if (!document.hidden && !s.busy) load(true); };
  addEventListener("focus", wake);
  render();
  load(true).then(() => { if (!stopped) presses.resume(() => {}); });
  return {
    update() { if (!s.busy) load(true); },
    stop() { stopped = true; clearInterval(poll); removeEventListener("focus", wake); presses.stop(); },
  };
}
