import { approveExactly, explain, same, say, transact } from "./eth.js";
import { flow } from "./flow.js";
import { parseAmount, formatAmount } from "./units.js";
import { action, amount, card, copyButton, fact, h, leg, networkName, notice, secondary, show, TOKEN_WARNING, transaction, utc } from "./ui.js";
import { fees, nonce, normalize, stageName, transactionError } from "./v3-chain.js";

const emptyPage = { update() {}, stop() {} };
const address = (value) => h("span", { class: "mono" }, value);
const link = (href, text) => h("a", { href, class: "button secondary" }, text);
const percent = (bps) => formatAmount(BigInt(bps), 2) + "%";
const delivery = (t) => t.delivery === "0" ? "Immediate delivery" : "New vesting grant";
const time = (seconds) => BigInt(seconds) <= 253402300799n ? utc(Number(seconds)) : seconds + " Unix seconds";
const localKey = (v3) => ["otc-fam-v3", v3.domain.chainId, v3.contract].join(":");
const rejected = (error) => notice({ kind: "error", text: explain(transactionError(error)) });

function drafts(v3) {
  try {
    const saved = JSON.parse(localStorage.getItem(localKey(v3)) || "[]");
    return Array.isArray(saved) ? saved.flatMap((terms) => {
      try { return [normalize(terms)]; } catch { return []; }
    }) : [];
  } catch {
    return [];
  }
}

function save(v3, terms) {
  const all = drafts(v3);
  if (all.some((entry) => v3.id(entry) === v3.id(terms))) return;
  localStorage.setItem(localKey(v3), JSON.stringify([terms, ...all]));
}

function nav() {
  return h("nav", { class: "v3-nav", "aria-label": "Broker deals" },
    h("a", { href: "#/v3/new" }, "Prepare a deal"), h("a", { href: "#/v3/history" }, "Broker history"));
}

function title(text) {
  return [h("p", { class: "v3-version" }, "Broker deals · V3"), h("h1", {}, text), nav()];
}

function economics(t, quote, treasury) {
  const f = fees(t);
  return h("dl", { class: "facts v3-grid", "aria-label": "Exact economics" },
    fact("Quote", amount(f.quote, quote)), fact("Buyer fee · 0.5%", amount(f.fee, quote)),
    fact("Seller fee · 0.5%", amount(f.fee, quote)), fact("Buyer total", amount(f.buyerTotal, quote)),
    fact("Seller receives", amount(f.sellerNet, quote)), fact("Broker · " + percent(t.brokerBps) + " of fee pool", amount(f.broker, quote)),
    fact("Treasury receives", amount(f.treasury, quote)), treasury && fact("Treasury wallet", address(treasury)));
}

function facts(t, v3) {
  return h("dl", { class: "facts v3-grid" },
    fact("Seller", address(t.seller)), fact("Designated buyer", address(t.buyer)), fact("Broker", address(t.broker)),
    fact("Expiry (UTC)", time(t.expiry)), fact("Delivery", delivery(t)), fact("Nonce", address(t.nonce)),
    fact("Signing domain", v3.domain.name + " · v" + v3.domain.version + " · chain " + v3.domain.chainId),
    fact("Verifying contract", address(v3.contract)), fact("Signed deal ID", address(v3.id(t))),
    fact("Allocation in base units", address(t.allocation)), fact("Quote in base units", address(t.quote)),
    fact("Payment token contract", address(t.quoteToken)),
    t.delivery === "1" && [
      fact("Vesting start", t.fixedStart === "0" ? "Settlement block" : time(t.fixedStart)),
      fact("Cliff", t.cliffSeconds + " seconds"), fact("Duration", t.durationSeconds + " seconds"),
    ]);
}

const failDates = (value, optional = false) => {
  if (!value && optional) return "0";
  const date = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(value) ? Date.parse(value + "Z") : NaN;
  if (!Number.isSafeInteger(date) || date <= 0) throw say("Enter valid timestamps in UTC.");
  return String(date / 1000);
};
const dateInput = (value) => BigInt(value) > 0n && BigInt(value) <= 253402300799n
  ? new Date(Number(value) * 1000).toISOString().slice(0, 19) : "";
