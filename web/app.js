import { address, loadChain, MAX_AMOUNT, switchNetwork, walletState, ZERO_ADDRESS } from "./chain.js";
import { bind, getForm, render } from "./view.js";

const wallet = typeof window.ethereum?.request === "function" ? window.ethereum : null;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (text, tone = "info") => ({ text, tone });
const wrongWallet = (deal, account) => account && deal.taker !== ZERO_ADDRESS && account !== deal.taker;
const pendingKey = `otc.fam:pending-transaction:${location.pathname}`;
const shareKey = `otc.fam:confirmed-deal:${location.pathname}`;
const transactionHash = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);

let chain, loadingChain;
let current;
let navigation = 0;
let formTimer;
let identity = { account: null, chainId: null };
let walletVersion = 0;
let walletReading = false;
let operation;
const newPage = { screen: "new", reading: 0 };

function network() {
  loadingChain ??= loadChain().then((value) => (chain = value)).catch((error) => {
    loadingChain = undefined;
    throw error;
  });
  return loadingChain;
}

function status(deal, blockTime) {
  return deal?.status === "open" && (deal.expiry <= now() || deal.expiry <= blockTime) ? "expired" : deal?.status;
}

function storePending(job) {
  try {
    if (!job) sessionStorage.removeItem(pendingKey);
    else sessionStorage.setItem(pendingKey, JSON.stringify({
      hash: job.hash, kind: job.kind, account: job.owner.account, taker: job.taker, token: job.token,
      chainId: chain.chainId, contract: chain.contract, screen: job.page.screen,
      dealId: job.page.id?.toString(), amount: job.amount.toString(),
    }));
  } catch {
    // Keep tracking in the current page when browser storage is unavailable.
  }
}

function dealLink(id) {
  const link = new URL(location.href);
  link.search = "";
  link.hash = `/d/${id}`;
  return link.href;
}

function storeShare(id) {
  try {
    if (id === null) sessionStorage.removeItem(shareKey);
    else sessionStorage.setItem(shareKey, JSON.stringify({ id: String(id), chainId: chain.chainId, contract: chain.contract }));
  } catch {
    // The confirmed link remains available until the tab is closed or reloaded.
  }
}

async function restoreShare(api) {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(shareKey));
  } catch {
    return null;
  }
  if (saved?.chainId !== api.chainId || saved.contract !== api.contract
      || typeof saved.id !== "string" || !/^[1-9]\d{0,77}$/.test(saved.id)) return null;
  const id = BigInt(saved.id);
  if (id > MAX_AMOUNT || (await api.deal(id)).status === "not-found") return null;
  return dealLink(id);
}

export function formatAmount(amount, precision) {
  if (!precision) return amount.toString();
  const digits = amount.toString().padStart(precision + 1, "0");
  const fraction = digits.slice(-precision).replace(/0+$/, "");
  return fraction ? `${digits.slice(0, -precision)}.${fraction}` : digits.slice(0, -precision);
}

