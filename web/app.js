// otc.fam's page. #/d/<id> shows a deal to whoever opens its link and lets its taker fill it (deal-page.js); #/new
// makes a deal (new-deal-page.js). This file reads config.json, finds the browser's wallet, and routes.
import { dealPage } from "./deal-page.js";
import { Chain, same, Wallet, ZERO_ADDRESS } from "./eth.js";
import { V2Chain } from "./eth-v2.js";
import { newDealPage } from "./new-deal-page.js";
import { card, h, networkName, short } from "./ui.js";
import { isAddress } from "./units.js";
import { v2DealPage } from "./v2-deal-page.js";
import { v2NewPage } from "./v2-new-page.js";

/** What every page works with: where it draws, the config, the chain it reads, and the wallet, if the browser has one. */
const app = { main: document.getElementById("app"), config: null, chain: null, wallet: null };
let page;
let v2;

start();

async function start() {
  try {
    const response = await fetch("config.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    app.config = await response.json();
    const { chainId, contract, rpcUrl } = app.config;
    if (!Number.isSafeInteger(chainId) || !isAddress(contract) || typeof rpcUrl !== "string") throw new Error("it must give chainId, contract and rpcUrl");
  } catch (e) {
    app.main.replaceChildren(card(h("h1", {}, "This site is not set up"), h("p", { class: "lead" }, `Its config.json could not be read (${e.message}).`)));
    return;
  }
  app.chain = new Chain(new URL(app.config.rpcUrl, location.href).href, app.config.contract);
  const { v2: deployment, chainId, rpcUrl } = app.config;
  if (deployment && isAddress(deployment.contract) && !same(deployment.contract, ZERO_ADDRESS)) {
    const config = { chainId, rpcUrl, ...deployment };
    if (Number.isSafeInteger(config.chainId) && config.chainId > 0 && typeof config.rpcUrl === "string") {
      try {
        v2 = { config, chain: new V2Chain(config) };
      } catch {
        // V2 configuration is independent of legacy routes.
      }
    }
  }
  if (window.ethereum) {
    app.wallet = new Wallet(window.ethereum, () => {
      showAccount();
      page?.update();
    });
    await Promise.race([app.wallet.ready, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  showAccount();
  addEventListener("hashchange", route);
  route();
}

function route() {
  page?.stop();
  const hash = location.hash;
  const legacy = /^#\/d\/(.*)$/.exec(hash);
  const isV2 = hash.startsWith("#/v2/");
  const displayed = isV2 ? v2?.config : app.config;
  document.body.classList.toggle("version-two", isV2);
  document.getElementById("network").textContent = displayed ? networkName(displayed.chainId) : "V2";
  document.getElementById("footer").replaceChildren(...(displayed ? [
    `${isV2 ? "V2" : "Legacy V1"} contract on ${networkName(displayed.chainId)} · `,
    h("span", { class: "mono" }, displayed.contract),
  ] : []));
  page = isV2 ? showV2(hash) : legacy ? dealPage(app, legacy[1]) : hash === "#/new" ? newDealPage(app) : homePage();
  scrollTo(0, 0);
}

function showV2(hash) {
  const routeError = (title, text) => {
    app.main.replaceChildren(card(h("h1", {}, title), h("p", { class: "lead" }, text),
      h("a", { class: "button secondary", href: "#/" }, "Back to otc.fam")));
    return { update() {}, stop() {} };
  };
  if (!v2) return routeError("V2 setup required", "This site needs a V2 testnet contract and a matching read-only RPC.");
  const ctx = { ...app, ...v2 };
  if (hash === "#/v2/new") return v2NewPage(ctx);
  const match = /^#\/v2\/d\/(\d+)\/(0x[\da-f]{40})\/([1-9]\d{0,77})$/i.exec(hash);
  if (!match || BigInt(match[3]) >= 2n ** 256n) return routeError("Invalid V2 deal link", "Ask the seller for the complete link.");
  if (Number(match[1]) !== ctx.config.chainId || !same(match[2], ctx.config.contract)) {
    return routeError("Different V2 deployment", "This link names another network or contract. Open it on the site configured for that deployment.");
  }
  return v2DealPage(ctx, BigInt(match[3]));
}

function homePage() {
  const number = h("input", { id: "deal-number", inputmode: "numeric", placeholder: "Deal number", autocomplete: "off" });
  const open = (e) => {
    e.preventDefault();
    if (/^\d+$/.test(number.value.trim())) location.hash = `#/d/${number.value.trim()}`;
  };
  document.title = "otc.fam: one deal, one link";
  app.main.replaceChildren(card(
    h("h1", {}, "One deal, one link"),
    h("p", { class: "lead" }, "Offer tokens for other tokens and send the link to the other side. They see what they pay and what they get, "
      + "and fill it from their wallet: both sides swap in one transaction, or nothing moves."),
    h("a", { class: "button primary", href: "#/v2/new" }, "Create private deal · V2"),
    h("a", { class: "button secondary legacy-link", href: "#/new" }, "Make a legacy deal · V1"),
    h("form", { class: "row", onsubmit: open }, number, h("button", { class: "secondary", type: "submit" }, "Open"))));
  return { update() {}, stop() {} };
}

function showAccount() {
  const chip = document.getElementById("account");
  chip.hidden = !app.wallet?.account;
  chip.textContent = app.wallet?.account ? short(app.wallet.account) : "";
}
