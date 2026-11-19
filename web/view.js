const byId = (id) => document.getElementById(id);
const handle = (name) => document.querySelector(`[data-testid="${name}"]`);
const screens = [...document.querySelectorAll("[data-screen]")];
const actionSlots = {
  home: byId("home-actions"),
  deal: byId("deal-actions"),
  new: byId("new-actions"),
  error: byId("error-actions"),
};
const actions = byId("actions");
const primary = handle("primary-action");
const notice = handle("notice");
const retry = byId("retry-action");
const form = byId("deal-form");
const fields = [...form.querySelectorAll("input[name]")];
const share = byId("share-view");
const link = byId("share-link");
const copy = byId("copy-link");
const copyFeedback = byId("copy-feedback");
const dealTitle = byId("deal-title");
const statusLabel = handle("deal-status");
const expiryTime = handle("expires");
const dealTerms = byId("deal-terms");
const tokenDetails = byId("token-details");
const reserved = byId("reserved-detail");
const newTitle = byId("new-title");
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

const statusText = {
  open: "Open", filled: "Filled", cancelled: "Cancelled", expired: "Expired", "not-found": "Not found",
};
const statusMessage = {
  filled: { text: "This deal is complete. Both sides’ tokens were exchanged.", tone: "success" },
  cancelled: { text: "The maker cancelled this deal. It can no longer be filled.", tone: "info" },
  expired: { text: "This deal expired before it was filled.", tone: "info" },
  "not-found": { text: "No deal was found for this link. Check the link with the maker.", tone: "info" },
};

let activeScreen = "loading";

function setText(element, value) {
  const text = value == null ? "" : String(value);
  if (element.textContent !== text) element.textContent = text;
}

function setNotice(element, message) {
  if (message?.tone) element.dataset.tone = message.tone;
  else element.removeAttribute("data-tone");
  setText(element, message?.text);
}

function renderDeal(deal) {
  const showTerms = deal.status !== "not-found";
  const hasReservedTaker = deal.taker && !/^0x0{40}$/i.test(deal.taker);
  if (dealTitle.dataset.id !== String(deal.id)) tokenDetails.open = false;
  dealTitle.dataset.id = String(deal.id);
  setText(dealTitle, deal.id === "" ? "Deal link" : `Deal #${deal.id}`);
  statusLabel.dataset.status = deal.status;
  setText(statusLabel, statusText[deal.status]);
  dealTerms.hidden = !showTerms;
  tokenDetails.hidden = !showTerms || !deal.payToken || !deal.receiveToken;
  reserved.hidden = !hasReservedTaker;
  if (!showTerms) return;

  setText(handle("pay-amount"), deal.payAmount);
  setText(handle("pay-symbol"), deal.paySymbol);
  setText(handle("receive-amount"), deal.receiveAmount);
  setText(handle("receive-symbol"), deal.receiveSymbol);
  setText(handle("maker"), deal.maker);
  setText(byId("reserved-address"), deal.taker);
  setText(byId("pay-token-address"), deal.payToken);
  setText(byId("receive-token-address"), deal.receiveToken);

  const stamp = String(deal.expiry);
  const date = new Date(Number(stamp) * 1000);
  expiryTime.dataset.expiry = stamp;
  if (Number.isFinite(date.getTime())) {
    expiryTime.dateTime = date.toISOString();
    setText(expiryTime, dateFormat.format(date));
  } else {
    expiryTime.removeAttribute("datetime");
    setText(expiryTime, `${stamp} Unix seconds`);
  }
}

function renderForm({ dealLink, formErrors, pending }) {
  for (const field of fields) {
    const error = byId(`${field.name}-error`);
    const message = formErrors?.[field.name];
    field.readOnly = Boolean(pending);
    if (message) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
    error.hidden = !message;
    setText(error, message);
  }

  const wasSharing = !share.hidden;
  const target = dealLink && new URL(dealLink, location.href);
  const canShare = target && target.origin === location.origin && /^#\/d\/\d+$/.test(target.hash);
  share.hidden = !canShare;
  byId("new-form-area").hidden = Boolean(canShare);
  setText(newTitle, canShare ? "Deal created" : "Create a deal");

  if (canShare) {
    if (!wasSharing || link.href !== target.href) setNotice(copyFeedback, null);
    link.href = target.href;
    link.dataset.testid = "deal-link";
    setText(link, link.href);
    if (!wasSharing) newTitle.focus();
  } else {
    link.removeAttribute("href");
    link.removeAttribute("data-testid");
    setText(link, "");
  }
}

export function render(model) {
  const { screen, action, deal, pending } = model;
  if (screen !== activeScreen) {
    for (const view of screens) view.hidden = view.dataset.screen !== screen;
    actionSlots[screen]?.append(actions);
    primary.type = screen === "new" ? "submit" : "button";
    activeScreen = screen;
  }

  if (screen === "deal" && deal) renderDeal(deal);
  if (screen === "new") renderForm(model);
  else if (!share.hidden) {
    share.hidden = true;
    link.removeAttribute("data-testid");
  }

  let message = model.notice;
  if (!message && screen === "deal") message = statusMessage[deal?.status];
  if (!message && screen === "error") {
    message = { text: "Refresh or check that you have the correct link.", tone: "error" };
  }
  setNotice(notice, message);
  primary.hidden = !action;
  primary.disabled = !action?.enabled || Boolean(pending);
  primary.setAttribute("aria-busy", String(Boolean(pending)));
  setText(primary, action?.label);
  retry.hidden = !model.retry || Boolean(action);
  setText(retry, model.retryLabel ?? "Try again");
  actions.hidden = !actionSlots[screen] || !(action || message || model.retry);
}

export function getForm() {
  return Object.fromEntries(fields.map((field) => [field.name, field.value]));
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(link.href);
    setNotice(copyFeedback, { text: "Deal link copied.", tone: "success" });
  } catch {
    link.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(link);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setNotice(copyFeedback, { text: "Copy the link above to share this deal.", tone: "info" });
  }
}

export function bind({ onAction, onInput, onRetry, onReset }) {
  primary.addEventListener("click", () => {
    if (primary.type === "button" && !primary.disabled) onAction();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!primary.hidden && !primary.disabled) onAction();
  });
  form.addEventListener("input", () => onInput());
  retry.addEventListener("click", () => onRetry());
  copy.addEventListener("click", copyLink);
  for (const newLink of document.querySelectorAll('a[href="#/new"]')) {
    newLink.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (activeScreen === "new" && share.hidden) return;
      if (!onReset?.()) return;
      form.reset();
      if (location.hash === "#/new") event.preventDefault();
    });
  }
}