function amountParts(value) {
  if (value.length > 340 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return { whole: BigInt(whole || "0"), fraction };
}

export function parseAmount(value, precision) {
  const parts = amountParts(value);
  if (!parts) throw new Error("Enter a positive amount using a decimal point.");
  if (parts.fraction.length > precision) {
    throw new Error(precision ? `This token supports up to ${precision} decimal places.` : "This token only supports whole amounts.");
  }
  const units = parts.whole * 10n ** BigInt(precision) + BigInt(parts.fraction.padEnd(precision, "0") || "0");
  if (units < 1n) throw new Error("Enter an amount greater than zero.");
  if (units > MAX_AMOUNT) throw new Error("This amount is too large.");
  return units;
}

function formKey(fields) {
  return JSON.stringify(fields);
}

async function readDraft(fields, api) {
  const errors = {};
  const sellToken = address(fields["sell-token"].trim());
  const buyToken = address(fields["buy-token"].trim());
  const taker = address(fields.taker.trim()) ?? (fields.taker.trim() ? null : ZERO_ADDRESS);
  if (!sellToken || sellToken === ZERO_ADDRESS) errors["sell-token"] = "Enter the full address of the token you offer.";
  if (!buyToken || buyToken === ZERO_ADDRESS) errors["buy-token"] = "Enter the full address of the token you want.";
  if (sellToken && buyToken === sellToken) errors["buy-token"] = "Choose a different token for each side.";
  if (!taker) errors.taker = "Enter a full wallet address or leave it blank for anyone.";
  const period = amountParts(fields["expiry-hours"].trim());
  let duration;
  if (period) {
    const scale = 10n ** BigInt(period.fraction.length);
    const seconds = (period.whole * scale + BigInt(period.fraction || "0")) * 3600n;
    if (seconds % scale === 0n) duration = seconds / scale;
  }
  if (!duration || duration > (1n << 63n)) errors["expiry-hours"] = "Enter hours greater than zero that resolve to whole seconds.";
  if (Object.keys(errors).length) return { errors };

  const tokens = await Promise.allSettled([api.token(sellToken), api.token(buyToken)]);
  const sides = ["sell", "buy"];
  const amounts = tokens.map((token, index) => {
    const side = sides[index];
    if (token.status === "rejected") {
      errors[`${side}-token`] = "Couldn’t read this token on the configured network. Check the address.";
      return null;
    }
    try {
      return parseAmount(fields[`${side}-amount`].trim(), token.value.precision);
    } catch (error) {
      errors[`${side}-amount`] = error.message;
      return null;
    }
  });
  if (Object.keys(errors).length) return { errors };
  return { draft: { sellToken, buyToken, taker, duration, sellAmount: amounts[0], buyAmount: amounts[1], sell: tokens[0].value } };
}

function spend(page) {
  if (page.screen === "new" && page.draft) {
    const { sellToken, sellAmount, sell } = page.draft;
    return { token: sellToken, amount: sellAmount, meta: sell };
  }
  if (page.deal && page.buy) {
    return { token: page.deal.buyToken, amount: page.deal.buyAmount, meta: page.buy };
  }
  return null;
}

function actionFor(page) {
  if (operation && !operation.busy) return null;
  if (page.error || page.loading || !chain || page.link || page.screen === "home") return null;
  if (page.screen === "new" && !page.shareChecked) return null;
  if (page.screen === "deal" && (status(page.deal, page.blockTime) !== "open" || wrongWallet(page.deal, identity.account))) return null;
  if (!wallet) return { kind: "unavailable", label: "Wallet required", enabled: false };
  if (!identity.account) return { kind: "connect", label: "Connect wallet", enabled: true };
  if (identity.chainId !== BigInt(chain.chainId)) return { kind: "switch", label: `Switch to chain ${chain.chainId}`, enabled: true };
  if (page.screen === "new" && !page.draft) return { kind: "review", label: "Review deal", enabled: true };
  if (!page.funds || page.funds.owner !== identity) return { kind: "checking", label: "Checking balance…", enabled: false };
  const { amount, meta } = spend(page);
  if (page.funds.balance < amount) return { kind: "insufficient", label: "Insufficient balance", enabled: false };
  if (page.funds.allowance < amount) {
    if (page.funds.allowance > 0n) return { kind: "reset", label: "Reset token approval", enabled: true };
    return { kind: "approve", label: "Approve token", enabled: true, symbol: meta.symbol };
  }
  return page.screen === "new" ? { kind: "create", label: "Create deal", enabled: true } : { kind: "fill", label: "Fill deal", enabled: true };
}

function guidance(page, action, dealStatus) {
  if (operation?.busy) return message(operation.text);
  if (operation?.unknownSubmission) return message("Your wallet did not return a transaction hash. Check its activity before trying another transaction.", "error");
  if (operation?.receiptProblem) return message("The transaction succeeded, but the deal link could not be recovered from its receipt. Check the transaction in your wallet before trying again.", "error");
  if (operation?.needsNetwork) return message("The saved transaction could not be checked with the site’s current network connection. Check your wallet activity.", "error");
  if (operation?.hash) return message("The transaction was sent and still needs a receipt. Check its status before trying another transaction.");
  if (page.error) return message(page.error, "error");
  if (page.screen === "deal" && dealStatus === "open" && wrongWallet(page.deal, identity.account)) {
    return message(`This deal is for another address: ${page.deal.taker}. Switch to that account to fill it.`, "error");
  }
  if (page.notice) return page.notice;
  if (action?.kind === "unavailable") return message("Open this link in a browser with an Ethereum wallet to continue.");
  if (action?.kind === "switch") return message(`Your wallet is on chain ${identity.chainId}. This deal site uses chain ${chain.chainId}.`, "error");
  if (action?.kind === "approve") {
    const { amount, meta } = spend(page);
    return message(`Allow the deal contract to spend ${formatAmount(amount, meta.precision)} ${meta.symbol} for this deal.`);
  }
  if (action?.kind === "reset") return message("Clear the existing token approval first. Then approve the exact amount for this deal.");
  if (action?.kind === "insufficient") {
    const { amount, meta } = spend(page);
    return message(`This wallet needs ${formatAmount(amount, meta.precision)} ${meta.symbol} to continue.`, "error");
  }
  if (action?.kind === "fill") return message("Review the terms and confirm the swap in your wallet.");
  if (action?.kind === "create") return message("Review the terms and confirm the new deal in your wallet.");
  return null;
}

function paint() {
  if (!current) return;
  const page = current;
  const action = actionFor(page);
  const dealStatus = status(page.deal, page.blockTime);
  const raw = page.deal;
  const deal = raw ? {
    ...raw, id: String(raw.id), expiry: String(raw.expiry), status: dealStatus,
    payAmount: page.buy ? formatAmount(raw.buyAmount, page.buy.precision) : "—", paySymbol: page.buy?.symbol,
    receiveAmount: page.sell ? formatAmount(raw.sellAmount, page.sell.precision) : "—", receiveSymbol: page.sell?.symbol,
    payToken: raw.buyToken, receiveToken: raw.sellToken,
  } : null;
  const screen = page.screen === "deal" && !raw ? (page.loading ? "loading" : "error") : page.screen;
  const pending = Boolean(operation?.busy);
  const awaitingReceipt = Boolean(operation?.hash) && !pending;
  render({
    screen, deal, chainId: chain?.chainId, account: identity.account, pending,
    action: action && { ...action, enabled: action.enabled && !pending && !walletReading },
    notice: guidance(page, action, dealStatus), retry: (Boolean(page.error) || awaitingReceipt) && !pending,
    retryLabel: awaitingReceipt ? "Check transaction status" : undefined,
    formErrors: page.attempted ? page.formErrors : null, dealLink: page.link,
  });
}

async function refresh(page) {
  const ticket = ++page.reading;
  const owner = identity;
  const fields = page.screen === "new" ? getForm() : null;
  const isCurrent = () => page === current && ticket === page.reading && owner === identity
    && (!fields || formKey(fields) === formKey(getForm()));
  try {
    const api = await network();
    if (page.screen === "deal" && page.id !== null) {
      const deal = await api.deal(page.id);
      const sameTokens = page.deal?.sellToken === deal.sellToken && page.deal?.buyToken === deal.buyToken;
      if (deal.status === "not-found") {
        if (isCurrent()) Object.assign(page, { deal, error: null, funds: null, loading: false });
        return;
      }
      const [block, sell, buy] = await Promise.allSettled([
        api.latestTime(), sameTokens && page.sell ? page.sell : api.token(deal.sellToken), sameTokens && page.buy ? page.buy : api.token(deal.buyToken),
      ]);
      if (!isCurrent()) return;
      Object.assign(page, { deal, loading: false, blockTime: block.value, sell: sell.value, buy: buy.value });
      if (!page.buy || !page.sell) throw new Error("Couldn’t verify the deal’s token details. Try the network again.");
    }
    if (fields && !page.shareChecked) {
      const restored = await restoreShare(api);
      if (!isCurrent()) return;
      if (restored) page.link = restored;
      page.shareChecked = true;
    }
    if (fields && !page.link) {
      const key = formKey(fields);
      const result = page.draftKey === key && page.draft ? { draft: page.draft } : await readDraft(fields, api);
      if (!isCurrent()) return;
      Object.assign(page, { draft: result.draft, draftKey: key, formErrors: result.errors });
    }
    if (!isCurrent()) return;
    page.error = null;
    const payment = spend(page);
    const canReadFunds = payment && owner.account && owner.chainId === BigInt(api.chainId)
      && (page.screen === "new" ? !page.link : status(page.deal, page.blockTime) === "open" && !wrongWallet(page.deal, owner.account));
    const funds = canReadFunds ? { ...await api.funds(payment.token, owner.account), owner } : null;
    if (isCurrent()) page.funds = funds;
  } catch (error) {
    if (isCurrent()) {
      page.loading = false;
      page.error = error.message === "Failed to fetch" ? "Couldn’t reach the deal network. Check your connection and try again." : error.message;
      page.funds = null;
    }
  } finally {
    if (isCurrent()) paint();
  }
}

async function syncWallet(refreshPage = true) {
  const ticket = ++walletVersion;
  walletReading = Boolean(wallet);
  paint();
  try {
    const connected = await walletState(wallet);
    if (ticket === walletVersion) identity = connected;
  } catch {
    if (ticket === walletVersion) identity = { account: null, chainId: null };
  } finally {
    if (ticket === walletVersion) {
      walletReading = false;
      paint();
      if (refreshPage && current && !operation && current.screen !== "home") await refresh(current);
    }
  }
}

function walletChanged() {
  identity = { account: null, chainId: null };
  if (current && !operation) current.notice = null;
  void syncWallet();
}

function navigate() {
  navigation++;
  clearTimeout(formTimer);
  const hash = location.hash;
  const match = /^#\/d\/(\d{1,78})$/.exec(hash);
  if (hash === "#/new") current = newPage;
  else if (hash.startsWith("#/d")) {
    const id = match && BigInt(match[1]) <= MAX_AMOUNT ? BigInt(match[1]) : null;
    current = { screen: "deal", id, loading: id !== null, reading: 0 };
    if (id === null) current.deal = { id: "", expiry: 0n, status: "not-found" };
  } else current = { screen: "home", reading: 0 };
  paint();
  if (current.screen !== "home" && !(current.screen === "deal" && current.id === null)) void refresh(current);
}

function userError(error) {
  if (error?.code === 4001) return "You declined the request in your wallet. You can try again when ready.";
  if (error?.code === 4902 || error?.code === 4200) return `Switch to chain ${chain.chainId} in your wallet, then try again.`;
  return error?.publicMessage ?? "The request couldn’t be completed. Check your wallet and try again.";
}

function userFailure(publicMessage) {
  return Object.assign(new Error(publicMessage), { publicMessage });
}

async function checkReceipt(job) {
  job.busy = true;
  job.text = "Transaction sent. Waiting for the network to confirm it…";
  paint();
  let receipt;
  for (const end = Date.now() + 30_000; Date.now() < end && !receipt;) {
    const found = await chain.receipt(job.hash).catch(() => null);
    if (transactionHash(found?.transactionHash) && found.transactionHash.toLowerCase() === job.hash.toLowerCase()
        && (found.status === "0x1" || found.status === "0x0")) receipt = found;
    if (!receipt) await sleep(750);
  }
  if (!receipt) {
    job.busy = false;
    paint();
    return;
  }
  const page = job.page;
  page.funds = null;
  if (receipt.status === "0x0") page.notice = message("The transaction failed on-chain. No tokens moved in that transaction.", "error");
  else if (job.kind === "create") {
    try {
      const id = chain.createdId(receipt, job.owner.account, job.taker);
      if (!id) throw new Error("Missing deal ID");
      page.link = dealLink(id);
      storeShare(id);
      page.notice = message("Your deal is live and ready to share.", "success");
    } catch {
      job.busy = false;
      job.receiptProblem = true;
      paint();
      return;
    }
  } else if (job.kind === "fill") page.notice = message("Swap complete. The tokens were exchanged in one transaction.", "success");
  else if (job.kind === "reset") {
    const funds = job.token ? await chain.funds(job.token, job.owner.account).catch(() => null) : null;
    if (!funds) page.notice = message("The reset was confirmed, but the current approval could not be verified. Check your wallet before trying again.", "error");
    else if (funds.allowance !== 0n) page.notice = message("The token still has an approval after the reset. Check the transaction in your wallet before trying again.", "error");
    else page.notice = null;
  } else page.notice = null;
  if (current?.screen !== "home") await refresh(current);
  if (current === page && job.kind === "approve" && page.funds?.allowance < job.amount && receipt.status === "0x1") {
    page.notice = message("The token didn’t grant the requested approval. Review the transaction in your wallet.", "error");
  }
  storePending(null);
  operation = null;
  paint();
}

async function recoverPending() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(pendingKey));
  } catch {
    return;
  }
  if (!transactionHash(saved?.hash) || !["create", "fill", "approve", "reset"].includes(saved.kind)
      || !address(saved.account) || !/^\d{1,78}$/.test(saved.amount)) return;
  const page = saved.screen === "new" ? newPage : (
    current?.screen === "deal" && current.id?.toString() === saved.dealId ? current : { screen: "deal" }
  );
  const job = { page, hash: saved.hash, kind: saved.kind, owner: { account: saved.account }, taker: saved.taker, token: address(saved.token),
    amount: BigInt(saved.amount), busy: true, text: "Recovering a transaction from this tab…" };
  operation = job;
  paint();
  try {
    const api = await network();
    if (api.chainId !== saved.chainId || api.contract !== saved.contract) {
      throw new Error("The site’s network settings changed. Check the transaction in your wallet before sending another.");
    }
    await checkReceipt(job);
  } catch {
    job.busy = false;
    job.needsNetwork = saved;
    paint();
  }
}

