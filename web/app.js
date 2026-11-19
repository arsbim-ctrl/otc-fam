// otc.fam's page. #/d/<id> shows a deal to whoever opens its link and lets its taker fill it (deal-page.js); #/new
// makes a deal (new-deal-page.js). This file reads config.json, finds the browser's wallet, and routes.
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

function route() {
  page?.stop();
  const deal = /^#\/d\/(.*)$/.exec(location.hash);
  page = deal ? dealPage(app, deal[1]) : location.hash === "#/new" ? newDealPage(app) : homePage();
  scrollTo(0, 0);
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
    h("a", { class: "button primary", href: "#/new" }, "Make a deal"),
    h("form", { class: "row", onsubmit: open }, number, h("button", { class: "secondary", type: "submit" }, "Open"))));
  return { update() {}, stop() {} };
}

function showAccount() {
  const chip = document.getElementById("account");
  chip.hidden = !app.wallet?.account;
  chip.textContent = app.wallet?.account ? short(app.wallet.account) : "";
}
