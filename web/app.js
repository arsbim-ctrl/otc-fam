// otc.fam's page. It reads config.json, finds the browser's wallet, and routes by the link:
//   #/v3/new, #/v3/d/<chain>/<contract>/<terms>, #/v3/deals
//                           a broker deal (v3): a broker prepares the terms, the seller signs and funds, the buyer signs
//                           and settles; the broker receives a share of the fees. Its link carries the terms themselves.
//   #/v2/new, #/v2/d/<id>   a deal of the v2 contract: 0.5% fee on each side, delivered at once or as a vesting grant
//   #/new, #/d/<id>         a deal of the round 1 contract (v1): a plain swap with no fee, kept as it was
// The three contracts are separate, and a link always says which one its deal lives in.
import { dealPage } from "./deal-page.js";
import { Chain, Wallet } from "./eth.js";
import { newDealPage } from "./new-deal-page.js";
import { card, explorerOf, h, networkName, short } from "./ui.js";
import { isAddress } from "./units.js";
import { dealPageV2 } from "./v2-deal-page.js";
import { newDealPageV2 } from "./v2-new-page.js";
import { DealsV2 } from "./v2.js";
import { dealPageV3 } from "./v3-deal-page.js";
import { historyPageV3 } from "./v3-history-page.js";
import { newDealPageV3 } from "./v3-new-page.js";
import { DealsV3 } from "./v3.js";

/** What every page works with: where it draws, the config, the chain it reads, the v2 and v3 contracts if the site has them, and the wallet, if the browser has one. */
const app = { main: document.getElementById("app"), config: null, chain: null, v2: null, v3: null, wallet: null, explorer: null };
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
  const { chainId, contract, contractV2, fromBlockV2, contractV3, fromBlockV3 } = app.config;
  app.chain = new Chain(new URL(app.config.rpcUrl, location.href).href, contract);
  app.explorer = explorerOf(app.config); // where a receipt's transaction can be looked up, if the network has such a site
  // The v2 contract is optional: a site without one (or with the zero address) serves v1 deals only.
  if (isAddress(contractV2 ?? "") && !/^0x0{40}$/.test(contractV2)) app.v2 = new DealsV2(app.chain, contractV2, Number.isSafeInteger(fromBlockV2) ? fromBlockV2 : 0);
  // So is the broker deals contract (v3): without one, broker deals are neither prepared nor read here.
  if (isAddress(contractV3 ?? "") && !/^0x0{40}$/.test(contractV3)) app.v3 = new DealsV3(app.chain, contractV3, Number.isSafeInteger(fromBlockV3) ? fromBlockV3 : 0);
  if (window.ethereum) {
    app.wallet = new Wallet(window.ethereum, () => {
      showAccount();
      page?.update();
    });
    await Promise.race([app.wallet.ready, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  document.getElementById("network").textContent = networkName(chainId);
  document.getElementById("footer").replaceChildren(...[
    app.v3 && h("p", {}, `v3 broker deals contract on ${networkName(chainId)} (signed terms, broker's share of the fees): `, h("span", { class: "mono" }, app.v3.contract)),
    app.v2 && h("p", {}, `v2 deal contract on ${networkName(chainId)} (0.5% fee each side, vesting): `, h("span", { class: "mono" }, app.v2.contract)),
    h("p", {}, `${app.v2 ? "v1 deal contract (no fee)" : `Deals contract on ${networkName(chainId)}`}: `, h("span", { class: "mono" }, contract)),
  ].filter(Boolean));
  showAccount();
  addEventListener("hashchange", route);
  route();
}

function route() {
  page?.stop();
  const hash = location.hash;
  const v2Deal = /^#\/v2\/d\/(.*)$/.exec(hash), deal = /^#\/d\/(.*)$/.exec(hash);
  const v3Deal = /^#\/v3\/d\/(.*)$/.exec(hash), v3New = /^#\/v3\/new(?:\/(.*))?$/.exec(hash);
  page = v3Deal ? dealPageV3(app, v3Deal[1]) : v3New ? newDealPageV3(app, v3New[1] ?? "") : hash === "#/v3/deals" ? historyPageV3(app)
    : v2Deal ? dealPageV2(app, v2Deal[1]) : hash === "#/v2/new" ? newDealPageV2(app)
    : deal ? dealPage(app, deal[1]) : hash === "#/new" ? newDealPage(app) : homePage();
  scrollTo(0, 0);
}

function homePage() {
  const number = h("input", { id: "deal-number", inputmode: "numeric", placeholder: "Deal number", autocomplete: "off", "aria-label": "Deal number" });
  const version = app.v2 && h("select", { id: "deal-version", "aria-label": "Which contract the deal is in" }, h("option", { value: "v2/" }, "v2"), h("option", { value: "" }, "v1"));
  const open = (e) => {
    e.preventDefault();
    if (/^\d+$/.test(number.value.trim())) location.hash = `#/${version?.value ?? ""}d/${number.value.trim()}`;
  };
  document.title = "otc.fam: one deal, one link";
  app.main.replaceChildren(card(
    h("h1", {}, "One deal, one link"),
    h("p", { class: "lead" }, app.v2
      ? "Sell tokens to one buyer and send them the link. They see what they pay, both fees and what they get, at once or as a vesting grant, "
        + "and settle from their wallet: everything happens in one transaction, or nothing moves."
      : "Offer tokens for other tokens and send the link to the other side. They see what they pay and what they get, "
        + "and fill it from their wallet: both sides swap in one transaction, or nothing moves."),
    h("a", { class: "button primary", href: app.v2 ? "#/v2/new" : "#/new" }, "Make a deal"),
    app.v2 && h("a", { class: "button secondary", href: "#/new" }, "Make a v1 deal: a plain swap, no fee, no vesting"),
    app.v3 && h("a", { class: "button secondary", testid: "broker-new", href: "#/v3/new" }, "Broker? Prepare a deal for a seller and a buyer (v3)"),
    app.v3 && h("a", { class: "button secondary", testid: "broker-deals", href: "#/v3/deals" }, "Broker deals: your history and receipts"),
    h("form", { class: "row", onsubmit: open }, number, version, h("button", { class: "secondary", type: "submit" }, "Open"))));
  return { update() {}, stop() {} };
}

function showAccount() {
  const chip = document.getElementById("account");
  chip.hidden = !app.wallet?.account;
  chip.textContent = app.wallet?.account ? short(app.wallet.account) : "";
}
