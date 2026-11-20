import {
  explain, formatAmount, isAddress, isHash, loadChain, MAX_UINT, parseAmount, quantity, ZERO_ADDRESS,
} from "./chain.js";

const target = document.querySelector("#app");
const wallet = window.ethereum;
const hasWallet = typeof wallet?.request === "function";
const testId = (root, id) => root.querySelector('[data-testid="' + id + '"]');
const invoke = (method, params = []) => wallet.request({ method, params });

function putNotice(element, message, tone = "") {
  element.textContent = message ?? "";
  element.dataset.tone = tone;
}

async function walletState() {
  if (!hasWallet) return { account: null, chainId: null };
  const [accounts, chainId] = await Promise.all([invoke("eth_accounts"), invoke("eth_chainId")]);
  const account = accounts?.[0];
  return { account: isAddress(account) ? account.toLowerCase() : null, chainId: Number(chainId) };
}

function walletAction(chain, { account, chainId }, action) {
  if (!hasWallet) {
    return { label: "Wallet required", message: "Open this page in a browser with an Ethereum wallet to " + action + "." };
  }
  if (!account) {
    return { label: "Connect wallet", waiting: "Connecting wallet…", run: async () => {
      const accounts = await invoke("eth_requestAccounts");
      if (!accounts?.length) throw new Error("Choose an account in your wallet to continue.");
    } };
  }
  if (chainId !== chain.chainId) {
    return {
      label: "Switch network", waiting: "Switching network…",
      message: "Your wallet is on a different network. Switch to " + networkName(chain.chainId) + " to " + action + ".",
      run: () => invoke("wallet_switchEthereumChain", [{ chainId: quantity(chain.chainId) }]),
    };
  }
  return null;
}

function networkName(id) {
  return ({ 1: "Ethereum", 10: "Optimism", 137: "Polygon", 8453: "Base", 42161: "Arbitrum",
    84532: "Base Sepolia", 11155111: "Sepolia" })[id] ?? "chain " + id;
}

function showNetwork(root, chain) {
  const element = root.querySelector("[data-network]");
  const name = networkName(chain.chainId);
  element.textContent = name[0].toUpperCase() + name.slice(1);
  element.hidden = false;
}

function bindWallet(signal, refresh) {
  for (const event of ["accountsChanged", "chainChanged", "disconnect", "connect"]) {
    wallet?.on?.(event, refresh);
    signal.addEventListener("abort", () => wallet?.removeListener?.(event, refresh), { once: true });
  }
}