const inputValue = (amount, token) => formatAmount(BigInt(amount), token.decimals).replaceAll(",", "");

export function preparePage(app, duplicate) {
  const { v3, chain } = app;
  const form = h("form", { class: "v3-form", onsubmit: (event) => { event.preventDefault(); review(); } });
  const controls = {};
  const field = (key, text, attrs = {}) => {
    const input = h("input", { id: "v3-" + key, testid: "v3-" + key, autocomplete: "off", ...attrs });
    controls[key] = input;
    return h("div", { class: "field" }, h("label", { for: input.id }, text), input);
  };
  const dates = h("div", { class: "v3-grid", hidden: true },
    field("fixedStart", "Fixed start (UTC, optional)", { type: "datetime-local", step: "1" }),
    field("cliffSeconds", "Cliff (seconds)", { inputmode: "numeric", value: "0" }),
    field("durationSeconds", "Duration (seconds)", { inputmode: "numeric", value: "7776000" }));
  const mode = h("select", { id: "v3-mode", onchange: () => { dates.hidden = mode.value !== "1"; } },
    h("option", { value: "0" }, "Immediate delivery"), h("option", { value: "1" }, "New vesting grant"));
  const preview = h("div", { class: "v3-preview" });
  const reviewButton = h("button", { type: "submit", class: "primary" }, "Preview terms");
  form.append(h("div", { class: "v3-grid" },
    field("seller", "Seller"), field("buyer", "Designated buyer"), field("broker", "Broker wallet"),
    field("brokerBps", "Broker share (basis points of fee pool)", { inputmode: "numeric", value: "2000" }),
    field("baseToken", "Allocation token"), field("allocation", "Allocation amount", { inputmode: "decimal" }),
    field("quoteToken", "Payment token"), field("quote", "Quote before fees", { inputmode: "decimal" }),
    field("expiry", "Expiry (UTC)", { type: "datetime-local", step: "1" }),
    h("div", { class: "field" }, h("label", { for: mode.id }, "Delivery"), mode)),
  dates, h("p", { class: "hint" }, TOKEN_WARNING), reviewButton);
  let live = true, revision = 0;
  const prefills = () => {
    if (!duplicate && !controls.broker.value && app.wallet?.account) controls.broker.value = app.wallet.account;
  };
  form.addEventListener("input", () => {
    revision++;
    if (preview.firstChild) preview.replaceChildren(h("p", { class: "hint" }, "Terms changed. Preview again to create a new link."));
  });
  app.main.replaceChildren(card(title("Prepare a private deal"),
    h("p", { class: "lead" }, "Prepare terms for the seller and buyer. The seller funds the deal from their own wallet."),
    form, preview));
  prefills();

  chain.now().then((now) => {
    if (live && !controls.expiry.value) controls.expiry.value = dateInput(String(now + 86400));
  }).catch(() => {});
  if (duplicate) {
    try {
      const t = v3.decode(duplicate);
      for (const key of ["seller", "buyer", "broker", "brokerBps", "baseToken", "quoteToken", "cliffSeconds", "durationSeconds"]) {
        controls[key].value = t[key];
      }
      mode.value = t.delivery;
      dates.hidden = mode.value !== "1";
      const initial = revision;
      Promise.all([chain.token(t.baseToken), chain.token(t.quoteToken)]).then(([base, quote]) => {
        if (!live || revision !== initial) return;
        controls.allocation.value = inputValue(t.allocation, base);
        controls.quote.value = inputValue(t.quote, quote);
      }).catch((error) => { if (live && revision === initial) preview.replaceChildren(rejected(error)); });
    } catch (error) {
      preview.replaceChildren(rejected(error));
    }
  }

  async function review() {
    const current = ++revision, selected = mode.value;
    const entered = Object.fromEntries(Object.entries(controls).map(([k, input]) => [k, input.value.trim()]));
    preview.replaceChildren(h("p", { class: "hint", role: "status" }, "Reading tokens and latest block…"));
    try {
      for (const key of ["baseToken", "quoteToken"]) {
        if (!/^0x[0-9a-f]{40}$/i.test(entered[key])) throw say("Enter both token addresses.");
      }
      const [base, quote, now, [treasury]] = await Promise.all([
        chain.token(entered.baseToken), chain.token(entered.quoteToken), chain.now(), v3.read("treasury"),
      ]);
      const terms = normalize({ ...entered,
        allocation: parseAmount(entered.allocation, base.decimals, base.symbol),
        quote: parseAmount(entered.quote, quote.decimals, quote.symbol),
        expiry: failDates(entered.expiry), nonce: nonce(), delivery: selected,
        fixedStart: selected === "1" ? failDates(entered.fixedStart, true) : "0",
        cliffSeconds: selected === "1" ? entered.cliffSeconds : "0",
        durationSeconds: selected === "1" ? entered.durationSeconds : "0",
      });
      if (BigInt(terms.expiry) <= BigInt(now) || (terms.fixedStart !== "0" && BigInt(terms.fixedStart) <= BigInt(now))) {
        throw say("The expiry and any fixed start must be in the future according to the latest block.");
      }
      if (!live || revision !== current) return;
      const url = v3.link(terms);
      preview.replaceChildren(h("section", {},
        h("h2", {}, "Review proposed terms"),
        leg("Allocation", BigInt(terms.allocation), base, "receive"), economics(terms, quote, treasury), facts(terms, v3),
        secondary("v3-create", "Create shareable link", () => {
          let warning;
          try { save(v3, terms); } catch { warning = h("p", { class: "hint" }, "Browser storage is unavailable. Save a copy of the link."); }
          preview.append(h("div", { class: "action" },
            h("p", { class: "hint" }, "Awaiting funding. Share this link with the seller and the designated buyer."),
            warning, h("a", { testid: "v3-link", href: url }, "Open deal link"), copyButton(url)));
        })));
    } catch (error) {
      if (live && revision === current) preview.replaceChildren(rejected(error));
    }
  }
  return { update: prefills, stop() { live = false; } };
}

