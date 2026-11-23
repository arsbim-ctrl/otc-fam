// otc.fam's page. #/d/<id> shows a deal to whoever opens its link and lets its taker fill it (deal-page.js); #/new
// makes a deal (new-deal-page.js). This file reads config.json, finds the browser's wallet, and routes.
import { dealPageV2 } from "./v2-deal-page.js";
import { newDealPageV2 } from "./v2-new-deal-page.js";
import { ChainV2 } from "./eth-v2.js";
import { dealPage } from "./deal-page.js";
import { Chain, Wallet } from "./eth.js";
import { newDealPage } from "./new-deal-page.js";
import { card, h, networkName, short } from "./ui.js";
import { isAddress } from "./units.js";

/** What every page works with: where it draws, the config, the chain it reads, and the wallet, if the browser has one. */
const app = { main: document.getElementById("app"), config: null, chain: null, wallet: null };
let page;

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
  if (window.ethereum) {
    app.wallet = new Wallet(window.ethereum, () => {
      showAccount();
      page?.update();
    });
    await Promise.race([app.wallet.ready, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  document.getElementById("network").textContent = networkName(app.config.chainId);
  document.getElementById("footer").replaceChildren(`Deals contract on ${networkName(app.config.chainId)}: `, h("span", { class: "mono" }, app.config.contract));
  showAccount();
  addEventListener("hashchange", route);
  route();
}

const v2Configured = () => isAddress(app.config.contractV2) && !/^0x0{40}$/i.test(app.config.contractV2);

function route() {
  page?.stop();
  if (location.hash.startsWith("#/v2/")) {
    if (!v2Configured()) {
      app.main.replaceChildren(card(h("h1", {}, "V2 is not configured"), h("p", {}, "Set contractV2 in config.json to the deployed V2 address.")));
      page = null;
      return;
    }
    const config = { ...app.config, contract: app.config.contractV2 };
    const v2 = { ...app, config, chain: new ChainV2(new URL(config.rpcUrl, location.href).href, config.contract) };
    const match = /^#\/v2\/d\/(.*)$/.exec(location.hash);
    page = match ? dealPageV2(v2, match[1]) : newDealPageV2(v2);
    document.getElementById("footer").textContent = `V2 deals contract: ${config.contract}`;
    scrollTo(0, 0);
    return;
  }
  document.getElementById("footer").textContent = `Legacy v1 deals contract: ${app.config.contract}`;
  const deal = /^#\/d\/(.*)$/.exec(location.hash);
  page = deal ? dealPage(app, deal[1]) : location.hash === "#/new" ? newDealPage(app) : homePage();
  scrollTo(0, 0);
}

function homePage() {
  const number = h("input", { id: "deal-number", placeholder: "ID or V2 link", "aria-label": "Deal number or V2 link", autocomplete: "off" });
  const open = (e) => {
    e.preventDefault();
    const value = number.value.trim();
    const link = /^(?:https?:\/\/[^#\s]+)?(#\/v2\/d\/\d+)$/.exec(value);
    if (link) location.hash = link[1];
    else if (/^\d+$/.test(value)) location.hash = `#/d/${value}`;
  };
  document.title = "otc.fam: one deal, one link";
  app.main.replaceChildren(card(
    h("h1", {}, "One deal, one link"),
    h("p", { class: "lead" }, "Offer tokens for other tokens and send the link to the other side. They see what they pay and what they get, "
      + "and fill it from their wallet: both sides swap in one transaction, or nothing moves."),
    h("a", { class: "button primary", href: "#/new" }, "Make a deal · legacy v1"),
    v2Configured() && h("a", { class: "button secondary", href: "#/v2/new" }, "Make a fee / vesting deal · v2"),
    h("form", { class: "row", onsubmit: open }, number, h("button", { class: "secondary", type: "submit" }, "Open"))));
  return { update() {}, stop() {} };
}

function showAccount() {
  const chip = document.getElementById("account");
  chip.hidden = !app.wallet?.account;
  chip.textContent = app.wallet?.account ? short(app.wallet.account) : "";
}
