import { same } from "./eth.js";
import { amount, fact, h, networkName, span, TOKEN_WARNING, transaction, utc } from "./ui.js";
import { feesFor, percent, STAGE } from "./v3-protocol.js";

export const mono = (value) => h("span", { class: "mono" }, String(value));
export const absolute = (hash) => new URL(hash, location.href).href;
export const v3Link = (id) => `#/v3/d/${id}`;
export const message = (text, error = false) => h("p", {
  class: `notice ${error ? "error" : "info"}`, role: error ? "alert" : "status", testid: "v3-notice",
}, text);

export function shell(mode, ...children) {
  const item = (href, label, current) => h("a", { href, "aria-current": current ? "page" : null }, label);
  return h("div", { class: "broker-workspace" },
    h("nav", { class: "broker-nav", "aria-label": "Broker deals" },
      item("#/v3/new", "New proposal", mode === "new"), item("#/v3/deals", "Deal book", mode === "history")),
    ...children);
}

export const panel = (...children) => h("section", { class: "broker-panel" }, ...children);
export const section = (title, ...children) => panel(h("h2", {}, title), ...children);
export const header = (title, description, badge) => h("div", { class: "broker-heading" },
  h("div", {}, h("p", { class: "broker-kicker" }, "Broker deals · V3"), h("h1", { tabindex: "-1", testid: "v3-heading" }, title)),
  badge, description && h("p", { class: "broker-intro" }, description));

export const stageBadge = (status) => h("span", {
  class: `broker-stage ${status}`, testid: "v3-status", "data-status": status, role: "status",
}, STAGE[status]);

export function button(label, run, { id = "v3-action", secondary = false, disabled = false } = {}) {
  return h("button", {
    class: secondary ? "secondary" : "primary", testid: id, type: "button", disabled: disabled || !run,
    onclick: run && ((event) => run(event.currentTarget)),
  }, label);
}

export function copyLink(path, testid = "v3-copy") {
  return button("Copy deal link", async (target) => {
    const url = absolute(path);
    const copied = await navigator.clipboard?.writeText(url).then(() => true, () => false);
    const field = target.parentElement.querySelector("input");
    const status = target.parentElement.querySelector("[role=status]");
    if (copied) {
      status.textContent = "Deal link copied.";
      return;
    }
    field.hidden = false;
    field.focus();
    field.select();
    status.textContent = "Use your browser’s copy shortcut to copy the selected link.";
  }, { id: testid, secondary: true });
}

export function share(path, testid) {
  return h("div", { class: "broker-share" }, copyLink(path, testid),
    h("input", { type: "text", readonly: true, hidden: true, value: absolute(path), "aria-label": "Full deal link" }),
    h("p", { class: "broker-share-status", role: "status" }));
}

const tokenDescription = (token) => token.symbol || "Token";
export const tokenAmount = (raw, token) => amount(raw, { ...token, symbol: tokenDescription(token) });
const dateExact = (seconds) => [utc(seconds), " · ", mono(`${seconds} unix seconds`)];
export const tokenWarning = () => h("p", { class: "warning broker-warning" }, TOKEN_WARNING);

export function legs(terms, base, quote) {
  const leg = (label, raw, token) => h("div", { class: "broker-leg" }, h("span", {}, label),
    h("strong", {}, tokenAmount(raw, token)),
    h("span", { class: "mono", title: "Token contract" }, token.address));
  return h("div", { class: "broker-legs" },
    leg("Buyer pays", feesFor(terms).buyerTotal, quote),
    leg(terms.delivery ? "Grant allocation" : "Buyer receives", terms.allocation, base));
}

function values(payment, token) {
  const value = (label, raw) => fact(label, tokenAmount(raw, token), " ", h("span", { class: "broker-raw mono" }, `(${raw} raw)`));
  return [
    value("Agreed quote", payment.quote), value("Buyer fee · 0.50%", payment.buyerFee),
    value("Seller fee · 0.50%", payment.sellerFee), value("Total fee pool", payment.feePool),
    value("Buyer pays", payment.buyerTotal), value("Seller receives", payment.sellerNet),
    value("Broker receives", payment.brokerFee), value("Treasury receives", payment.treasuryFee),
  ];
}

export function feeDetails(terms, quote, event) {
  const payment = event ? {
    quote: terms.quote, buyerFee: event.buyerFee, sellerFee: event.sellerFee,
    buyerTotal: terms.quote + event.buyerFee, sellerNet: terms.quote - event.sellerFee,
    feePool: event.buyerFee + event.sellerFee, brokerFee: event.brokerFee, treasuryFee: event.treasuryFee,
  } : feesFor(terms);
  return [
    h("p", { class: "broker-muted" }, `The broker receives ${percent(terms.brokerBps)} of the fee pool on successful settlement. Each fee and the broker share are rounded down in raw token units.`),
    h("dl", { class: "broker-facts broker-fees", testid: event ? "v3-receipt-fees" : "v3-fees" }, values(payment, quote)),
  ];
}

export function deliveryText(terms) {
  if (terms.delivery === 0n) return "Immediate transfer to the designated buyer at settlement.";
  const start = terms.fixedStart ? utc(terms.fixedStart) : "settlement";
  return `New fully funded grant to the buyer. Vesting starts at ${start}, has a ${span(terms.cliffSeconds)} cliff and ends after ${span(terms.durationSeconds)}. At the cliff, the accrued linear amount becomes claimable.`;
}

