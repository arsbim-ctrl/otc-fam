import { amount, fact, h, notice } from "./ui.js";
import { economics, findReceipt, NEW_VESTING, sendV2, v2Reason } from "./vesting-chain.js";

export const deliveryName = (delivery) => delivery === NEW_VESTING ? "New vesting grant" : "Immediate delivery";
export const mono = (value) => h("span", { class: "mono" }, value);

export function utc(time) {
  return time <= 253_402_300_799n
    ? new Date(Number(time) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")
    : String(time) + " Unix seconds (UTC)";
}

export function readSession(key) {
  try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
}

export function saveSession(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A browser that disables storage can still show the current on-chain state.
  }
}

export function fees(quote, token, treasury) {
  const { fee, buyerTotal, sellerNet, feePool } = economics(quote);
  return h("dl", { class: "facts v2-fees", "aria-label": "Payment and fees", testid: "v2-fees" },
    fact("Agreed payment", amount(quote, token)),
    fact("Buyer fee · 0.5%", amount(fee, token)),
    fact("Seller fee · 0.5%", amount(fee, token)),
    fact("Buyer pays", amount(buyerTotal, token)),
    fact("Seller receives", amount(sellerNet, token)),
    fact("Treasury receives", amount(feePool, token)),
    treasury && h("div", { class: "v2-wide" }, h("dt", {}, "Fee treasury"), h("dd", {}, mono(treasury))));
}

export function schedule(terms) {
  if (terms.delivery !== NEW_VESTING) return null;
  const { fixedStart, cliffSeconds, durationSeconds } = terms;
  return h("dl", { class: "facts v2-fees", "aria-label": "Committed vesting schedule" },
    fact("Accrual starts", fixedStart ? utc(fixedStart) : "At settlement (block time)"),
    fact("Cliff", fixedStart ? utc(fixedStart + cliffSeconds) : secondsLabel(cliffSeconds) + " after start"),
    fact("End", fixedStart ? utc(fixedStart + durationSeconds) : secondsLabel(durationSeconds) + " after start"));
}

function secondsLabel(seconds) {
  return seconds % 86400n === 0n && seconds !== 0n ? String(seconds / 86400n) + " days" : String(seconds) + " seconds";
}

export function receiptLink(config, hash) {
  const explorer = { 84532: "https://sepolia.basescan.org/tx/", 11155111: "https://sepolia.etherscan.io/tx/" }[config.chainId];
  return explorer ? h("a", { href: explorer + hash, target: "_blank", rel: "noopener noreferrer", class: "mono" }, hash)
    : mono(hash);
}

export function operation(app, name, handlers) {
  const key = ["otc-v2", app.config.chainId, app.config.contract.toLowerCase(), name].join(":");
  const state = { pending: readSession(key), busy: false, message: null, receipt: null, stage: "" };

  function stage(text) {
    state.stage = text;
    handlers.render();
  }

  function setPending(tx) {
    state.pending = tx;
    saveSession(key, tx);
  }

  async function complete() {
    const result = await findReceipt(app.chain, state.pending);
    if (result.replaced) {
      setPending(null);
      state.message = { kind: "warn", text: "The wallet replaced or cancelled this transaction. Review the current on-chain state before trying again." };
    } else if (result.receipt) {
      const { kind } = state.pending;
      setPending(null);
      state.receipt = result.receipt.transactionHash;
      if (result.receipt.status === "0x1") handlers.onReceipt?.(kind, result.receipt);
      else state.message = { kind: "error", text: "The transaction reverted. No funds moved. Review the current state and try again." };
    } else {
      state.message = { kind: "info", text: "The transaction is still unconfirmed. Check the wallet activity or check its receipt again here." };
    }
  }

  async function run(work) {
    if (state.busy) return;
    Object.assign(state, { busy: true, message: null, stage: "" });
    handlers.render();
    try {
      await work();
    } catch (error) {
      state.message = { kind: "error", text: v2Reason(error) };
    } finally {
      state.busy = false;
      state.stage = "";
      handlers.refresh();
    }
  }

  return {
    state,
    wallet: (work) => run(work),
    transact: (kind, to, data) => run(async () => {
      if (state.pending) return;
      const prepared = typeof data === "function" ? await data() : data;
      const tx = await sendV2(app, to, prepared, stage);
      setPending({ ...tx, kind });
      stage("Transaction sent. Waiting for confirmation.");
      await complete();
    }),
    resume: () => state.pending && run(complete),
  };
}

export function transactionStatus(config, tx) {
  const { pending, receipt, message, stage } = tx.state;
  return [
    stage && h("p", { class: "hint", role: "status" }, stage),
    message && notice(message),
    (pending || receipt) && h("p", { class: "hint v2-tx", testid: "v2-receipt" }, pending ? "Pending transaction " : "Receipt ", receiptLink(config, pending?.hash ?? receipt)),
  ];
}

export function draw(main, next) {
  const current = main.firstElementChild;
  const details = next.querySelector("details");
  if (details && current?.querySelector("details")?.open) details.open = true;
  if (current?.isEqualNode(next)) return;
  const active = document.activeElement;
  const testid = current?.contains(active) && active.getAttribute("data-testid");
  main.replaceChildren(next);
  if (testid) {
    const replacement = next.querySelector('[data-testid="' + testid + '"]');
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  }
}