async function receipts(v3, snapshot) {
  const { id, status, grantId } = snapshot;
  if (!status) return [];
  const definitions = [
    ["BrokerDealFunded", id, "Funded"],
    ["BrokerDealSettled", id, "Settled"],
    ["BrokerDealRefunded", id, "Refunded"],
    ...(grantId ? [["BrokerGrantClaimed", grantId, "Claimed"]] : []),
  ];
  return (await Promise.all(definitions.map(async ([name, indexed, label]) =>
    (await v3.logs(name, [indexed], "0x" + snapshot.block.number.toString(16))).map((event) => ({ ...event, label })))))
    .flat().sort((a, b) => b.block - a.block || b.index - a.index);
}

function receiptCard(app, terms, s) {
  if (!s.onchain.status) return null;
  const { onchain, history } = s;
  const { base, quote } = onchain;
  return h("section", { class: "v3-receipts" }, h("h2", {}, "Transaction receipts"),
    h("dl", { class: "facts v3-grid" },
      fact("Network", networkName(app.config.chainId) + " · chain " + app.config.chainId),
      fact("V3 contract", address(app.v3.contract)), fact("Deal ID", h("span", { class: "mono", testid: "v3-deal-id" }, onchain.id)),
      fact("Seller", address(terms.seller)), fact("Buyer", address(terms.buyer)),
      fact("Broker", address(terms.broker)), fact("Treasury", address(onchain.treasury))),
    history === null && h("p", { class: "hint" }, "The RPC did not return historical events. Deal status is read from the contract."),
    history?.length ? h("ol", { class: "receipts", testid: "v3-receipts" }, history.map((e) => {
      const values = e.args;
      const confirmations = onchain.block.number - e.block + 1;
      return h("li", { "data-tx": e.hash, "data-kind": e.label }, h("strong", {}, e.label),
        h("p", {}, e.label === "Settled"
          ? "Buyer paid " + amount(BigInt(terms.quote) + values.buyerFee, quote) + "; seller received " +
            amount(BigInt(terms.quote) - values.sellerFee, quote) + ". Buyer fee " + amount(values.buyerFee, quote) +
            ", seller fee " + amount(values.sellerFee, quote) + ", broker " + amount(values.brokerFee, quote) +
            ", treasury " + amount(values.treasuryFee, quote) + ". " +
            (values.grantId ? "Fully backed grant #" + values.grantId + "." : "Delivered " + amount(BigInt(terms.allocation), base) + ".")
          : e.label === "Claimed" ? amount(values.amount, base) + " paid to " + values.beneficiary + "."
            : amount(BigInt(terms.allocation), base) + " · seller " + terms.seller + "."),
        h("p", { class: "hint" }, "Confirmed · block " + e.block + " · " + Math.max(1, confirmations) + " confirmation(s)"),
        transaction(e.hash, app.explorer));
    })) : null);
}

