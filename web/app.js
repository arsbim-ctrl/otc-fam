import { address, anyone, connectChain, dealId, formatAmount, parseAmount, parseDuration, UserError } from "./chain.js";

const app = document.querySelector("#app");
const injected = window.ethereum;
const wallet = typeof injected?.request === "function" ? injected : null;
const testId = (root, name) => root.querySelector(`[data-testid="${name}"]`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const networks = new Map([[1, "Ethereum"], [8453, "Base"], [84532, "Base Sepolia"], [11155111, "Sepolia"]]);
const expiryFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  timeZone: "UTC", timeZoneName: "short",
});

let chainPromise;
function getChain() {
  chainPromise ??= connectChain().catch((error) => {
    chainPromise = null;
    throw error;
  });
  return chainPromise;
}

function request(method, params) {
  return wallet.request({ method, params });
}

async function walletState() {
  if (!wallet) return { account: null };
  const [accounts, id] = await Promise.all([request("eth_accounts"), request("eth_chainId")]);
  return { account: accounts[0] ? address(accounts[0], "wallet") : null, chainId: BigInt(id) };
}

const networkName = (id) => networks.get(id) ?? `Chain ${id}`;
const networkMatches = (chain, state) => BigInt(chain.chainId) === state.chainId;
function showNetwork(footer, chain, state) {
  const name = networkName(chain.chainId);
  const account = state?.account;
  footer.hidden = false;
  footer.textContent = account && networkMatches(chain, state)
    ? `${name} · Wallet ${account.slice(0, 6)}…${account.slice(-4)}`
    : name;
  footer.title = account ?? "";
}

function walletAction(chain, state) {
  if (!wallet) return {
    label: "Connect wallet", message: "Open this page in a browser with an Ethereum wallet to continue.",
  };
  if (!state.account) return {
    label: "Connect wallet", pendingLabel: "Connecting…", run: () => request("eth_requestAccounts"),
  };
  if (!networkMatches(chain, state)) return {
    label: `Switch to ${networkName(chain.chainId)}`,
    message: `Your wallet is on another network. Switch to ${networkName(chain.chainId)} to continue.`,
    pendingLabel: "Switching network…",
    async run() {
      try {
        await request("wallet_switchEthereumChain", [{ chainId: `0x${chain.chainId.toString(16)}` }]);
      } catch (error) {
        if (Number(error.code) === 4001) throw error;
        throw new UserError(`Select ${networkName(chain.chainId)} in your wallet and try again.`);
      }
    },
  };
  return null;
}

function userMessage(error, fallback) {
  if (error instanceof UserError) return error.message;
  if (Number(error?.code) === 4001) return "You declined the request in your wallet. You can try again.";
  return fallback;
}

function retryRead(error) {
  return {
    label: "Retry", pendingLabel: "Checking…", run: async () => {},
    message: userMessage(error, "Couldn’t read the current chain state. Try again."),
  };
}

