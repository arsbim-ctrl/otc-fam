// otc.fam's page. #/d/<id> shows a deal to whoever opens its link and lets its taker fill it (deal-page.js); #/new
// makes a deal (new-deal-page.js). This file reads config.json, finds the browser's wallet, and routes.
import { dealPage } from "./deal-page.js";
import { Chain, same, Wallet, ZERO_ADDRESS } from "./eth.js";
import { newDealPage } from "./new-deal-page.js";
import { card, h, networkName, short } from "./ui.js";
import { isAddress } from "./units.js";
import { UINT256_MAX, VestingChain } from "./v2-chain.js";
import { v2CreatePage } from "./v2-create-page.js";
import { v2DealPage } from "./v2-deal-page.js";
import { TEST_NETWORKS } from "./v2-ui.js";

/** What every page works with: where it draws, the config, the chain it reads, and the wallet, if the browser has one. */
const app = { main: document.getElementById("app"), config: null, chain: null, v2Chain: null, wallet: null };
let page;

start();

async function start() {
  try {
    const response = await fetch("config.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    app.config = await response.json();
    const { chainId, contract, v2Contract, rpcUrl, v2DeploymentBlock, explorerUrl } = app.config;
    if (!Number.isSafeInteger(chainId) || chainId < 1 || typeof rpcUrl !== "string"
      || (contract !== undefined && !isAddress(contract)) || (v2Contract !== undefined && !isAddress(v2Contract))) {
      throw new Error("It must give chainId, rpcUrl and valid contract addresses.");
    }
    if (v2DeploymentBlock !== undefined && (!Number.isSafeInteger(v2DeploymentBlock) || v2DeploymentBlock < 0)) {
      throw new Error("v2DeploymentBlock must be a nonnegative block number.");
    }
    if (explorerUrl && !["https:", "http:"].includes(new URL(explorerUrl).protocol)) {
      throw new Error("explorerUrl must be an HTTPS or HTTP URL.");
    }
  } catch (e) {
    app.main.replaceChildren(card(h("h1", {}, "This site is not set up"), h("p", { class: "lead" }, `Its config.json could not be read (${e.message}).`)));
    return;
  }
  const rpcUrl = new URL(app.config.rpcUrl, location.href).href;
  app.chain = new Chain(rpcUrl, app.config.contract ?? ZERO_ADDRESS);
  if (app.config.v2Contract && !same(app.config.v2Contract, ZERO_ADDRESS) && TEST_NETWORKS.has(app.config.chainId)) {
    app.v2Chain = new VestingChain(app.config, rpcUrl);
  }
  if (window.ethereum) {
    app.wallet = new Wallet(window.ethereum, () => {
      showAccount();
      page?.update();
    });
    await Promise.race([app.wallet.ready, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  document.getElementById("network").textContent = networkName(app.config.chainId);
  showAccount();
  addEventListener("hashchange", route);
  route();
}

function route() {
  page?.stop();
  const hash = location.hash;
  const deal = /^#\/d\/(.*)$/.exec(hash);
  const v2 = hash.startsWith("#/v2/");
  const footer = document.getElementById("footer");
  document.getElementById("app").classList.toggle("v2-layout", v2);
  footer.replaceChildren(h("a", { href: v2 ? "#/new" : "#/v2/new" }, v2 ? "Legacy deals · V1" : "Create a vesting or immediate deal · V2"),
    h("p", {}, v2 ? "OTC V2 contract " : "Legacy V1 contract ",
      h("span", { class: "mono" }, (v2 ? app.config.v2Contract : app.config.contract) ?? "Unconfigured")));
  if (v2) {
    const v2App = { ...app, chain: app.v2Chain };
    page = v2Page(v2App, hash);
  } else {
    page = deal ? dealPage(app, deal[1]) : hash === "#/new" ? newDealPage(app) : homePage();
  }
  scrollTo(0, 0);
}

function v2Page(v2App, hash) {
  const problem = (title, text) => {
    v2App.main.replaceChildren(card(h("span", { class: "v2-kicker" }, "OTC V2"), h("h1", {}, title), h("p", { class: "lead" }, text)));
    return { update() {}, stop() {} };
  };
  if (!v2App.chain) {
    return problem("OTC V2 is unavailable", "Configure the V2 settlement contract on a supported test network to use new vesting and fee-bearing deals.");
  }
  if (hash === "#/v2/new") return v2CreatePage(v2App);
  const link = /^#\/v2\/d\/(\d+)\/(0x[0-9a-f]{40})\/(\d{1,78})$/i.exec(hash);
  if (!link || BigInt(link[3]) === 0n || BigInt(link[3]) > UINT256_MAX) {
    return problem("Invalid V2 deal link", "Ask the seller to share the full link from their funding receipt.");
  }
  if (Number(link[1]) !== v2App.config.chainId || !same(link[2], v2App.chain.contract)) {
    return problem("This link uses another deployment", "The network or V2 contract in this link differs from this site’s configuration. Verify the deployment with the seller.");
  }
  return v2DealPage(v2App, BigInt(link[3]));
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
    h("a", { class: "button primary", href: app.v2Chain ? "#/v2/new" : "#/new" }, app.v2Chain ? "Create a private deal · V2" : "Make a deal"),
    app.v2Chain && h("div", { class: "row" }, h("a", { class: "button secondary", href: "#/new" }, "Create a legacy deal · V1")),
    h("form", { class: "row", onsubmit: open }, number, h("button", { class: "secondary", type: "submit" }, "Open"))));
  return { update() {}, stop() {} };
}

function showAccount() {
  const chip = document.getElementById("account");
  chip.hidden = !app.wallet?.account;
  chip.textContent = app.wallet?.account ? short(app.wallet.account) : "";
}
