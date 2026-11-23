// The page's building blocks: a DOM builder, the pieces both pages show, and the words for networks, times and
// amounts. Text always goes into the page as text, never as HTML: a token's symbol is whatever its contract says.
import { formatAmount } from "./units.js";

const NETWORKS = {
  1: "Ethereum", 10: "OP Mainnet", 137: "Polygon", 8453: "Base", 42161: "Arbitrum One", 84532: "Base Sepolia", 11155111: "Sepolia",
  31337: "Local test chain",
};
const STATUS_WORDS = { open: "Open", filled: "Filled", cancelled: "Cancelled", expired: "Expired", "not-found": "No such deal" };
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export const DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
export const NO_WALLET = "There is no wallet in this browser. Open this link in your wallet app's browser "
  + "(MetaMask, Rabby, Coinbase Wallet…) or in a browser with a wallet extension.";

export const networkName = (chainId) => NETWORKS[chainId] ?? `chain ${chainId}`;
export const amount = (units, token) => `${formatAmount(units, token.decimals)} ${token.symbol}`;
export const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** "Fri, 20 Nov 2026, 15:23 UTC (in 2 hours)" for unix time `seconds`, seen at unix time `now`. */
export function when(seconds, now) {
  if (seconds > 253_402_300_799) return "Never (after the year 9999)";
  return `${DATE.format(new Date(seconds * 1000))} (${fromNow(seconds - now)})`;
}

/** "in 5 minutes", "2 hours ago", "in 3 days" for a time `seconds` away. */
export function fromNow(seconds) {
  const minutes = Math.round(seconds / 60), hours = Math.round(seconds / 3600);
  if (minutes === 0) return seconds >= 0 ? "in less than a minute" : "less than a minute ago";
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  if (Math.abs(hours) < 48) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(Math.round(seconds / 86_400), "day");
}

/** The DOM builder: h("p", { class, testid, onclick… }, "text", child…). Children that are null, false or "" are left out. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "testid") el.setAttribute("data-testid", value);
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== ""));
  return el;
}

export const card = (...children) => h("section", { class: "card" }, ...children);
export const fact = (term, ...value) => h("div", {}, h("dt", {}, term), h("dd", {}, ...value));
export const dot = (token) => h("i", { class: "dot", style: `--hue:${parseInt(token.address.slice(2, 8), 16) % 360}` });
export const notice = ({ kind, text }) => h("p", { class: `notice ${kind}`, testid: "notice", role: kind !== "error" ? "status" : null }, text);

/** Keep the live region mounted and only announce new text. */
export function liveStatus(className = "sr-only") {
  const element = h("p", { class: className, role: "status", "aria-live": "polite", "aria-atomic": "true" });
  return {
    element,
    update(message) {
      const text = message ?? "";
      if (element.textContent !== text) element.textContent = text;
    },
  };
}

/** A deal's title, and its state in words and in data-status. */
export function head(title, status) {
  return h("div", { class: "card-head" }, h("h1", {}, title),
    h("span", { class: `status ${status}`, testid: "deal-status", "data-status": status }, STATUS_WORDS[status]));
}

/** One side of a deal (`side` is "pay" or "receive"): its amount, its token's symbol and its token's address. */
export function leg(label, units, token, side) {
  const text = formatAmount(units, token.decimals);
  return h("div", { class: "leg" },
    h("div", { class: "leg-label" }, label),
    h("div", { class: "leg-row" },
      h("span", { class: `amount${text.length > 16 ? " long" : text.length > 10 ? " mid" : ""}`, testid: `${side}-amount` }, text),
      h("span", { class: "token" }, dot(token), h("span", { testid: `${side}-symbol` }, token.symbol))),
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
    button && h("button", { class: "primary", type: "button", testid: "primary-action", disabled: !button.run, onclick: button.run && ((e) => press(e, button.run)) },
      button.label),
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