function grantCard(onchain) {
  const { grant, grantId, vested, base } = onchain;
  if (!grant) return null;
  return h("section", { class: "v3-receipts" }, h("h2", {}, "Vesting grant #" + grantId),
    h("p", { class: "hint" }, onchain.block.time < grant.cliff
      ? "Claims open at " + time(grant.cliff) + "." : "Only the beneficiary can claim vested tokens."),
    h("dl", { class: "facts v3-grid" },
      fact("Beneficiary", address(grant.beneficiary)), fact("Vault", address(grant.custodian)),
      fact("Start", time(grant.start)), fact("Cliff", time(grant.cliff)), fact("End", time(grant.end)),
      fact("Vested", amount(vested, base)), fact("Claimed", amount(grant.claimed, base)),
      fact("Claimable", amount(vested - grant.claimed, base))));
}

export function brokerDealPage(app, payload) {
  const { v3, chain, wallet, config } = app;
  let terms;
  try { terms = v3.decode(payload); } catch (error) {
    app.main.replaceChildren(card(title("Broker deal unavailable"), rejected(error)));
    return emptyPage;
  }

  const s = { busy: null, notice: null, onchain: null, funds: null, problem: null, history: [] };
  let live = true, latest = 0;
  const op = flow({ app, s, key: localKey(v3) + ":" + v3.id(terms), render, settle: load });
  const refresh = () => { if (!s.busy) load(); };
  const timer = setInterval(refresh, 5000);
  addEventListener("focus", refresh);

  async function load() {
    const read = ++latest;
    try {
      if (Number(await chain.rpc("eth_chainId", [])) !== config.chainId) throw say("The read RPC is on the wrong network.");
      const onchain = await v3.inspect(terms), who = wallet?.account;
      const needed = onchain.status === 0 && same(who, terms.seller) ? [onchain.base, BigInt(terms.allocation)]
        : onchain.status === 1 && same(who, terms.buyer) ? [onchain.quote, fees(terms).buyerTotal] : null;
      const [funds, events] = await Promise.all([
        needed && wallet.chainId === config.chainId ? Promise.all([
          chain.balanceOf(needed[0].address, who), chain.allowance(needed[0].address, who, v3.contract),
        ]).then(([balance, allowance]) => ({ balance, allowance, token: needed[0], units: needed[1], who })) : null,
        receipts(v3, onchain).catch(() => null),
      ]);
      if (!live || read !== latest) return;
      Object.assign(s, { onchain, funds, history: events, problem: null });
    } catch (error) {
      if (!live || read !== latest) return;
      s.problem = error;
    }
    render();
  }

  function run(label, fn) {
    return op.act(label, null, async (stage, sent) => {
      try { return await fn(stage, sent); } catch (error) { throw transactionError(error); }
    });
  }

  function buttons(snapshot, state) {
    const status = state === "Awaiting funding" ? "fund" : state === "Funded" ? "settle" : null;
    const canRefund = snapshot.status === 1;
    const canClaim = snapshot.grant && snapshot.vested > snapshot.grant.claimed;
    const me = wallet?.account;
    const actor = status === "fund" ? terms.seller : terms.buyer;
    const isSeller = same(me, terms.seller), isBuyer = same(me, terms.buyer);
    let button, hint, extra;
    if (s.busy) {
      button = { label: s.busy.label };
      hint = s.busy.hint;
      if (s.busy.waiting) extra = secondary("v3-stop", "Stop waiting", () => op.stopWaiting("Check the pending transaction in your wallet."));
    } else if (s.problem) {
      button = { label: "Refresh", run: load };
    } else if (status || canRefund || canClaim) {
      if (!wallet) hint = "A wallet is needed to act. You can still inspect these terms and receipts.";
      else if (!me) button = { label: "Connect wallet", run: () => run("Connecting…", () => wallet.connect()) };
      else if (!(isSeller || isBuyer)) hint = "This wallet can view the deal. Only the named seller or buyer can act.";
      else if (wallet.chainId !== config.chainId) {
        button = { label: "Switch to " + networkName(config.chainId), run: () => run("Switching…", () => wallet.switchTo(config.chainId)) };
      } else {
        if (status && same(me, actor)) {
          const f = s.funds;
          if (!f || !same(f.who, me)) hint = "Reading the wallet’s balance and allowance…";
          else if (f.balance < f.units) hint = "This wallet holds " + amount(f.balance, f.token) + "; this step needs " + amount(f.units, f.token) + ".";
          else if (f.allowance < f.units) button = {
            label: "Approve " + amount(f.units, f.token),
            run: () => run("Approving…", (stage) => approveExactly(app, f.token, f.units, f.allowance, stage, v3.contract)),
          };
          else button = {
            label: status === "fund" ? "Sign and fund" : "Sign and settle",
            run: () => run("Waiting for wallet…", async (stage, sent) => {
              stage("Review the typed terms and sign them in your wallet.");
              const signature = await v3.sign(wallet, terms, actor);
              const data = v3.data(status, status === "fund" ? [terms, signature] : [snapshot.id, signature]);
              return transact(app, v3.contract, data, stage, status === "fund" ? "Fund the signed terms" : "Settle the signed terms", sent);
            }),
          };
        } else if (status) hint = (status === "fund" ? "Waiting for the seller " : "Waiting for the designated buyer ") + actor + ".";
        if (canRefund && isSeller) extra = secondary("v3-refund", "Refund allocation", () =>
          run("Refunding…", (stage, sent) => transact(app, v3.contract, v3.data("refund", [snapshot.id]), stage, "Refund the seller", sent)));
        if (canClaim && isBuyer) button = { label: "Claim vested tokens", run: () => run("Claiming…", (stage, sent) =>
          transact(app, v3.contract, v3.data("claim", [snapshot.grantId]), stage, "Claim vested tokens", sent)) };
      }
    }
    return action({ button, hint, extra, notice: s.notice });
  }

  function render() {
    if (!live) return;
    const snapshot = s.onchain;
    if (!snapshot) return show(app.main, card(title("Private broker deal"),
      s.problem ? rejected(s.problem) : h("p", { class: "lead" }, "Reading the latest block…"),
      s.problem && secondary("v3-refresh", "Try again", load)));
    const state = stageName(terms, snapshot);
    show(app.main, card(title("Private broker deal"),
      h("p", { class: "v3-status", role: "status", testid: "v3-status" }, state),
      state === "Awaiting funding" && h("p", { class: "hint" }, "Only the named seller can fund. Settlement is unavailable until the allocation is escrowed."),
      state === "Funded" && h("p", { class: "held" }, "Allocation funded on-chain. Only the designated buyer can settle."),
      ["Expired", "Fixed start passed", "Nonce used"].includes(state) && h("p", { class: "hint" }, "This offer cannot settle. The seller can refund any funded allocation."),
      leg(delivery(terms), BigInt(terms.allocation), snapshot.base, "receive"), economics(terms, snapshot.quote, snapshot.treasury), facts(terms, v3),
      h("p", { class: "hint" }, TOKEN_WARNING),
      grantCard(snapshot), s.problem && rejected(s.problem), buttons(snapshot, state),
      h("div", { class: "row" }, copyButton(v3.link(terms)), link("#/v3/new/" + payload, "Duplicate terms")),
      receiptCard(app, terms, s)));
  }
  render();
  load();
  if (wallet) op.resume(() => {});
  return { update: load, stop() { live = false; clearInterval(timer); removeEventListener("focus", refresh); op.stop(); } };
}