function actionFlow(root, signal, prepare) {
  const button = testId(root, "primary-action");
  const notice = testId(root, "notice");
  const form = root.querySelector("form");
  const fields = form?.querySelector(".draft");
  let plan;
  let busy = false;
  let revision = 0;
  let pending;
  let returnFocus = false;

  function disableButton() {
    returnFocus ||= document.activeElement === button;
    button.disabled = true;
  }

  function restoreFocus() {
    if (!returnFocus) return;
    returnFocus = false;
    if (document.activeElement !== document.body && document.activeElement !== button) return;
    if (!button.hidden && !button.disabled) {
      button.focus();
    } else {
      const created = root.querySelector("[data-created]:not([hidden])");
      const destination = testId(root, "deal-link") ?? created ?? (notice.textContent ? notice : null);
      destination?.focus();
    }
  }

  async function confirm() {
    const receipt = await pending.chain.receipt(pending.hash);
    if (!receipt) throw new Error("Waiting for confirmation. Check again before sending another transaction.");
    pending = null;
    if (BigInt(receipt.status) !== 1n) throw new Error("The transaction failed on chain. Review the current deal and try again.");
  }

  async function send(chain, account, tx, onSubmitted) {
    await chain.simulate(tx, account);
    const current = await walletState();
    if (current.account !== account || current.chainId !== chain.chainId) {
      throw new Error("Your wallet changed. Review the account and network before continuing.");
    }
    if (signal.aborted) return;
    const hash = await invoke("eth_sendTransaction", [{ ...tx, from: account }]);
    if (onSubmitted) return onSubmitted(hash);
    pending = { chain, hash };
    await confirm();
  }

  async function refresh(problem = "") {
    if (busy || signal.aborted) return;
    const request = ++revision;
    const isCurrent = () => !signal.aborted && request === revision;
    disableButton();
    if (fields) fields.disabled = Boolean(pending || plan?.lockFields);
    let next;
    try {
      next = pending
        ? { label: "Check transaction", waiting: "Checking confirmation…", run: confirm,
          message: "Your wallet submitted the transaction. Check for confirmation before taking another action." }
        : await prepare(isCurrent);
    } catch (error) {
      next = { label: "Try again", run: async () => {},
        message: explain(error, "Could not load the current deal state. Try again."), tone: "error" };
    }
    if (!isCurrent()) return;
    plan = next;
    button.hidden = !plan.label;
    button.textContent = plan.label ?? "";
    button.disabled = !plan.run;
    if (fields) fields.disabled = Boolean(pending || plan.lockFields);
    putNotice(notice, problem || plan.message, problem ? "error" : plan.tone);
    restoreFocus();
  }

  async function perform(event) {
    event.preventDefault();
    if (busy || button.disabled || !plan?.run) return;
    busy = true;
    ++revision;
    disableButton();
    if (fields) fields.disabled = true;
    button.textContent = plan.waiting ?? "Checking…";
    putNotice(notice, plan.activity);
    let problem = "";
    try {
      await plan.run();
    } catch (error) {
      problem = explain(error, "The request could not be completed. Check your wallet and try again.");
    } finally {
      busy = false;
      await refresh(problem);
    }
  }

  (form ?? button).addEventListener(form ? "submit" : "click", perform);
  return { send, refresh, invalidate() { ++revision; disableButton(); } };
}

async function approvalPlan(flow, chain, account, address, { symbol, decimals }, amount, allowance) {
  const approval = chain.approval(address, amount);
  if (allowance > 0n) {
    // Some legacy tokens require setting a nonzero allowance to zero before increasing it.
    try {
      await chain.simulate(approval, account);
    } catch (error) {
      if (!error.rpcError && error.message.startsWith("Could not reach")) throw error;
      const reset = chain.approval(address, 0n);
      await chain.simulate(reset, account);
      return {
        label: "Reset " + symbol + " approval", waiting: "Resetting approval…",
        message: "This token requires clearing its previous approval before setting the new amount.",
        activity: "Review the approval reset in your wallet.",
        run: () => flow.send(chain, account, reset),
      };
    }
  }
  return {
    label: "Approve " + symbol, waiting: "Approving " + symbol + "…",
    message: "Allow the deal contract to spend " + formatAmount(amount, decimals) + " " + symbol + ".",
    activity: "Review the token approval in your wallet.",
    run: () => flow.send(chain, account, approval),
  };
}

const stateMessages = {
  filled: ["Filled", "The swap is complete. Both sides received their tokens."],
  cancelled: ["Cancelled", "The maker cancelled this deal."],
  expired: ["Expired", "The time to fill this deal has passed."],
  "not-found": ["Not found", "There is no deal at this link. Check the link with the maker."],
  open: ["Open", ""],
};

function formatExpiry(expiry) {
  if (expiry > 8_640_000_000_000n) return expiry.toString() + " (Unix seconds)";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
    .format(new Date(Number(expiry) * 1000)) + " UTC";
}

const wallTime = () => BigInt(Math.floor(Date.now() / 1000));

