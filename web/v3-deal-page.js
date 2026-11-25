// A broker deal's page, #/v3/d/<chain>/<contract>/<terms>: one link for the whole life of a deal that a broker
// prepared. The link carries the terms themselves, so the page shows them to anyone, with no wallet: who sells, who
// buys, the exact money with both fees and the broker's share, the delivery, and what the chain holds for the deal.
// It says whose turn it is and why, and gives that wallet its one button: the seller signs the terms and funds, the
// buyer signs the same terms and settles. After a vesting settlement it is the grant's page too (v2-grant.js draws
// it), and every transaction is listed as a receipt (v3-receipt.js). A link that ends with a deal's ID works as
// well, once the deal is funded: the chain then has its terms.
import { approveExactly, explain, refusalOf, same, say, transact } from "./eth.js";
import { flow } from "./flow.js";
import { action, amount, card, copyButton, fact, fromNow, h, head, leg, networkName, NO_WALLET, notice, secondary, short, show, span, TOKEN_WARNING, utc } from "./ui.js";
import { formatAmount, isAddress } from "./units.js";
import { grantCard } from "./v2-grant.js";
import { receiptCard } from "./v3-receipt.js";
import { claimData, DOMAIN, flawOf, fundData, linkOf, money, packTerms, percent, refundData, remember, settleBy, settleData, signTerms, stateOf, unpackTerms, VESTING } from "./v3.js";

// The signatures made while this page is open, by deal and account: a transaction declined after signing does not
// ask for the signature again. They are kept nowhere else.
const signed = new Map();
const BAD_SIGNATURE = "0x9a7d38d9"; // BadSignature(address): the contract's refusal of a signature that is not the signer's of these terms