export function canonicalTerms({ domain, id, terms, treasury, base, quote }) {
  return [
    h("h2", { tabindex: "-1" }, "Terms to authorize"),
    h("dl", { class: "broker-facts", testid: "v3-terms" },
      fact("Seller", mono(terms.seller)), fact("Designated buyer", mono(terms.buyer)),
      fact("Broker recipient", mono(terms.broker)), fact("Treasury", mono(treasury)),
      fact("Deadline", dateExact(terms.expiry)), fact("Delivery", deliveryText(terms)),
      fact("Allocation", tokenAmount(terms.allocation, base), " · ", mono(`${terms.allocation} raw`)),
      fact("Quote", tokenAmount(terms.quote, quote), " · ", mono(`${terms.quote} raw`))),
    h("details", { class: "broker-details", "data-broker-detail": "terms" }, h("summary", {}, "Signing domain and exact fields"),
      h("dl", { class: "broker-facts" },
        fact("Chain", `${networkName(domain.chainId)} · ${domain.chainId}`),
        fact("EIP-712 domain", `${domain.name} · version ${domain.version}`),
        fact("Verifying contract", mono(domain.verifyingContract)),
        fact("Deal ID", mono(id)), fact("Seller nonce", mono(terms.nonce)),
        fact("Base token address", mono(terms.baseToken)), fact("Quote token address", mono(terms.quoteToken)),
        fact("Broker share", `${terms.brokerBps} bps of the fee pool`),
        fact("Delivery mode", String(terms.delivery)), fact("Fixed start (unix seconds)", String(terms.fixedStart)),
        fact("Cliff (seconds)", String(terms.cliffSeconds)), fact("Duration (seconds)", String(terms.durationSeconds)))),
  ];
}

export function grantView(grant, base, time) {
  const progress = grant.allocation ? Number((grant.claimed + grant.claimable) * 10_000n / grant.allocation) / 100 : 0;
  const status = BigInt(time) < grant.start ? "Scheduled" : BigInt(time) < grant.cliff ? "Waiting for cliff"
    : grant.claimed === grant.allocation ? "Fully claimed" : BigInt(time) >= grant.end ? "Fully vested" : "Vesting";
  return [
    h("h2", { testid: "v3-grant-heading" }, `Vesting grant #${grant.id}`),
    h("p", { class: "broker-muted", role: "status" }, status),
    h("progress", { max: 100, value: progress, "aria-label": "Percent vested" }),
    h("dl", { class: "broker-facts" },
      fact("Claimable now", h("strong", { testid: "v3-claimable" }, tokenAmount(grant.claimable, base))),
      fact("Already claimed", h("span", { testid: "v3-claimed" }, tokenAmount(grant.claimed, base))),
      fact("Vault balance", h("span", { testid: "v3-vault-balance" }, tokenAmount(grant.held, base))),
      fact("Original allocation", tokenAmount(grant.allocation, base)),
      fact("Beneficiary", mono(grant.beneficiary)), fact("Grant vault", mono(grant.custodian)),
      fact("Starts", dateExact(grant.start)), fact("Cliff", dateExact(grant.cliff)), fact("Ends", dateExact(grant.end))),
  ];
}

const titles = { settled: "Settlement receipt", funded: "Funding receipt", refunded: "Refund receipt", claimed: "Claim receipt" };

export function receiptView(app, record, receipt) {
  const { terms, id, base, quote, grant, block, treasury } = record;
  const { kind, hash } = receipt;
  const verified = receipt.confirmed;
  const confirmations = Math.max(0, block.number - receipt.block + 1);
  const movement = kind === "settled"
    ? (grant ? [`New grant #${grant.id} funded with `, tokenAmount(terms.allocation, base), " in ", mono(grant.custodian)]
      : [tokenAmount(terms.allocation, base), " transferred to buyer"])
    : kind === "funded" ? [tokenAmount(terms.allocation, base), " deposited in escrow"]
      : kind === "refunded" ? "Seller withdrew the allocation from escrow" : [tokenAmount(receipt.amount, base), " withdrawn from the grant"];
  return h("div", { class: "broker-receipt", testid: `v3-receipt-${kind}`, "data-tx": hash },
    h("h3", {}, titles[kind]),
    h("p", { class: "broker-muted" }, verified
      ? `Confirmed · block ${receipt.block} · ${confirmations} confirmation${confirmations === 1 ? "" : "s"}`
      : "Event found · waiting for the RPC to verify its transaction receipt"),
    h("dl", { class: "broker-facts" },
      fact("Transaction hash", transaction(hash, app.explorer)),
      fact("Chain", `${networkName(app.config.chainId)} · ${app.config.chainId}`),
      fact("BrokerDeals contract", mono(app.config.contractV3)), fact("Deal ID", mono(id)),
      fact("Delivery / movement", movement),
      ...(kind === "settled" ? [
        fact("Seller", mono(terms.seller)), fact("Buyer", mono(terms.buyer)), fact("Broker", mono(terms.broker)),
        fact("Treasury", mono(treasury)), fact("Base token", mono(terms.baseToken)), fact("Payment token", mono(terms.quoteToken)),
      ] : [])),
    kind === "settled" ? feeDetails(terms, quote, receipt)
      : h("p", { class: "broker-muted" }, "Broker and treasury fees on this transaction: zero."));
}

export const walletRole = (terms, account) => same(account, terms.seller) ? "Seller"
  : same(account, terms.buyer) ? "Buyer" : same(account, terms.broker) ? "Broker" : "Unrelated wallet";
