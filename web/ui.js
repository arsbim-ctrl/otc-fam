// The page's building blocks: a DOM builder, a way to show a new view by changing the old one in place, the pieces
// the pages share, and the words for networks, times and amounts. Text always goes into the page as text, never as
// HTML: a token's symbol is whatever its contract says.
import { formatAmount } from "./units.js";

const NETWORKS = {
  1: "Ethereum", 10: "OP Mainnet", 137: "Polygon", 8453: "Base", 42161: "Arbitrum One", 84532: "Base Sepolia", 11155111: "Sepolia",
  31337: "Local test chain",
};
const STATUS_WORDS = {
  open: "Open", filled: "Filled", cancelled: "Cancelled", expired: "Expired", "not-found": "No such deal", funded: "Funded", settled: "Settled",
};
const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export const DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
const UTC_DATE = new Intl.DateTimeFormat("en-GB", {
  weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "UTC",
});
export const NO_WALLET = "There is no wallet in this browser. Open this link in your wallet app's browser "
  + "(MetaMask, Rabby, Coinbase Wallet…) or in a browser with a wallet extension.";
export const TOKEN_WARNING = "Anyone can make a token with any name. Compare both token contract addresses with the ones you agreed on before you approve anything.";

// Where a transaction of each network can be looked up by anyone. A site's config.json can name another (explorerUrl).
const EXPLORERS = {
  1: "https://etherscan.io", 10: "https://optimistic.etherscan.io", 137: "https://polygonscan.com", 8453: "https://basescan.org",
  42161: "https://arbiscan.io", 84532: "https://sepolia.basescan.org", 11155111: "https://sepolia.etherscan.io",
};

export const networkName = (chainId) => NETWORKS[chainId] ?? `chain ${chainId}`;
/** The block explorer of the site's network, without a slash at its end, or null: a local chain has none. Only an https address is taken from the config. */
export function explorerOf({ chainId, explorerUrl }) {
  const url = typeof explorerUrl === "string" && /^https:\/\/[^\s"'<>]+$/.test(explorerUrl) ? explorerUrl : EXPLORERS[chainId];
  return url ? url.replace(/\/+$/, "") : null;
}
/** A transaction's hash in full: a link to it on the `explorer`, in a new tab, when the network has one. */
export const transaction = (hash, explorer) => (explorer
  ? h("a", { class: "mono", href: `${explorer}/tx/${hash}`, target: "_blank", rel: "noopener noreferrer", title: "Look this transaction up on the block explorer" }, hash)
  : h("span", { class: "mono" }, hash));
export const amount = (units, token) => `${formatAmount(units, token.decimals)} ${token.symbol}`;
export const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** The furthest time a date can show: the last second of the year 9999. */
const LAST_DATE = 253_402_300_799;

/** "Fri, 20 Nov 2026, 15:23 UTC (in 2 hours)" for unix time `seconds`, seen at unix time `now`. */
export function when(seconds, now) {
  if (seconds > LAST_DATE) return "Never (after the year 9999)";
  return `${DATE.format(new Date(seconds * 1000))} (${fromNow(seconds - now)})`;
}

/** "Tue, 1 Dec 2026, 00:00:00 UTC" for unix time `seconds`: the chain's time, in UTC whatever the browser's zone. */
export function utc(seconds) {
  if (Number(seconds) > LAST_DATE) return "after the year 9999";
  return `${UTC_DATE.format(new Date(Number(seconds) * 1000))} UTC`;
}

/** "in 5 minutes", "2 hours ago", "in 3 days" for a time `seconds` away. */
export function fromNow(seconds) {
  const minutes = Math.round(seconds / 60), hours = Math.round(seconds / 3600);
  if (minutes === 0) return seconds >= 0 ? "in less than a minute" : "less than a minute ago";
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  if (Math.abs(hours) < 48) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(Math.round(seconds / 86_400), "day");
}

/** "90 days", "36 hours", "1 day 12 hours", "45 seconds" for a number of seconds, exactly (no rounding). */
export function span(seconds) {
  const parts = [];
  let left = BigInt(seconds);
  for (const [size, name] of [[86_400n, "day"], [3600n, "hour"], [60n, "minute"], [1n, "second"]]) {
    const count = left / size;
    left %= size;
    if (count) parts.push(`${count.toLocaleString("en")} ${name}${count === 1n ? "" : "s"}`);
  }
  return parts.join(" ") || "0 seconds";
}

/** A press handler on any element: `el.__on.click` runs for a click, and can be swapped without touching the listener. */
const dispatch = (event) => event.currentTarget.__on?.[event.type]?.(event);
function listen(el, handlers) {
  el.__listening ??= new Set();
  for (const type of Object.keys(handlers)) {
    if (el.__listening.has(type)) continue;
    el.addEventListener(type, dispatch);
    el.__listening.add(type);
  }
  el.__on = handlers;
}

/** The DOM builder: h("p", { class, testid, onclick… }, "text", child…). Children that are null, false or "" are left out. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  const handlers = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) handlers[key.slice(2)] = value;
    else if (key === "testid") el.setAttribute("data-testid", value);
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  listen(el, handlers);
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== ""));
  return el;
}

/**
 * Turns the node `from`, which is in the page, into `to`, which was just built, and returns the node now in the page.
 * Wherever the two have the same kind of node at the same place, the old one stays and takes the new one's text,
 * attributes and handlers: a button the person has tabbed to is still the same button, and selected text stays selected.
 */
function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
    from.replaceWith(to);
    return to;
  }
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return from;
  }
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  listen(from, to.__on ?? {});
  const old = [...from.childNodes], next = [...to.childNodes];
  next.forEach((child, i) => (i < old.length ? morph(old[i], child) : from.append(child)));
  for (const child of old.slice(next.length)) child.remove();
  return from;
}