function retry() {
  if (operation?.hash && !operation.busy) {
    if (operation.needsNetwork) return recoverPending();
    return checkReceipt(operation);
  }
  return refresh(current);
}

async function runAction() {
  const page = current;
  const action = actionFor(page);
  if (!action?.enabled || walletReading || operation?.busy) return;
  clearTimeout(formTimer);
  const startedAt = navigation;
  const kind = action.kind;
  const owner = identity;
  const job = { page, kind, owner, busy: true, text: "Checking the latest details…" };
  operation = job;
  page.notice = null;
  if (page.screen === "new") page.attempted = true;
  paint(); // In the click handler, before any wallet or network request.
  try {
    if (kind === "connect" || kind === "switch") {
      job.text = kind === "connect" ? "Confirm the connection in your wallet…" : "Confirm the network change in your wallet…";
      paint();
      if (kind === "connect") await wallet.request({ method: "eth_requestAccounts" });
      else await switchNetwork(wallet, chain.chainId);
      await syncWallet(false);
      if (kind === "switch" && identity.chainId !== BigInt(chain.chainId)) throw userFailure(`Switch to chain ${chain.chainId} in your wallet.`);
      if (kind === "connect" && !identity.account) throw userFailure("Your wallet didn’t share an account. Unlock it and try again.");
    }
    await refresh(page);
    if (navigation !== startedAt || ["connect", "switch", "review"].includes(kind)) return;
    if (owner !== identity || actionFor(page)?.kind !== kind) {
      page.notice = page.error ? null : message("The deal or your wallet changed. Review the updated details before continuing.");
      return;
    }

    const payment = spend(page);
    job.amount = payment.amount;
    job.token = payment.token;
    job.taker = page.draft?.taker;
    const approval = kind === "approve" || kind === "reset";
    let tx;
    if (approval) tx = chain.approval(payment.token, kind === "reset" ? 0n : payment.amount);
    else if (kind === "fill") tx = chain.fill(page.id);
    else {
      const blockTime = await chain.latestTime();
      const currentTime = now();
      tx = chain.create({ ...page.draft, expiry: (blockTime > currentTime ? blockTime : currentTime) + page.draft.duration });
    }
    try {
      await chain.simulate(tx, owner.account, approval);
    } catch {
      throw userFailure(approval
        ? "This token refused the approval. No transaction was sent."
        : "The transaction would fail with the current deal terms or wallet balance. No transaction was sent.");
    }
    const actual = await walletState(wallet);
    if (navigation !== startedAt) return;
    if (actual.chainId !== BigInt(chain.chainId) || actual.account !== owner.account || owner !== identity) {
      await syncWallet(false);
      throw userFailure("Your wallet changed while the transaction was being prepared. Review the details and try again.");
    }
    job.text = "Review and confirm the transaction in your wallet…";
    paint();
    const hash = await wallet.request({
      method: "eth_sendTransaction", params: [{ ...tx, from: owner.account, chainId: `0x${chain.chainId.toString(16)}` }],
    });
    if (!transactionHash(hash)) {
      job.busy = false;
      job.unknownSubmission = true;
      return;
    }
    job.hash = hash;
    storePending(job);
    await checkReceipt(job);
  } catch (error) {
    page.notice = message(userError(error), "error");
  } finally {
    if (!job.hash && !job.unknownSubmission && operation === job) operation = null;
    paint();
  }
}