function dealScreen(root, idText, signal) {
  const status = testId(root, "deal-status");
  const terms = root.querySelector("[data-terms]");
  const details = root.querySelector("[data-token-details]");
  let chain;
  let recentOpen = false;

  const showStatus = (state) => {
    recentOpen = state === "open";
    status.dataset.status = state;
    status.textContent = stateMessages[state][0];
    status.hidden = false;
    if (state === "not-found") {
      terms.hidden = true;
      details.hidden = true;
    }
  };

  const flow = actionFlow(root, signal, async (isCurrent) => {
    const id = /^\d{1,78}$/.test(idText) ? BigInt(idText) : 0n;
    if (id < 1n || id > MAX_UINT) {
      showStatus("not-found");
      return { message: stateMessages["not-found"][1] };
    }
    chain ??= await getChain();
    const deal = await chain.deal(id);
    if (!isCurrent()) return {};
    showNetwork(root, chain);
    if (!deal.status) {
      showStatus("not-found");
      return { message: stateMessages["not-found"][1] };
    }

    const blockTime = deal.status === 1 ? await chain.blockTime() : 0n;
    const state = deal.status === 2 ? "filled" : deal.status === 3 ? "cancelled" :
      deal.expiry <= blockTime || deal.expiry <= wallTime() ? "expired" : "open";
    const [pay, receive] = await Promise.allSettled([chain.token(deal.buy), chain.token(deal.sell)]);
    if (!isCurrent()) return {};
    testId(root, "maker").textContent = deal.maker;
    const expires = testId(root, "expires");
    expires.dataset.expiry = deal.expiry.toString();
    expires.textContent = formatExpiry(deal.expiry);
    root.querySelector("[data-buy-address]").textContent = deal.buy;
    root.querySelector("[data-sell-address]").textContent = deal.sell;
    for (const [side, token, amount] of [["pay", pay, deal.buyAmount], ["receive", receive, deal.sellAmount]]) {
      testId(root, side + "-amount").textContent =
        token.status === "fulfilled" ? formatAmount(amount, token.value.decimals) : "Unavailable";
      testId(root, side + "-symbol").textContent = token.value?.symbol ?? "";
    }
    terms.hidden = false;
    details.hidden = false;
    showStatus(state);
    if (state !== "open") return { message: stateMessages[state][1] };
    if (pay.status === "rejected" || receive.status === "rejected") {
      return { label: "Retry token details", run: async () => {},
        message: "The network could not load the token amounts. Try again.", tone: "error" };
    }

    const session = await walletState();
    if (session.account && deal.taker !== ZERO_ADDRESS && deal.taker !== session.account) {
      return { message: "This deal is reserved for another wallet (" + deal.taker + ")." };
    }
    const connectOrSwitch = walletAction(chain, session, "fill this deal");
    if (connectOrSwitch) return connectOrSwitch;

    const { account } = session;
    const buyer = await chain.funding(deal.buy, account);
    const { symbol } = pay.value;
    if (buyer.balance < deal.buyAmount) {
      return { label: "Check balance", run: async () => {}, message: "Your wallet does not have enough " + symbol + "." };
    }
    if (buyer.allowance < deal.buyAmount) {
      return approvalPlan(flow, chain, account, deal.buy, pay.value, deal.buyAmount, buyer.allowance);
    }
    return {
      label: "Fill deal", waiting: "Filling deal…",
      activity: "Review the swap in your wallet. Both transfers settle together.",
      run: () => flow.send(chain, account, chain.fill(id)),
    };
  });

  const refresh = () => flow.refresh();
  bindWallet(signal, refresh);
  const poll = setInterval(() => { if (recentOpen) refresh(); }, 15_000);
  signal.addEventListener("abort", () => clearInterval(poll), { once: true });
  refresh();
}

function draftTerms(form) {
  const value = (name) => form.elements.namedItem(name).value.trim();
  const sell = value("sell-token").toLowerCase();
  const buy = value("buy-token").toLowerCase();
  const taker = value("taker").toLowerCase() || ZERO_ADDRESS;
  if (!isAddress(sell) || sell === ZERO_ADDRESS) throw new Error("Enter a valid sell token address.");
  if (!isAddress(buy) || buy === ZERO_ADDRESS) throw new Error("Enter a valid buy token address.");
  if (sell === buy) throw new Error("Choose two different tokens.");
  if (!isAddress(taker)) throw new Error("Enter a valid taker address or leave it blank for anyone.");
  const seconds = parseAmount(value("expiry-hours"), 6, "Offer lifetime") * 3600n / 1_000_000n;
  if (seconds < 1n || seconds >= 2n ** 64n) throw new Error("Enter an offer lifetime of at least one second and within the supported range.");
  return { sell, buy, taker, seconds, sellText: value("sell-amount"), buyText: value("buy-amount") };
}