// Every action on a screen shares the lock through wallet prompts and transaction confirmation.
function controls(root, signal, prepare, { setFieldsLocked = () => {} } = {}) {
  const button = testId(root, "primary-action");
  const makerButton = testId(root, "maker-action");
  const notice = testId(root, "notice");
  let version = 0;
  let selected;
  let busyButton;
  let makerViewStale = false;
  let restoreMakerFocus = false;
  let submitted;
  let lastError;

  function disableActions() {
    if (makerButton) {
      if (document.activeElement === makerButton) restoreMakerFocus = true;
      makerButton.disabled = true;
    }
    button.disabled = true;
  }

  function render(state = {}) {
    button.hidden = !state.label;
    button.disabled = !state.run || Boolean(busyButton);
    if (state.label && button.textContent !== state.label) button.textContent = state.label;

    if (makerButton) {
      const maker = makerViewStale ? null : state.makerAction;
      if (!maker?.label && document.activeElement === makerButton) restoreMakerFocus = true;
      makerButton.hidden = !maker?.label;
      makerButton.disabled = !maker?.run || Boolean(busyButton);
      if (maker?.label && makerButton.textContent !== maker.label) makerButton.textContent = maker.label;
    }

    const text = lastError && state.restricted ? `${state.message} ${lastError}` : lastError || state.message || "";
    if (notice.textContent !== text) notice.textContent = text;

    if (!busyButton && restoreMakerFocus) {
      restoreMakerFocus = false;
      if (document.activeElement === document.body) {
        const target = !makerButton.hidden && !makerButton.disabled
          ? makerButton
          : root.querySelector("#state-message:not(:empty)") ?? root.querySelector("#deal-heading");
        target.focus({ preventScroll: true });
      }
    }
  }

  function renderProgress(label, message) {
    if (busyButton === makerButton) render({ ...selected, makerAction: { label }, message });
    else render({ ...selected, label, message });
  }

  async function readSettlement(tx) {
    let receipt, receiptError;
    try {
      receipt = await tx.chain.receipt(tx.hash);
    } catch (error) {
      receiptError = error;
    }
    if (submitted !== tx || signal.aborted) return false;

    if (!receipt && tx.refundDealId !== undefined) {
      const { status } = await tx.chain.deal(tx.refundDealId);
      if (submitted !== tx || signal.aborted) return false;
      if (status === 2n || status === 3n) {
        // A terminal deal resolves the lock without confirming the original transaction.
        submitted = null;
        return true;
      }
    }
    if (receiptError) throw receiptError;
    if (!receipt) return false;
    submitted = null;
    if (BigInt(receipt.status) !== 1n) {
      throw new UserError("The transaction reverted on chain. Review the current terms and try again.");
    }
    await tx.onConfirmed?.(receipt, tx.hash);
    return true;
  }

  async function confirm() {
    const tx = submitted;
    const end = Date.now() + 120_000;
    while (!signal.aborted && Date.now() < end) {
      if (await readSettlement(tx)) return;
      await sleep(1000);
    }
  }

  async function send({ chain, account, tx, onConfirmed, refundDealId }) {
    await chain.simulate(tx, account);
    const current = await walletState();
    if (current.account !== account || !networkMatches(chain, current)) {
      throw new UserError("Your wallet account or network changed. Review the current deal and try again.");
    }
    signal.throwIfAborted();
    const hash = await request("eth_sendTransaction", [{ ...tx, from: account }]);
    submitted = { chain, hash, onConfirmed, refundDealId, button: busyButton };
    if (!signal.aborted) renderProgress("Confirming on chain…", "Submitted. Waiting for the network to confirm.");
    await confirm();
  }

  async function refresh({ clearError = false, background = false } = {}) {
    if (signal.aborted) return;
    if (clearError) {
      lastError = "";
      if (makerButton) {
        disableActions();
        makerViewStale = true;
        makerButton.hidden = true;
      }
    }
    if (busyButton) return;
    const revision = ++version;
    if (!background) {
      selected = null;
      disableActions();
    }
    if (submitted?.button === makerButton) {
      // A submitted refund keeps both actions locked, even if the wallet account changes.
      try {
        if (await readSettlement(submitted)) lastError = "";
      } catch (error) {
        if (!submitted) lastError = userMessage(error, "Couldn’t confirm the refund.");
      }
      if (signal.aborted || revision !== version) return;
      if (submitted) {
        selected = { message: "The refund is awaiting confirmation. You can check its status in your wallet." };
        render(selected);
        return;
      }
    } else if (submitted) {
      setFieldsLocked(true);
      selected = {
        label: "Check transaction",
        pendingLabel: "Checking transaction…",
        message: `Waiting for confirmation of ${submitted.hash}.`,
        run: confirm,
      };
      render(selected);
      return;
    }
    try {
      const presentEarly = (present) => {
        if (!signal.aborted && revision === version) present();
      };
      const result = await prepare(send, presentEarly);
      if (signal.aborted || revision !== version) return;
      result.present?.();
      selected = result;
    } catch (error) {
      if (signal.aborted || revision !== version) return;
      selected = retryRead(error);
    }
    makerViewStale = false;
    render(selected);
  }

  async function press(event, control = button) {
    event.preventDefault();
    const action = control === makerButton ? selected?.makerAction : selected;
    if (control.disabled || !action?.run || busyButton || submitted?.button === makerButton || signal.aborted) return;
    busyButton = control;
    ++version;
    lastError = "";
    disableActions();
    setFieldsLocked(true);
    renderProgress(action.pendingLabel, action.pendingMessage);
    try {
      await action.run();
    } catch (error) {
      lastError = submitted?.button === makerButton ? "" : submitted
        ? `Confirmation is unavailable. Check transaction ${submitted.hash} again before sending anything else.`
        : userMessage(error, "The wallet couldn’t complete that request. Check your wallet and try again.");
    } finally {
      busyButton = null;
      if (!signal.aborted) {
        setFieldsLocked(Boolean(submitted));
        void refresh();
      }
    }
  }

  (button.form ?? button).addEventListener(button.form ? "submit" : "click", press, { signal });
  makerButton?.addEventListener("click", (event) => press(event, makerButton), { signal });
  return {
    refresh,
    invalidate() {
      ++version;
      selected = null;
      disableActions();
    },
  };
}

