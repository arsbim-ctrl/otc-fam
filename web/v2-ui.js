import { approveData, explain } from "./eth.js";
import { amount, h, networkName, NO_WALLET } from "./ui.js";
import { checkTransaction, sendV2, tabStorage, transactionMessage } from "./v2-transactions.js";
import { fees, NEW_VESTING } from "./v2-chain.js";

export const TEST_NETWORKS = new Set([31337, 1337, 84532, 11155111]);

export function dealLink(config, id) {
  return `${location.href.split("#")[0]}#/v2/d/${config.chainId}/${config.v2Contract.toLowerCase()}/${id}`;
}

export function utc(seconds) {
  if (seconds > 253_402_300_799n) return `Unix time ${seconds} seconds (UTC)`;
  return new Date(Number(seconds) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export function lengthText(seconds) {
  if (seconds === 0n) return "0 seconds";
  return seconds % 86400n === 0n ? `${seconds / 86400n} days` : `${seconds} seconds`;
}

export const money = (units, token) => amount(units, token).trim();
export const addressText = (value) => h("span", { class: "mono" }, value);

export function economics(quote, token) {
  const f = fees(quote);
  return [
    ["Quoted payment", money(quote, token)],
    ["Buyer fee · 0.5%", money(f.each, token)],
    ["Seller fee · 0.5%", money(f.each, token)],
    ["Buyer pays", money(f.buyerTotal, token)],
    ["Seller receives", money(f.sellerNet, token)],
    ["Treasury receives", money(f.pool, token)],
  ];
}

export function scheduledTerms(t) {
  if (t.delivery !== NEW_VESTING) return [];
  const start = t.fixedStart;
  return [
    ["Start (UTC)", start ? utc(start) : "Settlement block time"],
    ["Cliff (UTC)", start ? utc(start + t.cliffSeconds) : `${lengthText(t.cliffSeconds)} after settlement`],
    ["End (UTC)", start ? utc(start + t.durationSeconds) : `${lengthText(t.durationSeconds)} after settlement`],
  ];
}

export function facts(rows, className = "facts") {
  return h("dl", { class: className }, rows.map(([label, value]) => h("div", {}, h("dt", {}, label), h("dd", {}, value))));
}

export function panel(id, title, ...children) {
  return h("section", { class: "v2-panel", "aria-labelledby": id },
    h("h2", { id }, title), ...children);
}

export function replaceChanged(slot, next) {
  const current = slot.firstElementChild;
  if (current?.isEqualNode(next)) return;
  slot.replaceChildren(next);
}

export function wireButton(button, state, label, run) {
  if (button.textContent !== label) button.textContent = label;
  button.disabled = !run;
  state.run = run;
}

export function walletAction({ wallet, config }, flow, refresh) {
  if (!wallet) return { hint: NO_WALLET };
  if (!wallet.account) return { label: "Connect wallet", run: () => flow.run("Connecting wallet…", () => wallet.connect(), refresh) };
  if (wallet.chainId !== config.chainId) {
    const network = networkName(config.chainId);
    return {
      label: `Switch to ${network}`,
      hint: `Your wallet is on ${networkName(wallet.chainId)}. This deal uses ${network}.`,
      run: () => flow.run("Switching network…", () => wallet.switchTo(config.chainId), refresh),
    };
  }
  return {};
}

export async function submitApproval(app, from, token, units, allowance) {
  const { chain } = app;
  let data = approveData(chain.contract, units);
  let kind = "approve";
  const validApproval = (answer) => {
    if (answer !== "0x" && BigInt(answer) !== 1n) throw new Error("The token refused the approval.");
  };
  try {
    validApproval(await chain.call(token.address, data, from));
  } catch (error) {
    if (!allowance) throw error;
    data = approveData(chain.contract, 0n);
    validApproval(await chain.call(token.address, data, from));
    kind = "reset-approval";
  }
  return sendV2(app, { to: token.address, data, kind, from });
}

export function transactionFlow(app, key, render, onResult) {
  const storage = tabStorage(key);
  const saved = storage.get();
  const flow = { job: saved?.job ?? null, last: saved?.last ?? null, busy: null, feedback: null };
  let checking = false;

  function save() {
    storage.set({ job: flow.job, last: flow.last });
  }

  flow.run = async (label, work, refresh) => {
    if (flow.busy || flow.job) return;
    flow.busy = label;
    flow.feedback = null;
    render();
    try {
      const job = await work();
      if (job) {
        flow.job = job;
        save();
      }
    } catch (error) {
      flow.feedback = { kind: "error", text: explain(error) };
    } finally {
      flow.busy = null;
      render();
      await refresh();
    }
  };

  flow.check = async (block) => {
    if (!flow.job || checking) return;
    checking = true;
    try {
      const result = await checkTransaction(app.chain, flow.job, block);
      if (!result) return;
      const job = flow.job;
      const resultMessage = transactionMessage(job, result);
      if (result.status === "confirmed") onResult?.(job, result.receipt);
      flow.feedback = resultMessage;
      flow.last = { hash: result.hash, status: result.status, kind: job.kind };
      flow.job = null;
    } finally {
      checking = false;
      save();
    }
  };

  return flow;
}

export function txHash(config, hash) {
  const href = config.explorerUrl ? `${config.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
  return href ? h("a", { href, class: "mono", target: "_blank", rel: "noopener noreferrer" }, hash)
    : addressText(hash);
}

export function transactionStatus(config, flow) {
  const feedback = flow.feedback;
  return h("div", { class: "v2-feedback", role: "status", "aria-live": "polite" },
    flow.busy && h("p", { class: "hint" }, flow.busy),
    flow.job && h("div", { class: "notice info" },
      h("p", {}, "Waiting for a transaction receipt. Check your wallet activity for a pending or replaced transaction."),
      txHash(config, flow.job.hash)),
    feedback && h("p", { class: `notice ${feedback.kind}`, testid: "notice" }, feedback.text),
    flow.last && !flow.job && h("p", { class: "hint v2-last" }, `Last transaction · ${flow.last.status} `, txHash(config, flow.last.hash)));
}

export function tokenWarning() {
  return h("p", { class: "v2-token-warning" },
    "Verify both token contracts and the designated buyer address. Fee-on-transfer, rebasing and frozen tokens are unsuitable for escrow.");
}
