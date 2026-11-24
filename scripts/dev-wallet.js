// The stand-in wallet of "npm run dev", served only by scripts/dev.mjs and never part of the built site. It puts a
// window.ethereum in the page that speaks EIP-1193 and passes every request to the local chain's server, as the
// person chosen in the bar at the bottom of the page: the seller, the buyer or a stranger. It holds no key. The bar
// also moves the local chain's time forward, and copies the addresses to paste into the form.
// scripts/dev.mjs puts `window.__dev = { people, tokens }` in front of this file.
(() => {
  const { people, tokens } = window.__dev;
  const listeners = {};
  let rejectNext = false;
  let wrongChain = false;
  let account = people.Seller; // a tab starts as the seller, who makes the deal; each tab remembers its own choice
  try {
    account = sessionStorage.getItem("dev-account") ?? account;
  } catch {}
  const post = async (path, value) => (await fetch(path, { method: "POST", body: JSON.stringify(value) })).json();
  if (account !== "none") {
    window.ethereum = {
      async request({ method, params }) {
        if (wrongChain && method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") wrongChain = false;
        if (rejectNext && ["eth_signTypedData_v4", "eth_sendTransaction"].includes(method)) {
          rejectNext = false;
          document.getElementById("dev-reject").textContent = "Reject next wallet request";
          throw Object.assign(new Error("User rejected the request"), { code: 4001 });
        }
        const { result, error } = await post("dev/wallet", { account, request: { method, params } });
        if (error) throw Object.assign(new Error(error.message), { code: error.code, data: error.data });
        if (method === "eth_requestAccounts") for (const listener of listeners.accountsChanged ?? []) listener(result);
        return result;
      },
      on(event, listener) {
        (listeners[event] ??= []).push(listener);
        return this;
      },
      removeListener(event, listener) {
        listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
        return this;
      },
    };
  }

  addEventListener("DOMContentLoaded", () => {
    const el = (tag, props, ...children) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...children);
      return node;
    };
    const as = el("select", { id: "dev-account", ariaLabel: "Whose wallet this browser has" },
      ...Object.entries(people).map(([name, address]) => el("option", { value: address, selected: address === account }, `${name}'s wallet`)),
      el("option", { value: "none", selected: account === "none" }, "No wallet"));
    as.onchange = () => {
      sessionStorage.setItem("dev-account", as.value);
      location.reload();
    };
    const forward = (days) => el("button", { type: "button", onclick: async () => {
      await post("dev/time", { seconds: days * 86_400 });
      dispatchEvent(new Event("focus")); // the page reads the chain again
    } }, `+${days} day${days === 1 ? "" : "s"}`);
    const copy = (name, text) => el("button", { type: "button", title: text, onclick: () => navigator.clipboard?.writeText(text) }, `Copy ${name}`);
    const reject = el("button", { type: "button", id: "dev-reject", onclick: () => {
      rejectNext = !rejectNext;
      reject.textContent = rejectNext ? "Next request will be rejected" : "Reject next wallet request";
    } }, "Reject next wallet request");
    const network = el("button", { type: "button", onclick: () => {
      wrongChain = !wrongChain;
      for (const listener of listeners.chainChanged ?? []) listener(wrongChain ? "0x1" : "0x7a69");
    } }, "Toggle wrong network");
    const bar = el("div", { id: "dev-bar" }, el("strong", {}, "Local test chain"), as, el("span", {}, "Time:"), ...[1, 14, 15, 45].map(forward),
      el("span", {}, "Copy:"), copy("FAM", tokens.FAM), copy("USDC", tokens.USDC), copy("seller", people.Seller), copy("the buyer", people.Buyer), copy("broker", people.Broker), ...(account === "none" ? [] : [reject, network]));
    bar.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:9;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 12px;background:#17151f;color:#fff;font:13px system-ui";
    for (const control of bar.querySelectorAll("button, select")) {
      control.style.cssText = "width:auto;padding:5px 9px;border:0;border-radius:8px;background:#fff;color:#17151f;font:inherit;cursor:pointer";
    }
    document.body.append(bar);
    new ResizeObserver(() => { document.body.style.paddingBottom = `${bar.offsetHeight + 12}px`; }).observe(bar);
  });
})();