export function brokerHistoryPage(app) {
  const { v3, wallet } = app;
  let live = true, revision = 0;
  function render(content) {
    if (live) show(app.main, card(title("Broker history"), content));
  }
  async function load() {
    if (!live) return;
    const version = ++revision, broker = wallet?.account;
    if (!broker) return render(wallet ? secondary("v3-connect-history", "Connect broker wallet", async () => {
      try { await wallet.connect(); await load(); } catch (error) { render(rejected(error)); }
    }) : h("p", { class: "hint" }, "Open with a wallet to see deals for its broker address."));
    render(h("p", { class: "hint" }, "Reading deals for " + broker + "…"));
    let warning;
    try {
      const list = new Map(drafts(v3).filter((t) => same(t.broker, broker)).map((t) => [v3.id(t), t]));
      const persisted = await v3.logs("BrokerDealFunded", [null, null, broker]).catch(() => {
        warning = "This RPC did not return broker history. Showing drafts saved in this browser.";
        return [];
      });
      for (const { args } of persisted) {
        if (!list.has(args.dealId)) {
          const [terms] = await v3.read("getDeal", [args.dealId]);
          const t = normalize(terms);
          if (same(t.broker, broker) && v3.id(t) === args.dealId) list.set(args.dealId, t);
        }
      }
      const items = await Promise.all([...list.values()].map(async (t) => {
        const url = v3.link(t), payload = new URL(url).hash.split("/").at(-1);
        try {
          const snap = await v3.inspect(t);
          const events = await receipts(v3, snap).catch(() => null);
          const receipt = events?.find((event) => event.label !== "Claimed");
          const share = fees(t).broker;
          return h("li", { class: "v3-history-item" },
            h("strong", {}, snap.base.symbol + " / " + snap.quote.symbol + " · " + stageName(t, snap)),
            h("p", {}, amount(BigInt(t.quote), snap.quote) + " · broker " + percent(t.brokerBps) + " of fee pool · expires " + time(t.expiry)),
            h("p", {}, receipt?.label === "Settled" ? "Broker earned " + amount(receipt.args.brokerFee, snap.quote)
              : snap.status === 2 ? "Broker share in signed terms: " + amount(share, snap.quote)
              : snap.status === 3 ? "Refunded · no fee paid" : "Broker share if settled: " + amount(share, snap.quote)),
            receipt && h("p", {}, receipt.label + " · ", transaction(receipt.hash, app.explorer)),
            events === null && h("p", { class: "hint" }, "Receipt events unavailable from this RPC."),
            h("div", { class: "row" }, link(url, "Open"), copyButton(url), link("#/v3/new/" + payload, "Duplicate")));
        } catch (error) {
          return h("li", { class: "v3-history-item" }, rejected(error), link(url, "Open proposal"));
        }
      }));
      if (version !== revision) return;
      render([h("p", { class: "hint" }, "Broker ", address(broker), ". Unsigned proposals are stored in this browser."),
        warning && h("p", { class: "hint" }, warning),
        items.length ? h("ul", { class: "v3-history", testid: "v3-history" }, items) : h("p", {}, "No broker deals for this wallet."),
        secondary("v3-refresh-history", "Refresh history", load)]);
    } catch (error) {
      if (version === revision) render([rejected(error), secondary("v3-refresh-history", "Retry", load)]);
    }
  }
  load();
  const timer = setInterval(() => { if (document.visibilityState === "visible" && !app.main.contains(document.activeElement)) load(); }, 15000);
  return { update: load, stop() { live = false; clearInterval(timer); } };
}