export function dealPageV3(app, path) {
  const { config, chain, wallet, v3 } = app;
  const [chainText = "", contractText = "", payload = ""] = path.split("/");
  const link = { chainId: /^\d{1,15}$/.test(chainText) ? Number(chainText) : null, contract: isAddress(contractText) ? contractText.toLowerCase() : null,
    terms: unpackTerms(payload), id: /^0x[0-9a-f]{64}$/i.test(payload) ? payload.toLowerCase() : null };
  const sound = link.chainId !== null && link.contract !== null && Boolean(link.terms || link.id);
  const here = Boolean(sound && v3 && link.chainId === config.chainId && link.contract === v3.contract);
  // t: the terms. status: what the chain says of the deal. history: undefined until its events are read, null when the node would not give them.
  const s = { id: null, t: null, status: null, grantId: 0n, base: null, quote: null, block: null, escrow: 0n, buyerHolds: 0n, treasury: null, grant: null, funds: null,
    nonceUsed: false, history: undefined, historyOf: null, failed: null, busy: null, notice: null, receipt: null };
  let live = true, reads = 0, timer, shown = null, movedOn = false; // shown: the state the page drew last
  const walletNow = () => `${wallet?.account}:${wallet?.chainId}`;
  let walletSeen = walletNow();
  const poll = setInterval(() => s.busy || load(), 5000);
  const onFocus = () => s.busy || load();
  addEventListener("focus", onFocus);
  app.main.classList.add("wide");
  // The remembered transaction is this link's own: the whole of its end, since two deals of the same people begin alike.
  const presses = flow({ app, s, key: `otcfam:pending:${config.chainId}:${v3?.contract}:v3:${payload.slice(0, 320)}`, render,
    async settle(receipt, label) {
      if (receipt?.transactionHash) s.receipt = { what: label.replace(/…$/, ""), hash: receipt.transactionHash, block: Number(receipt.blockNumber), gas: BigInt(receipt.gasUsed) };
      await load();
    } });

  /** Reads the deal's status, its tokens, what the chain holds for it, its grant and what the wallet concerned holds, then shows them. */
  async function load() {
    if (!here) return render();
    const read = ++reads;
    try {
      const id = s.id ?? link.id ?? await v3.idOf(link.terms);
      const onchain = await v3.deal(id);
      const t = link.terms ?? onchain.terms;
      if (!t) {
        if (read === reads) Object.assign(s, { id, status: "unknown", failed: null });
      } else {
        const [{ treasury }, block, base, quote, escrow, buyerHolds, grant, funds, nonceUsed] = await Promise.all([v3.setup(), chain.block(), chain.token(t.baseToken),
          chain.token(t.quoteToken), chain.balanceOf(t.baseToken, v3.contract), chain.balanceOf(t.baseToken, t.buyer), onchain.grantId ? v3.grant(onchain.grantId) : null,
          fundsFor(t, onchain.status), onchain.status === "unfunded" ? v3.nonceUsed(t.seller, t.nonce) : false]);
        if (read !== reads) return; // a later read is on its way
        Object.assign(s, { id, t, status: onchain.status, grantId: onchain.grantId, treasury, block, base, quote, escrow, buyerHolds, grant, funds, nonceUsed, failed: null });
        remember(app, id, t, "opened");
        readHistory();
      }
    } catch (e) {
      if (read !== reads) return;
      s.failed = explain(e);
    }
    render();
  }

  /** What the connected wallet holds and has approved of the token its own step moves: the seller's allocation, or the buyer's payment. */
  async function fundsFor(t, status) {
    const account = wallet?.account;
    const token = !account ? null : status === "unfunded" && same(account, t.seller) ? t.baseToken : status === "funded" && same(account, t.buyer) ? t.quoteToken : null;
    if (!token) return null;
    const [balance, allowance] = await Promise.all([chain.balanceOf(token, account), chain.allowance(token, account, v3.contract)]);
    return { account, token, balance, allowance };
  }

  /** Reads the deal's events again whenever something happened to it: they are its receipts. */
  async function readHistory() {
    const of = `${s.status}:${s.grant?.claimed ?? ""}`;
    if (of === s.historyOf) return;
    s.historyOf = of;
    const history = await v3.history(s.id, s.grantId).catch(() => null);
    if (of !== s.historyOf) return; // the deal has changed since: a later read is on its way
    if (history) s.history = history;
    else {
      s.history ??= null; // a failed re-read keeps the list it had
      s.historyOf = null; // and is tried again the next time the deal is read
    }
    render();
  }

  const now = () => Math.max(s.block?.time ?? 0, Date.now() / 1000);
  /** Why these terms can never be funded, or null: a rule of the contract they break, or a nonce their seller has already used. */
  const voidWhy = () => (s.status !== "unfunded" ? null : flawOf(s.t, v3.contract)
    ?? (s.nonceUsed ? `The seller has already funded another deal with nonce ${s.t.nonce}, and a seller can use a nonce once.` : null));
  /** The deal's state as the page says it: "awaiting" (funding), "funded", "settled", "refunded", "expired", or "void" (it can never be funded). */
  const state = () => (voidWhy() ? "void" : stateOf(s.t, s.status, now()));
  const roleOf = (me) => (!me ? null : same(me, s.t.seller) ? "seller" : same(me, s.t.buyer) ? "buyer" : same(me, s.t.broker) ? "broker" : "other");
  const fullLink = () => `${location.href.split("#")[0]}${linkOf(app, packTerms(s.t))}`;

  function render() {
    if (!live) return;
    // When a press is over and its button is gone (the deal was funded, settled or refunded, or the wallet that
    // connected is not the one whose turn it is), the focus goes to the line that says whose turn it is now, which
    // a screen reader then reads out. It never goes to another button: a second Enter must not refund or claim.
    const st = s.t ? state() : null;
    if (shown !== null && st !== shown) movedOn = true;
    shown = st;
    show(app.main, view(), s.busy ? null : "next-actor", movedOn);
    if (!s.busy) {
      movedOn = false;
      walletSeen = walletNow(); // the wallet as the page has now shown it: a late event that tells of this same state clears nothing
    }
    clearTimeout(timer);
    const left = s.t && (s.status === "unfunded" || s.status === "funded") ? settleBy(s.t) - now() : -1;
    // The page turns to "expired" on time.
    if (left >= 0 && left < 86_400) timer = setTimeout(render, left * 1000 + 1250);
  }

  /** After a reload, while the transaction sent before it is awaited: what is awaited, and a way to stop waiting. */
  const waiting = () => s.busy?.waiting && h("div", { class: "action" }, h("p", { class: "notice info", testid: "waiting", role: "status" }, s.busy.hint),
    secondary("stop-waiting", "Stop waiting for it", () => presses.stopWaiting("Stopped waiting. If that transaction is confirmed later, this page shows its result the next time it reads the chain.")));
  const busyHint = () => !s.busy.waiting && s.busy.hint;

  function view() {
    const aside = (title, text, more) => card(head(title, "not-found", "v3"), h("p", { class: "lead", testid: "refusal" }, text), more,
      h("a", { class: "button secondary", href: v3 ? "#/v3/new" : "#/" }, v3 ? "Prepare a broker deal" : "Back to the start"));
    if (!v3) {
      return card(h("h1", {}, "Broker deals are not set up here"),
        h("p", { class: "lead" }, "This site's config.json names no broker deals contract (contractV3), so broker deals cannot be read here."),
        h("a", { class: "button secondary", href: "#/" }, "Back to the start"));
    }
    if (!sound) return aside("Not a broker deal link", "This link does not carry a broker deal: its end is missing or was changed. Ask the person who sent it for the whole link.");
    if (!here) {
      return aside("A deal of another place", `This link is for chain ${link.chainId} and the deal contract ${link.contract}. This site reads ${networkName(config.chainId)} (chain ${config.chainId}) and the contract `
        + `${v3.contract}. A broker deal's terms are signed for one chain and one contract, so the page does not show this one as if it were here.`);
    }
    if (!s.t) {
      if (s.status === "unknown") {
        return aside("No such funded deal", `The chain has no funded broker deal with the ID ${s.id}. A deal that is not funded yet exists only as its full link, which carries the terms: ask the broker for it.`);
      }
      if (!s.failed) return card(h("p", { class: "loading" }, "Loading the broker deal…"));
      return card(h("h1", {}, "Broker deal"), notice({ kind: "error", text: `This deal could not be read. ${s.failed}` }),
        h("button", { class: "secondary", type: "button", onclick: () => load() }, "Try again"));
    }
    return h("div", { class: "board" },
      // The last read failed: what is shown is what the chain said before, and the page says so.
      s.failed && h("p", { class: "notice warn", testid: "stale", role: "status" }, `The chain could not be read just now, so this page may be out of date. ${s.failed}`),
      // Before a deal is settled or refunded its terms come first: they are what the next wallet signs. Afterwards, its receipt.
      dealCard(), ...(s.status === "settled" || s.status === "refunded" ? [receiptCard(app, s), s.grant && grantCard(app, s, { connect, switchNetwork, claim }), termsCard()]
        : [termsCard(), receiptCard(app, s)]));
  }

  function dealCard() {
    const t = s.t, q = s.quote, m = money(t.quote, t.brokerBps), st = state(), role = roleOf(wallet?.account), vesting = t.delivery === VESTING, done = s.status === "settled";
    const give = amount(t.allocation, s.base), turn = turnOf(st, role, give);
    const [payLabel, receiveLabel] = role === "seller" ? [done ? "The buyer paid" : "The buyer pays", done ? "You sold" : "You sell"]
      : role === "buyer" ? [done ? "You paid" : "You pay", done ? (vesting ? "Your grant was funded with" : "You received") : "You receive"]
      : [done ? "The buyer paid" : "The buyer pays", done ? (vesting ? "The buyer's grant was funded with" : "The buyer received") : "The buyer receives"];
    const sum = (label, testid, units, ...more) => fact(label, h("span", { testid }, formatAmount(units, q.decimals)), ` ${q.symbol}`, ...more);
    const open = st === "awaiting" || st === "funded";
    document.title = `Broker deal ${short(s.id)} (v3): ${give} for ${amount(t.quote, q)} · otc.fam`;
    return card(
      head(`Broker deal ${short(s.id)}`, st, "v3"),
      h("p", { class: `delivery ${vesting ? "vesting" : "immediate"}`, testid: "delivery", "data-delivery": vesting ? "vesting" : "immediate" },
        h("strong", {}, vesting ? "Vesting delivery" : "Immediate delivery"),
        vesting ? ": the buyer gets a new grant that unlocks over time. Settled does not mean unlocked." : ": the buyer gets the tokens in the settlement transaction."),
      h("p", { class: "lead" }, lead(st, role, vesting)),
      h("p", { class: `turn ${turn.who}`, testid: "next-actor", "data-actor": turn.who, role: "status", tabindex: "-1" }, h("strong", {}, turn.title), " ", turn.why),
      waiting(),
      leg(payLabel, m.buyerTotal, q, "pay", `Price ${amount(t.quote, q)} + 0.5% buyer fee ${amount(m.buyerFee, q)}`),
      h("div", { class: "swap-arrow", "aria-hidden": "true" }, "↓"),
      leg(receiveLabel, t.allocation, s.base, "receive", !vesting ? "To the buyer's wallet, at settlement."
        : done ? "As a vesting grant, paid to the buyer out of a vault of its own as it vests." : "As a vesting grant, held in a vault of its own."),
      funding(st, give, vesting),
      h("dl", { class: "facts" },
        sum("Price", "price", t.quote),
        sum("Buyer fee, 0.5% of the price", "buyer-fee", m.buyerFee),
        sum(done ? "Buyer paid in total" : "Buyer pays in total", "buyer-total", m.buyerTotal),
        sum("Seller fee, 0.5% of the price", "seller-fee", m.sellerFee),
        sum(done ? "Seller received" : "Seller receives", "seller-net", m.sellerNet),
        // What the broker gets is said as it stands: to come if the deal settles, paid once it has, never if it cannot settle any more.
        sum(done ? `Broker received ${percent(t.brokerBps)} of both fees` : open ? `Broker receives ${percent(t.brokerBps)} of both fees, only if the deal settles`
          : `Broker would have received ${percent(t.brokerBps)} of both fees: the deal did not settle`, "broker-fee", m.brokerFee, h("span", { class: "mono block", testid: "broker" }, t.broker), role === "broker" && " (you)"),
        sum(done ? "Treasury received the rest of the fees" : open ? "Treasury receives the rest of the fees" : "Treasury would have received the rest of the fees", "treasury-fee", m.treasuryFee, h("span", { class: "mono block", testid: "treasury" }, s.treasury)),
        (open || st === "expired") && h("div", {}, h("dt", {}, st === "awaiting" ? "Can be funded and settled until" : st === "funded" ? "Can be settled until" : "Could be settled until"),
          h("dd", { testid: "expires", "data-expiry": String(t.expiry), class: open && settleBy(t) - now() < 900 ? "soon" : null },
            `${utc(settleBy(t))} (${fromNow(open ? settleBy(t) - now() : Math.min(-1, settleBy(t) - now()))})`))),
      open && h("p", { class: "warning", testid: "token-warning" }, TOKEN_WARNING),
      st === "awaiting" ? sellerActions(t, role, m, give) : st === "funded" ? buyerActions(t, role, m, give) : ended(st, role, give));
  }

  /** Whose turn it is, and why nobody else can move the deal on. */
  function turnOf(st, role, give) {
    const t = s.t, name = (who, address) => (role === who ? `You, the ${who},` : `The ${who}, ${short(address)},`);
    if (st === "awaiting") {
      return { who: "seller", title: "Waiting for the seller to fund.", why: `${name("seller", t.seller)} must sign these terms and deposit the ${give}. Until the chain holds them the deal cannot be settled, by anyone.` };
    }
    if (st === "funded") {
      return { who: "buyer", title: "Waiting for the buyer to settle.", why: `${name("buyer", t.buyer)} must sign these terms and pay. No other wallet can settle, and the seller can take the tokens back until then.` };
    }
    if (st === "settled") {
      if (t.delivery !== VESTING) return { who: "none", title: "Settled.", why: "Nobody has to act: everything was paid and delivered in one transaction." };
      return !s.grant || s.grant.claimed < s.grant.allocation
        ? { who: "buyer", title: "Settled.", why: "Nobody has to act. The buyer claims from the grant as it vests; no other wallet can." }
        : { who: "none", title: "Settled, and the grant is paid out.", why: "Nobody has to act: the buyer has claimed the whole allocation from the grant." };
    }
    if (st === "refunded") return { who: "none", title: "Refunded.", why: "Nobody can act on this deal any more: the seller took the tokens back." };
    if (st === "void") return { who: "none", title: "This deal cannot be funded.", why: voidWhy() };
    return s.status === "funded"
      ? { who: "seller", title: "Expired: it can no longer be settled.", why: `Only ${role === "seller" ? "you, the seller," : `the seller, ${short(t.seller)},`} can act now, to take the ${give} back.` }
      : { who: "none", title: "Expired before it was funded.", why: "Nobody can act on it any more: nothing was deposited, and nothing can be now." };
  }

  /** The line that says what the chain holds for the deal: nothing before it is funded, the whole allocation after. */
  function funding(st, give, vesting) {
    if (s.status === "unfunded") {
      return st === "awaiting" && h("p", { class: "held wait", testid: "funding", "data-funded": "false" },
        `Not funded: the deal contract holds nothing for this deal yet (read at block ${s.block.number}). It is funded when the seller's wallet has deposited the whole ${give}.`);
    }
    if (s.status !== "funded") return null;
    const ok = s.escrow >= s.t.allocation;
    return h("p", { class: ok ? "held" : "held bad", testid: "funding", "data-funded": String(ok) }, ok
      ? `Funded on the chain: the deal contract took the seller's whole ${give}, and holds ${amount(s.escrow, s.base)} now (read at block ${s.block.number}). `
        + `${st !== "funded" ? "" : vesting ? "Settling moves this deal's allocation into the buyer's grant." : "Settling sends this deal's allocation to the buyer."}`
      : `The deal contract holds only ${amount(s.escrow, s.base)}, less than this deal's ${give}. Do not settle it: tell the seller.`);
  }

  function lead(st, role, vesting) {
    const t = s.t;
    if (st === "awaiting") {
      if (role === "seller") return "A broker prepared this deal for you to sell. Check every term, then sign and fund it from this wallet. The link itself moved nothing and gave nobody any right.";
      if (role === "buyer") return "A broker prepared this deal for you to buy. You can check every term now; you can settle once the seller has funded it.";
      if (role === "broker") return "You are this deal's broker. Send this link to the seller first: it shows them the terms and lets them fund the deal.";
      return "A private deal prepared by a broker. Anyone can check its terms here; only its seller can fund it and only its buyer can settle it.";
    }
    if (st === "funded") {
      if (role === "seller") return "Your deal is funded and waits for its buyer. Send them this link: they settle it from their wallet.";
      if (role === "buyer") return "This deal is for you. Check the tokens, the price, the fees and the delivery, then sign and settle it from your wallet.";
      if (role === "broker") return "The seller has funded this deal. Send this link to the buyer: they settle it from their wallet.";
      return "A private deal for one buyer. Anyone can check its terms and its funding here; only the buyer's wallet can settle it.";
    }
    if (st === "settled") {
      if (!vesting) return "Settled: in one transaction the buyer paid, the seller, the broker and the treasury were paid, and the tokens went to the buyer.";
      // What the grant's card says in numbers, in a sentence: the page never says "not unlocked" of a grant that is.
      const g = s.grant, moved = "the buyer paid, and the whole allocation moved into a vault of the grant's own";
      if (g && g.claimed >= g.allocation) return `Settled, and fully claimed: ${moved}; the buyer has since claimed all of it.`;
      if (g && g.vested >= g.allocation) return `Settled, and fully vested: ${moved}; the buyer can claim everything that is left in it.`;
      return `Settled, not unlocked: ${moved}, which pays the buyer as the grant vests.`;
    }
    if (st === "refunded") return "The seller took the allocation back. The deal can no longer be settled; no fee was taken and the broker received nothing.";
    if (st === "void") return "These terms can never become a deal on the chain. Nothing was deposited.";
    const ago = (time) => fromNow(Math.min(-1, Number(time) - now())); // behind it, even by a second
    if (now() >= Number(t.expiry)) return `This deal expired ${ago(t.expiry)}. It can no longer be ${s.status === "funded" ? "settled" : "funded or settled"}.`;
    return `This deal's fixed vesting start passed ${ago(t.fixedStart)}. A grant cannot start before it is funded, so the deal can go no further.`;
  }

  /** The steps and the one button of a press that takes a signature and then a transaction. */
  const walletSteps = (token, last) => ["Connect", `Approve ${token.symbol}`, last];
  /** What a wallet that is not the one whose turn it is reads instead of a button. */
  function notYours(verb, who, address, role, m) {
    const t = s.t, me = wallet.account;
    if (role === "broker") {
      return { kind: "info", text: `You are this deal's broker. You cannot ${verb} it, and the link gives nobody that right: the seller funds and the buyer settles, each from their own wallet. `
        + `You receive ${amount(m.brokerFee, s.quote)} if the buyer settles, and nothing otherwise.` };
    }
    if (role === "buyer") {
      return { kind: "info", text: `This deal is for you, but it is not funded yet. You can settle it once the seller, ${short(t.seller)}, has deposited the tokens: this page shows it as soon as the chain has them.` };
    }
    return { kind: "warn", text: `Only the ${who}, ${address}, can ${verb} this deal. Your wallet is connected as ${short(me)}, so it cannot. If that other address is yours too, switch to it in your wallet.` };
  }

  /** A deal that awaits funding: the seller's button (connect, switch network, approve, sign and fund), and what it is about to do. */
  function sellerActions(t, role, m, give) {
    const steps = walletSteps(s.base, "Sign and fund"), me = wallet?.account;
    if (s.busy) return action({ steps, step: s.busy.step, button: { label: s.busy.label }, hint: busyHint(), announce: true });
    if (!wallet) return action({ steps, step: 0, button: { label: "Connect the seller's wallet to fund" }, notice: { kind: "info", text: NO_WALLET }, extra: copyButton(fullLink(), undefined, "copy-link-first") });
    if (!me) {
      return action({ steps, step: 0, button: { label: "Connect wallet", run: connect }, hint: `Only the seller, ${t.seller}, can fund this deal. Connect that wallet. Nothing is sent yet.`, notice: s.notice });
    }
    if (role !== "seller") return action({ notice: s.notice ?? notYours("fund", "seller", t.seller, role, m) });
    if (wallet.chainId !== config.chainId) return wrongNetwork(steps);
    const f = s.funds;
    if (!f || f.account !== me || !same(f.token, t.baseToken)) return action({ steps, step: 1, button: { label: `Checking your ${s.base.symbol}…` } });
    if (f.balance < t.allocation) {
      return action({ steps, step: 1, button: { label: `Not enough ${s.base.symbol}` }, notice: { kind: "warn", text: `To fund this deal you deposit ${give}, and this wallet holds ${amount(f.balance, s.base)}.` } });
    }
    if (f.allowance < t.allocation) {
      return action({ steps, step: 1, button: { label: `Approve ${give}`, run: approveBase },
        hint: `This lets the deal contract take exactly ${give} from your wallet when you fund the deal. Nothing moves yet.`, notice: s.notice });
    }
    return action({ steps, step: 2, button: { label: "Sign the terms and fund", run: fund },
      hint: `Two requests in your wallet. First your signature of the terms on this page: it sends nothing. Then one transaction: your ${give} move into the deal contract, and stay `
        + "there until the buyer settles or you take them back. Funding costs no fee and pays the broker nothing.", notice: s.notice });
  }

  /** A funded deal: the buyer's button (connect, switch network, approve, sign and settle); to the seller, the way to take the tokens back. */
  function buyerActions(t, role, m, give) {
    const q = s.quote, steps = walletSteps(q, "Sign and settle"), me = wallet?.account, total = amount(m.buyerTotal, q), vesting = t.delivery === VESTING;
    if (s.busy?.step === null) return action({ hint: busyHint(), announce: true, extra: secondary("refund-action", s.busy.label) });
    if (s.busy) return action({ steps: role === "seller" ? null : steps, step: s.busy.step, button: { label: s.busy.label }, hint: busyHint(), announce: true });
    if (!wallet) return action({ steps, step: 0, button: { label: "Connect the buyer's wallet to settle" }, notice: { kind: "info", text: NO_WALLET }, extra: copyButton(fullLink(), undefined, "copy-link-first") });
    if (!me) {
      return action({ steps, step: 0, button: { label: "Connect wallet", run: connect }, hint: `Only the buyer, ${t.buyer}, can settle this deal. Connect that wallet. Nothing is sent yet.`, notice: s.notice });
    }
    if (role === "seller") {
      const yours = `This is your own deal: only its buyer can settle it. Until then you can take back your ${give}. A refund costs no fee and pays the broker nothing.`;
      // A wallet on another network cannot send the refund: it is offered the switch first, as the buyer's is.
      if (wallet.chainId !== config.chainId) return wrongNetwork(null, yours);
      return action({ notice: s.notice ?? { kind: "info", text: yours }, extra: secondary("refund-action", `Refund: take back ${give}`, refund) });
    }
    if (role !== "buyer") return action({ notice: s.notice ?? notYours("settle", "buyer", t.buyer, role === "broker" ? "broker" : "other", m) });
    if (wallet.chainId !== config.chainId) return wrongNetwork(steps);
    const f = s.funds;
    if (!f || f.account !== me || !same(f.token, t.quoteToken)) return action({ steps, step: 1, button: { label: `Checking your ${q.symbol}…` } });
    if (f.balance < m.buyerTotal) {
      return action({ steps, step: 1, button: { label: `Not enough ${q.symbol}` },
        notice: { kind: "warn", text: `To settle this deal you pay ${total} (the price and the 0.5% buyer fee), and this wallet holds ${amount(f.balance, q)}.` } });
    }
    if (f.allowance < m.buyerTotal) {
      return action({ steps, step: 1, button: { label: `Approve ${total}`, run: approveQuote },
        hint: `This lets the deal contract take exactly ${total} from your wallet, the price and the buyer fee, and only when you settle. Nothing moves yet.`, notice: s.notice });
    }
    return action({ steps, step: 2, button: { label: `Sign and settle: pay ${total}`, run: settle },
      hint: `Two requests in your wallet. First your signature of the terms on this page: it sends nothing. Then one transaction: you pay ${total}, the seller receives ${amount(m.sellerNet, q)}, `
        + `the broker receives ${amount(m.brokerFee, q)}, the treasury receives ${amount(m.treasuryFee, q)}, and ${vesting ? `the ${give} move into a vault for your grant` : `the ${give} come to your wallet`}. `
        + "All of it happens, or nothing moves.", notice: s.notice });
  }

  const wrongNetwork = (steps, first = "") => action({ steps, step: 0, button: { label: `Switch to ${networkName(config.chainId)}`, run: switchNetwork },
    hint: `${first}${first && " "}Your wallet is on ${networkName(wallet.chainId)}, and this deal is on ${networkName(config.chainId)}. Nothing can be signed or sent until it is switched.`, notice: s.notice });

  /** What a settled, refunded, expired or impossible deal offers: nothing to settle; to its seller, an expired deal's tokens back. */
  function ended(st, role, give) {
    const vesting = s.t.delivery === VESTING, again = h("a", { class: "button secondary", testid: "duplicate", href: `#/v3/new/${packTerms(s.t)}` }, "Duplicate these terms into a new deal");
    if (st === "settled") {
      return h("div", { class: "action" },
        h("p", { class: "success" }, vesting ? `The grant was funded with all ${give} at settlement. Its schedule, and what is vested, claimed and still locked now, are in the grant's card on this page.`
          : `Delivered: all ${give} went to the buyer's wallet in the settlement transaction. That wallet holds ${amount(s.buyerHolds, s.base)} now.`),
        !vesting && s.notice && notice(s.notice));
    }
    if (s.status !== "funded") return h("div", { class: "action" }, s.notice && notice(s.notice), again);
    if (role !== "seller") {
      return h("div", { class: "action" },
        h("p", { class: "hint" }, `The seller's ${give} stay in the deal contract until the seller takes them back.`),
        wallet && !wallet.account && secondary("connect-action", s.busy?.label ?? "Sold this? Connect to take your tokens back", !s.busy && connect),
        s.notice && notice(s.notice));
    }
    if (!s.busy && wallet.chainId !== config.chainId) return wrongNetwork(null, `Only you can act on this deal now, to take your ${give} back.`);
    return h("div", { class: "action" },
      secondary("refund-action", s.busy?.label ?? `Refund: take back your ${give}`, !s.busy && refund),
      s.busy && busyHint() && h("p", { class: "hint", role: "status" }, s.busy.hint),
      s.notice && notice(s.notice));
  }

  /** The terms as the two wallets sign them, field by field, with what each means, and what the signature is bound to. */
  function termsCard() {
    const t = s.t, vesting = t.delivery === VESTING, role = roleOf(wallet?.account);
    const raw = (name, ...meaning) => fact(name, h("span", { class: "mono", testid: `terms-${name}` }, String(t[name])), ...meaning);
    const you = (who) => role === who && " (you)";
    return card(h("h2", {}, "The terms both parties sign"),
      h("p", { class: "lead" }, "The seller signs these terms to fund the deal, and the buyer signs the same terms to settle it. A wallet shows them field by field, as here. "
        + "They cannot be changed: other terms are another deal, with another ID."),
      h("dl", { class: "facts terms", testid: "terms" },
        raw("seller", you("seller")), raw("buyer", you("buyer")),
        raw("baseToken", ` ${s.base.symbol}, ${s.base.decimals} decimals`), raw("quoteToken", ` ${s.quote.symbol}, ${s.quote.decimals} decimals`),
        raw("allocation", ` = ${amount(t.allocation, s.base)}`), raw("quote", ` = ${amount(t.quote, s.quote)}`),
        raw("expiry", ` = ${utc(t.expiry)}`), raw("nonce", " (the seller can use a nonce once)"),
        raw("delivery", vesting ? " = a new vesting grant" : " = immediate"),
        raw("fixedStart", !vesting ? " (no schedule)" : t.fixedStart ? ` = ${utc(t.fixedStart)}` : " = the grant starts when the buyer settles"),
        raw("cliffSeconds", vesting && (t.cliffSeconds ? ` = ${span(t.cliffSeconds)}: nothing can be claimed before it` : " = no cliff")),
        raw("durationSeconds", vesting && ` = ${span(t.durationSeconds)} from the start to fully vested`),
        raw("broker", you("broker")), raw("brokerBps", ` = ${percent(t.brokerBps)} of both fees`)),
      h("dl", { class: "facts" },
        fact("Signed for", h("span", { testid: "terms-domain" }, `${DOMAIN.name}, version ${DOMAIN.version}`)),
        fact("Network", h("span", { testid: "terms-network" }, `${networkName(config.chainId)}, chain ${config.chainId}`)),
        fact("Deal contract, v3", h("span", { class: "mono", testid: "terms-contract" }, v3.contract)),
        fact("Deal ID: the digest a wallet signs", h("span", { class: "mono", testid: "deal-id" }, s.id))),
      h("div", { class: "row" }, copyButton(fullLink()), h("a", { class: "button secondary", testid: "duplicate-terms", href: `#/v3/new/${packTerms(t)}` }, "Duplicate terms")));
  }

  /** The account's signature of the deal's terms: asked of the wallet once, then kept while this page is open. */
  async function signature(stage) {
    const account = wallet.account, key = `${s.id}:${account}`;
    if (!signed.has(key)) {
      stage("Sign the deal's terms in your wallet: it shows the same terms as this page. Signing sends nothing.");
      const signature = await signTerms(app, s.t);
      if (wallet.account !== account) throw say("Your wallet changed account while it was signing. Press again to sign with the account it has now.");
      signed.set(key, signature);
    }
    return signed.get(key);
  }

  const connect = () => presses.act("Connecting…", 0, () => wallet.connect());
  const switchNetwork = () => presses.act("Switching network…", 0, () => wallet.switchTo(config.chainId));
  const approveBase = () => presses.act(`Approving ${amount(s.t.allocation, s.base)}…`, 1, (stage) => approveExactly(app, s.base, s.t.allocation, s.funds.allowance, stage, v3.contract));
  const approveQuote = () => {
    const total = money(s.t.quote, s.t.brokerBps).buyerTotal;
    return presses.act(`Approving ${amount(total, s.quote)}…`, 1, (stage) => approveExactly(app, s.quote, total, s.funds.allowance, stage, v3.contract));
  };
  /** Sends the transaction that carries the account's signature. A signature the contract refuses is not kept: the next press asks the wallet for it again. */
  async function signedSend(stage, sent, dataFor, what) {
    const key = `${s.id}:${wallet.account}`;
    try {
      return await transact(app, v3.contract, dataFor(await signature(stage)), stage, what, sent);
    } catch (e) {
      if (refusalOf(e) === BAD_SIGNATURE) signed.delete(key);
      throw e;
    }
  }
  const fund = () => presses.act("Signing and funding…", 2, (stage, sent) =>
    signedSend(stage, sent, (signature) => fundData(s.t, signature), `Funding the deal with ${amount(s.t.allocation, s.base)}`));
  const settle = () => presses.act("Signing and settling…", 2, (stage, sent) =>
    signedSend(stage, sent, (signature) => settleData(s.id, signature), `Paying ${amount(money(s.t.quote, s.t.brokerBps).buyerTotal, s.quote)} for ${amount(s.t.allocation, s.base)}`));
  const refund = () => presses.act("Refunding…", null, (stage, sent) => transact(app, v3.contract, refundData(s.id), stage, "Taking the allocation back", sent));
  const claim = () => presses.act("Claiming…", 1, (stage, sent) => transact(app, v3.contract, claimData(s.grantId), stage, `Claiming ${amount(s.grant.claimable, s.base)}`, sent));

  load().then(() => here && presses.resume(() => {
    s.notice = { kind: "info", text: "The transaction sent before this page was reloaded is confirmed. What you see is the chain's state now." };
  }));
  return {
    // The wallet changed its account or its network: what the page said to the wallet as it was is not about this
    // one, and everything is read from the chain again.
    update() {
      const now = walletNow();
      if (now !== walletSeen && !s.busy) s.notice = null;
      walletSeen = now;
      return s.busy || load();
    },
    stop() {
      live = false;
      presses.stop();
      clearInterval(poll);
      clearTimeout(timer);
      removeEventListener("focus", onFocus);
      app.main.classList.remove("wide");
    },
  };
}