function approvalAction(chain, state, to, amount, symbol, allowance, send) {
  const resetting = allowance > 0n;
  return {
    label: resetting ? `Reset ${symbol} approval` : `Approve ${symbol}`,
    message: resetting ? "Clear the existing allowance before approving the amount for this deal."
      : `Allow the deal contract to use exactly ${amount.text} ${symbol}.`,
    pendingLabel: resetting ? "Resetting approval…" : "Approving token…",
    pendingMessage: "Confirm the token approval in your wallet.",
    run: () => send({
      chain, account: state.account, tx: chain.approval(to, resetting ? 0n : amount.units),
      async onConfirmed() {
        const [, now] = await chain.funds(to, state.account);
        if (resetting ? now !== 0n : now < amount.units) {
          throw new UserError("The transaction confirmed, but the token allowance didn’t update as expected.");
        }
      },
    }),
  };
}

const outcomes = {
  open: ["Open", ""],
  filled: ["Filled", "This deal is complete. Both sides of the swap settled on chain."],
  cancelled: ["Cancelled", "The maker cancelled this deal."],
  expired: ["Expired", "The deadline passed. This deal can no longer be filled."],
  "not-found": ["Not found", "There’s no deal at this link. Check that you have the full link."],
};

function showDeal(root, id, signal) {
  const statusBadge = testId(root, "deal-status");
  const stateMessage = root.querySelector("#state-message");
  const footer = root.querySelector(".network");
  let refunded = false;
  root.querySelector("#deal-number").textContent = id ? `#${id}` : "";

  function showStatus(status) {
    const [label, defaultExplanation] = outcomes[status];
    const explanation = status === "cancelled" && refunded
      ? "Deal cancelled. The escrowed tokens were returned to the maker."
      : defaultExplanation;
    statusBadge.hidden = false;
    statusBadge.textContent = label;
    statusBadge.dataset.status = status;
    if (stateMessage.textContent !== explanation) stateMessage.textContent = explanation;
  }

  if (!id) {
    showStatus("not-found");
    return;
  }

  function showTerms({ deal, pay, receive, status, chain, state }) {
    showStatus(status);
    root.querySelector("#quote").hidden = !pay || !receive;
    showNetwork(footer, chain, state);
    if (!pay || !receive) return;
    for (const [side, info, value, token] of [
      ["pay", pay, deal.buyAmount, deal.buyToken],
      ["receive", receive, deal.sellAmount, deal.sellToken],
    ]) {
      testId(root, `${side}-amount`).textContent = formatAmount(value, info.decimals);
      testId(root, `${side}-symbol`).textContent = info.symbol;
      root.querySelector(`#${side}-token`).textContent = token;
    }
    testId(root, "maker").textContent = deal.maker;
    root.querySelector("#reserved").textContent = deal.taker;
    root.querySelector("#taker-row").hidden = deal.taker === anyone;
    const time = testId(root, "expires");
    const date = new Date(Number(deal.expiry) * 1000);
    time.dataset.expiry = String(deal.expiry);
    if (Number.isNaN(date.getTime())) {
      time.textContent = `Unix time ${deal.expiry}`;
    } else {
      time.dateTime = date.toISOString();
      time.textContent = expiryFormat.format(date);
    }
  }

  const component = controls(root, signal, async (send, presentEarly) => {
    let chain, deal, blockTime;
    try {
      chain = await getChain();
      [deal, blockTime] = await Promise.all([chain.deal(id), chain.time()]);
    } catch (error) {
      return {
        label: "Retry", pendingLabel: "Reading deal…", run: async () => {},
        present() {
          statusBadge.hidden = true;
          root.querySelector("#quote").hidden = true;
          stateMessage.textContent = userMessage(error, "Couldn’t read this deal. Check your connection and try again.");
        },
      };
    }
    if (deal.status === 0n) {
      return { present: () => showTerms({ status: "not-found", chain }) };
    }
    const expired = deal.expiry <= blockTime || deal.expiry <= BigInt(Math.floor(Date.now() / 1000));
    const status = deal.status === 1n && !refunded ? (expired ? "expired" : "open") : deal.status === 2n ? "filled" : "cancelled";
    let pay, receive, metadataError;
    try {
      [pay, receive] = await Promise.all([chain.tokenInfo(deal.buyToken), chain.tokenInfo(deal.sellToken)]);
    } catch (error) {
      metadataError = userMessage(error, "Couldn’t read this deal’s tokens.");
    }

    // Render the quote before checking the injected wallet or doing any allowance lookups.
    const snapshot = { deal, pay, receive, status, chain };
    if (status === "filled" || status === "cancelled") {
      return { present: () => showTerms(snapshot), message: metadataError };
    }
    if (signal.aborted) return {};
    presentEarly(() => showTerms(snapshot));

    let state;
    try {
      state = await walletState();
    } catch (error) {
      if (status === "expired" || metadataError) return { message: metadataError };
      throw error;
    }
    const isMaker = state.account === deal.maker;
    const present = () => showTerms({ ...snapshot, state: status === "open" || isMaker ? state : undefined });
    let makerAction;
    let makerMessage;
    if (isMaker && networkMatches(chain, state)) {
      makerAction = {
        label: "Cancel and reclaim tokens", pendingLabel: "Cancelling deal…",
        pendingMessage: "Confirm the cancellation and refund in your wallet.",
        run: () => send({
          chain, account: state.account, tx: chain.cancel(id), refundDealId: id,
          onConfirmed() { refunded = true; },
        }),
      };
    } else if ((status === "expired" || metadataError) && wallet && !state.account) {
      // These views have no taker action through which a maker can connect.
      makerAction = { ...walletAction(chain, state), label: "Connect maker wallet" };
    } else if (isMaker) {
      makerMessage = `Switch your wallet to ${networkName(chain.chainId)} to reclaim the escrowed tokens.`;
    }

    if (status === "expired") return { present, makerAction, message: makerMessage || metadataError };
    const actions = { present, makerAction };
    if (state.account && deal.taker !== anyone && deal.taker !== state.account) {
      const message = `This deal is for another address (${deal.taker}). Connect that address to fill it.`;
      return { ...actions, restricted: true, message: makerMessage ? `${message} ${makerMessage}` : message };
    }
    if (metadataError) return { ...actions, message: makerMessage || metadataError };
    const walletStep = walletAction(chain, state);
    if (walletStep) return { ...actions, ...walletStep };

    let buyBalance, buyAllowance;
    try {
      [buyBalance, buyAllowance] = await chain.funds(deal.buyToken, state.account);
    } catch (error) {
      return { ...actions, ...retryRead(error) };
    }
    if (buyBalance < deal.buyAmount) {
      return { ...actions, message: `This wallet needs ${formatAmount(deal.buyAmount, pay.decimals)} ${pay.symbol} to fill the deal.` };
    }
    if (buyAllowance < deal.buyAmount) {
      const amount = { units: deal.buyAmount, text: formatAmount(deal.buyAmount, pay.decimals) };
      return { ...actions, ...approvalAction(chain, state, deal.buyToken, amount, pay.symbol, buyAllowance, send) };
    }
    return {
      ...actions, label: "Fill deal", pendingLabel: "Filling deal…",
      message: "Both token transfers happen in one transaction.",
      pendingMessage: "Confirm the swap in your wallet.",
      run: () => send({ chain, account: state.account, tx: chain.fill(id) }),
    };
  });
  void component.refresh();
  const timer = setInterval(() => void component.refresh({ background: true }), 12_000);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  return component;
}