const CHECK_WITH_WALLET_AFTER = 30 * 60 * 1000;

function writeCreation(key, record) {
  try {
    if (record) sessionStorage.setItem(key, JSON.stringify(record));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readCreation(key) {
  let value;
  try {
    value = JSON.parse(sessionStorage.getItem(key));
  } catch {
    writeCreation(key, null);
    return null;
  }
  if (value === null) return null;
  if (!isHash(value?.hash) || !Number.isSafeInteger(value.submittedAt) || value.submittedAt < 1) {
    writeCreation(key, null);
    return null;
  }
  const record = { hash: value.hash.toLowerCase(), submittedAt: Math.min(value.submittedAt, Date.now()) };
  if (record.submittedAt !== value.submittedAt) writeCreation(key, record);
  return record;
}

function newScreen(root, signal) {
  const form = root.querySelector("form");
  const fields = form.querySelector(".draft");
  const recovery = form.querySelector("[data-create-recovery]");
  const discard = recovery.querySelector("input");
  const created = root.querySelector("[data-created]");
  const link = created.querySelector("[data-deal-link]");
  const copy = created.querySelector("[data-copy]");
  const copyStatus = created.querySelector("[data-copy-status]");
  let chain;
  let creationKey, pendingCreation, initialCheck;
  let recoveryWarning = "";
  let creationFailed = false;
  let storedInTab = true;

  function showCreated(id) {
    const url = new URL(location.href);
    url.hash = "/d/" + id;
    history.replaceState(history.state, "", url.href);
    link.href = url.href;
    link.textContent = url.href;
    link.dataset.testid = "deal-link";
    form.hidden = true;
    created.hidden = false;
  }

  function clearCreation() {
    pendingCreation = null;
    writeCreation(creationKey, null);
    recovery.hidden = true;
    discard.checked = false;
  }

  function trackingMessage() {
    return "Waiting for confirmation. Check " + pendingCreation.hash + " in your wallet." +
      (storedInTab ? "" : " Keep this tab open so the page can finish checking.");
  }

  async function checkCreation({ stopTracking = false } = {}) {
    const { hash } = pendingCreation;
    const receipt = await chain.receipt(hash, { attempts: stopTracking ? 1 : 16, signal });
    if (signal.aborted) return;
    if (!receipt) {
      if (!stopTracking) return;
      if (await chain.hasTransaction(hash)) {
        throw new Error("The network still sees this transaction. Check its status in your wallet.");
      }
      if (signal.aborted) return;
      clearCreation();
      form.reset();
      return;
    }
    let id;
    try {
      id = chain.createdId(receipt, hash);
    } catch (error) {
      throw new Error(error.message + " Check " + hash + " in your wallet.");
    }
    if (id === null) creationFailed = true;
    else showCreated(id);
    clearCreation();
  }

  async function trackCreation(hash) {
    if (!isHash(hash)) throw new Error("Your wallet did not return a transaction hash. Check its activity before trying again.");
    pendingCreation = { hash: hash.toLowerCase(), submittedAt: Date.now() };
    storedInTab = writeCreation(creationKey, pendingCreation);
    if (!signal.aborted) await checkCreation();
  }

  const flow = actionFlow(root, signal, async (isCurrent) => {
    if (!created.hidden) return {};
    chain ??= await getChain();
    if (!isCurrent()) return {};
    showNetwork(root, chain);
    if (!creationKey) {
      creationKey = "otc.fam.pending-create/" + chain.chainId + "/" + chain.contract;
      pendingCreation = readCreation(creationKey);
      if (pendingCreation) {
        fields.disabled = true;
        fields.hidden = true;
        testId(root, "primary-action").textContent = "Checking confirmation…";
        putNotice(testId(root, "notice"), trackingMessage());
        initialCheck = checkCreation().catch((error) => {
          recoveryWarning = explain(error, "Could not verify the submitted deal. Check its status in your wallet.");
        });
      }
    }
    await initialCheck;
    if (!isCurrent() || !created.hidden) return {};
    if (creationFailed) {
      return { label: "Back to form", lockFields: true, tone: "error",
        message: "The transaction failed on chain. No deal was created.",
        run: () => { creationFailed = false; } };
    }
    if (pendingCreation) {
      recovery.hidden = Date.now() - pendingCreation.submittedAt < CHECK_WITH_WALLET_AFTER;
      const stopTracking = !recovery.hidden && discard.checked;
      return {
        label: stopTracking ? "Stop tracking" : "Check transaction",
        waiting: "Checking confirmation…", lockFields: true,
        message: recoveryWarning || trackingMessage(), tone: recoveryWarning ? "error" : "",
        run: async () => {
          recoveryWarning = "";
          await checkCreation({ stopTracking });
        },
      };
    }
    fields.hidden = false;
    const session = await walletState();
    const connectOrSwitch = walletAction(chain, session, "create a deal");
    if (connectOrSwitch) return connectOrSwitch;

    if ([...form.querySelectorAll("input[required]")].some((input) => !input.value.trim())) {
      return { label: "Create deal", message: "Enter both token addresses, both amounts and an offer lifetime." };
    }

    const { account } = session;
    let draft;
    try {
      draft = draftTerms(form);
    } catch (error) {
      return { label: "Correct the terms", message: error.message, tone: "error" };
    }
    const [sellToken, buyToken] = await Promise.all([chain.token(draft.sell), chain.token(draft.buy)]);
    let sellAmount, buyAmount;
    try {
      sellAmount = parseAmount(draft.sellText, sellToken.decimals, "Sell amount");
      buyAmount = parseAmount(draft.buyText, buyToken.decimals, "Buy amount");
    } catch (error) {
      return { label: "Correct the terms", message: error.message, tone: "error" };
    }
    const { balance, allowance } = await chain.funding(draft.sell, account);
    if (balance < sellAmount) {
      return { label: "Check balance", run: async () => {},
        message: "Your wallet does not have enough " + sellToken.symbol + " to fund this offer." };
    }
    if (allowance < sellAmount) {
      return approvalPlan(flow, chain, account, draft.sell, sellToken, sellAmount, allowance);
    }
    return {
      label: "Create deal", waiting: "Creating deal…",
      message: "The deal contract holds your sell tokens until the deal fills or you cancel.",
      activity: "Review the deposit in your wallet.",
      run: async () => {
        const blockTime = await chain.blockTime();
        const now = wallTime();
        const expiry = (blockTime > now ? blockTime : now) + draft.seconds;
        if (expiry >= 2n ** 64n) throw new Error("This offer lifetime is too long.");
        await flow.send(chain, account, chain.create({ ...draft, sellAmount, buyAmount, expiry }), trackCreation);
      },
    };
  });

  let debounce;
  const refresh = () => { clearTimeout(debounce); flow.refresh(); };
  form.addEventListener("input", () => {
    flow.invalidate();
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 140);
  });
  signal.addEventListener("abort", () => clearTimeout(debounce), { once: true });
  link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey || link.href !== location.href) return;
    // The address already matches the link, so render the deal on same-tab activation.
    event.preventDefault();
    route();
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link.href);
      copyStatus.textContent = "Link copied.";
    } catch {
      copyStatus.textContent = "Copy the link above to share your deal.";
    }
  });
  bindWallet(signal, refresh);
  refresh();
}

let chainPromise;
function getChain() {
  chainPromise ??= loadChain().catch((error) => {
    chainPromise = null;
    throw error;
  });
  return chainPromise;
}

let screen;
function route() {
  screen?.abort();
  screen = new AbortController();
  const path = location.hash.slice(1);
  const isNew = path === "/new" || path === "";
  const template = document.getElementById(isNew ? "new-screen" : "deal-screen");
  target.replaceChildren(template.content.cloneNode(true));
  document.title = isNew ? "New deal · otc.fam" : "Review deal · otc.fam";
  if (isNew) newScreen(target, screen.signal);
  else dealScreen(target, /^\/d\/([^/]+)$/.exec(path)?.[1] ?? "", screen.signal);
}

window.addEventListener("hashchange", route);
route();