function inputChanged() {
  if (current !== newPage) return;
  Object.assign(newPage, { draft: null, funds: null, notice: null, formErrors: null });
  newPage.reading++;
  paint();
  clearTimeout(formTimer);
  formTimer = setTimeout(() => void refresh(newPage), 250);
}

// The form stays mounted so wallet events and refreshed chain data never erase input.
bind({
  onAction: () => void runAction(),
  onInput: inputChanged,
  onRetry: () => void retry(),
  onReset: () => {
    if (operation?.page === newPage) return false;
    storeShare(null);
    Object.assign(newPage, { draft: null, funds: null, attempted: false, formErrors: null, link: null, notice: null, shareChecked: true });
    if (location.hash === "#/new") queueMicrotask(navigate);
    return true;
  },
});
window.addEventListener("hashchange", navigate);
wallet?.on?.("accountsChanged", walletChanged);
wallet?.on?.("chainChanged", walletChanged);
wallet?.on?.("disconnect", walletChanged);
navigate();
void recoverPending();
void syncWallet();
setInterval(() => {
  if (current.screen === "deal" && current.deal?.status === "open") paint();
}, 1000);
setInterval(() => {
  if (!operation && !document.hidden && current.screen !== "home" && !current.loading && !current.link
      && (current.screen !== "deal" || current.id !== null)) void refresh(current);
}, 8000);