let keep = null; // the handle (data-testid) of the element the person put the focus on, while it stays there
if (typeof document !== "undefined") {
  document.addEventListener("focusin", (e) => (keep = e.target.getAttribute?.("data-testid") ?? null));
  // The person moved the focus away to nothing. A button that lost it because a press disabled it, or because the
  // page replaced it, is not that: it gets the focus back in show().
  document.addEventListener("focusout", (e) => e.relatedTarget || e.target.disabled || !e.target.isConnected || (keep = null));
}

/**
 * Shows `view` in `container`: the first time by putting it there, afterwards by changing what is there in place.
 * If the element the person had focused could not keep the focus (it was disabled for a moment, or replaced), the
 * element with the same handle gets it back as soon as it can take it.
 */
export function show(container, view) {
  const current = container.firstElementChild;
  if (current && container.childNodes.length === 1) morph(current, view);
  else container.replaceChildren(view);
  if (!keep || container.contains(document.activeElement)) return;
  const wanted = container.querySelector(`[data-testid="${CSS.escape(keep)}"]`);
  if (wanted && !wanted.disabled) wanted.focus({ preventScroll: true });
}

export const card = (...children) => h("section", { class: "card" }, ...children);
export const fact = (term, ...value) => h("div", {}, h("dt", {}, term), h("dd", {}, ...value));
export const dot = (token) => h("i", { class: "dot", style: `--hue:${parseInt(token.address.slice(2, 8), 16) % 360}` });
/** A message for the person. Something that went wrong is announced at once to a screen reader; the rest when it is idle. */
export const notice = ({ kind, text }) => h("p", { class: `notice ${kind}`, testid: "notice", role: kind === "error" ? "alert" : "status" }, text);

/** A deal's title, and its state in words and in data-status. `tag`, if given, is a small label next to the title (the contract's version). */
export function head(title, status, tag) {
  return h("div", { class: "card-head" }, h("h1", {}, title, tag && [" ", h("span", { class: "version", testid: "version" }, tag)]),
    h("span", { class: `status ${status}`, testid: "deal-status", "data-status": status }, STATUS_WORDS[status]));
}

/** One side of a deal (`side` is "pay" or "receive"): its amount, its token's symbol and its token's address. `sub` adds a line under them. */
export function leg(label, units, token, side, sub) {
  const text = formatAmount(units, token.decimals);
  return h("div", { class: "leg" },
    h("div", { class: "leg-label" }, label),
    h("div", { class: "leg-row" },
      h("span", { class: `amount${text.length > 16 ? " long" : text.length > 10 ? " mid" : ""}`, testid: `${side}-amount` }, text),
      h("span", { class: "token" }, dot(token), h("span", { testid: `${side}-symbol` }, token.symbol))),
    sub && h("div", { class: "leg-note" }, sub),
    h("div", { class: "leg-sub" }, "Token contract ", h("span", { class: "mono" }, token.address)));
}

/** A press of a button: the button is disabled at once, before anything is awaited, then `run` starts. */
export function press(event, run) {
  event.currentTarget.disabled = true;
  run();
}

/** A secondary button, pressable when it has something to `run`. */
export const secondary = (testid, label, run) =>
  h("button", { class: "secondary", type: "button", testid, disabled: !run, onclick: run && ((e) => press(e, run)) }, label);

/** The block under a deal or the form: the steps, the one button (`run` makes it pressable), what it does, a notice. */
export function action({ steps, step, button, hint, notice: message, extra }) {
  return h("div", { class: "action" },
    steps && h("ol", { class: "steps" }, steps.map((name, i) => h("li", { class: i < step ? "done" : i === step ? "now" : "" }, name))),
    button && h("button", { class: `primary${button.label.length > 28 ? " long" : ""}`, type: "button", testid: "primary-action", disabled: !button.run,
      onclick: button.run && ((e) => press(e, button.run)) }, button.label),
    hint && h("p", { class: "hint" }, hint),
    message && notice(message),
    extra);
}

export function copyButton(text) {
  return h("button", { class: "secondary", type: "button", onclick: async (e) => {
    const button = e.currentTarget;
    const copied = navigator.clipboard ? await navigator.clipboard.writeText(text).then(() => true, () => false) : false;
    button.textContent = copied ? "Link copied" : "Copying failed: copy the link from the address bar";
    setTimeout(() => (button.textContent = "Copy link"), 2500);
  } }, "Copy link");
}

export function setNote(el, text, problem) {
  el.textContent = text;
  el.classList.toggle("problem", problem);
}