function showCreate(root, signal) {
  const form = root.querySelector("#deal-form");
  const share = root.querySelector("#share");
  const footer = root.querySelector(".network");
  const inputs = [...form.querySelectorAll("input")];
  const value = (name) => testId(form, name).value;
  const setFieldsLocked = (lock) => inputs.forEach((input) => { input.disabled = lock; });
  let created;
  let link;
  let inputTimer;

  const component = controls(root, signal, async (send) => {
    if (created) return {};
    const chain = await getChain();
    const state = await walletState();
    const present = () => showNetwork(footer, chain, state);
    const walletStep = walletAction(chain, state);
    if (walletStep) return { present, ...walletStep };
    const sellAddress = value("sell-token");
    const buyAddress = value("buy-token");
    const sellText = value("sell-amount");
    const buyText = value("buy-amount");
    const takerAddress = value("taker");
    const hours = value("expiry-hours");
    if (![sellAddress, sellText, buyAddress, buyText, hours].every((value) => value.trim())) {
      return { present, label: "Create deal", message: "Enter both token addresses, both amounts and the expiry." };
    }
    let terms;
    try {
      const sellToken = address(sellAddress, "sell token");
      const buyToken = address(buyAddress, "buy token");
      if (sellToken === buyToken) throw new UserError("Choose a different token for each side of the deal.");
      const taker = takerAddress.trim() ? address(takerAddress, "taker", true) : anyone;
      const duration = parseDuration(hours);
      const [sell, buy] = await Promise.all([chain.tokenInfo(sellToken), chain.tokenInfo(buyToken)]);
      const sellAmount = parseAmount(sellText, sell, "sell amount");
      const buyAmount = parseAmount(buyText, buy, "buy amount");
      terms = { sellToken, buyToken, sell, buy, sellAmount, buyAmount, taker, duration };
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      return { present, label: "Create deal", message: error.message };
    }
    const { sellToken, buyToken, sell, buy, sellAmount, buyAmount, taker, duration } = terms;
    const [balance, allowance] = await chain.funds(sellToken, state.account);
    const amount = { units: sellAmount, text: formatAmount(sellAmount, sell.decimals) };
    if (balance < sellAmount) {
      return { present, label: "Create deal", message: `This wallet needs ${amount.text} ${sell.symbol} to offer this deal.` };
    }
    if (allowance < sellAmount) {
      return { present, ...approvalAction(chain, state, sellToken, amount, sell.symbol, allowance, send) };
    }
    return {
      present, label: "Create deal", pendingLabel: "Creating deal…",
      message: `Deposit ${amount.text} ${sell.symbol} for this offer. You’ll receive ${formatAmount(buyAmount, buy.decimals)} ${buy.symbol} if it fills.`,
      pendingMessage: "Confirm the offer and token deposit in your wallet.",
      async run() {
        // A static client supplies an absolute expiry, anchored to the chain clock at submission.
        const expiry = await chain.time() + duration;
        await send({
          chain, account: state.account, tx: chain.create([sellToken, sellAmount, buyToken, buyAmount, taker, expiry]),
          onConfirmed(receipt, hash) {
            created = true;
            if (signal.aborted) return;
            const id = chain.createdId(receipt, state.account);
            if (!id) {
              throw new UserError(`The transaction confirmed, but its deal ID could not be read. Check ${hash} in your wallet.`);
            }
            const url = new URL(location.href);
            url.hash = `/d/${id}`;
            link = document.createElement("a");
            link.className = "share-url";
            link.dataset.testid = "deal-link";
            link.href = url.href;
            link.textContent = url.href;
            root.querySelector("#share-url").replaceChildren(link);
            form.hidden = true;
            share.hidden = false;
            root.querySelector("#share-title").focus();
          },
        });
      },
    };
  }, { setFieldsLocked });

  form.addEventListener("input", () => {
    component.invalidate();
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => void component.refresh({ clearError: true }), 160);
  }, { signal });
  signal.addEventListener("abort", () => clearTimeout(inputTimer), { once: true });
  root.querySelector("#copy-link").addEventListener("click", async () => {
    const feedback = root.querySelector("#copy-feedback");
    try {
      await navigator.clipboard.writeText(link.href);
      feedback.textContent = "Link copied.";
    } catch {
      feedback.textContent = "Copy the link above to share it.";
    }
  }, { signal });
  void component.refresh();
  return component;
}

let route;
let current;
function navigate() {
  route?.abort();
  route = new AbortController();
  const hash = location.hash;
  const kind = hash === "#/new" ? "create" : hash.startsWith("#/d/") ? "deal" : "home";
  const newLink = document.querySelector("#new-link");
  if (kind === "create") newLink.setAttribute("aria-current", "page");
  else newLink.removeAttribute("aria-current");
  app.replaceChildren(document.querySelector(`#${kind}-template`).content.cloneNode(true));
  document.title = kind === "create" ? "New deal · otc.fam" : kind === "deal" ? "Deal · otc.fam" : "otc.fam";
  current = kind === "create" ? showCreate(app, route.signal) : kind === "deal" ? showDeal(app, dealId(hash), route.signal) : null;
}

function walletChanged() {
  void current?.refresh({ clearError: true });
}
wallet?.on?.("accountsChanged", walletChanged);
wallet?.on?.("chainChanged", walletChanged);
window.addEventListener("hashchange", navigate);
navigate();
