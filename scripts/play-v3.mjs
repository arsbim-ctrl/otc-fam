import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { formatAmount } from "../web/units.js";
import { brokerWorld, testWallet } from "./lib/broker-world.mjs";
import { DESKTOP, PHONE, serve } from "./lib/site.mjs";

const target = process.env.BROKER_EVIDENCE_DIR ?? "evidence/round-3";
const out = join(target, "screens");
const explorer = "https://explorer.example";
mkdirSync(out, { recursive: true });
const evidence = [];
const sizes = process.env.BROKER_VIEWPORT ? [PHONE, DESKTOP].filter((size) => String(size.width) === process.env.BROKER_VIEWPORT) : [PHONE, DESKTOP];
if (!sizes.length) throw new Error("BROKER_VIEWPORT must be 390 or 1440.");

const inject = () => {
  const listeners = new Map();
  window.ethereum = {
    async request({ method, params }) {
      const { result, error } = await window.__brokerWallet({ method, params });
      if (error) throw Object.assign(new Error(error.message), error);
      const name = method === "eth_requestAccounts" ? "accountsChanged" : method === "wallet_switchEthereumChain" ? "chainChanged" : null;
      if (name) for (const listener of listeners.get(name) ?? []) listener(name === "chainChanged" ? params[0].chainId : result);
      return result;
    },
    on(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
    removeListener(name, listener) { listeners.set(name, (listeners.get(name) ?? []).filter((other) => listener !== other)); },
  };
};
const id = (page, name) => page.getByTestId("v3-" + name);
const action = (page, label) => page.getByRole("button", { name: label, exact: true });
const waitText = async (locator, text) => {
  await locator.filter({ hasText: text }).waitFor({ state: "visible" });
};
const status = (page, value) => page.locator(`[data-testid=v3-status][data-status=${value}]`).waitFor();
const reject = { error: { code: 4001, message: "User rejected the request" } };

for (const size of sizes) {
  const w = await brokerWorld();
  const site = await serve(w, { ...w.configV3, explorerUrl: explorer });
  const contexts = [];
  const recorded = { width: size.width, screenshots: [], imageDimensions: {}, receipts: {} };
  const errors = [];
  let browser;
  try {
    browser = await chromium.launch();
    async function tab(path, role, options = {}) {
      const context = await browser.newContext({
        locale: "en-US", timezoneId: size === PHONE ? "America/Los_Angeles" : "Europe/Berlin",
        viewport: size, permissions: ["clipboard-read", "clipboard-write"],
      });
      contexts.push(context);
      if (role) {
        const answer = testWallet(w, role, options);
        await context.exposeBinding("__brokerWallet", (_source, request) => answer(request));
        await context.addInitScript(inject);
      }
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(site.url + "/" + path);
      return page;
    }
    async function shot(page, name) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Layout overflow at ${size.width}px · ${name}`);
      const file = `${name}-${size.width}.jpg`;
      const jpeg = await page.screenshot({ path: join(out, file), fullPage: true, animations: "disabled", type: "jpeg", quality: 83 });
      const dimensions = await page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/jpeg;base64,${base64}`;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      }, jpeg.toString("base64"));
      assert.equal(dimensions.width, size.width, file);
      assert.ok(dimensions.height >= size.height, file);
      recorded.screenshots.push(file);
      recorded.imageDimensions[file] = dimensions;
    }
    async function capture(page, name, kind) {
      const receipt = id(page, `receipt-${kind}`).first();
      const hash = await receipt.getAttribute("data-tx");
      assert.match(hash, /^0x[\da-f]{64}$/);
      const verified = await w.chain.rpc("eth_getTransactionReceipt", [hash]);
      assert.equal(verified.status, "0x1");
      assert.equal(verified.transactionHash, hash);
      await waitText(receipt, "Confirmed");
      await waitText(receipt, w.brokerDeals.address);
      assert.equal(await receipt.getByRole("link", { name: hash, exact: true }).getAttribute("href"), `${explorer}/tx/${hash}`);
      recorded.receipts[name] = verified;
    }
    async function create(page, { delivery = "0", quote = "100000", share = "20.00", hours = "24", fixedStart, scene } = {}) {
      await page.goto(site.url + "/#/v3/new");
      for (const [name, value] of Object.entries({
        seller: w.seller, buyer: w.buyer, broker: w.broker, "base-token": w.fam.address,
        "quote-token": w.usdc.address, allocation: "900.000000000000000001", quote, share, hours,
      })) await id(page, name).fill(value);
      await id(page, "delivery").selectOption(delivery);
      if (fixedStart) await id(page, "start").fill(fixedStart);
      await waitText(id(page, "fee-preview"), quote === "100000" ? "200 USDC" : "0.246913 USDC");
      await id(page, "review").click();
      await id(page, "create").waitFor();
      if (fixedStart) {
        await page.getByText("Counterparties and signing terms", { exact: true }).click();
        await waitText(id(page, "terms"), fixedStart.slice(11) + " UTC");
      }
      if (scene) await shot(page, scene);
      await id(page, "create").click();
      const link = await id(page, "open-link").getAttribute("href");
      assert.match(link, /^#\/v3\/p\//);
      await id(page, "copy").click();
      await waitText(page.getByRole("status").filter({ hasText: "Deal link copied." }), "Deal link copied.");
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), site.url + "/" + link);
      return link;
    }
    async function fund(page) {
      await status(page, "awaiting");
      await action(page, "Connect wallet").click();
      await action(page, "Approve FAM").click();
      await action(page, "Sign and fund deal").click();
      await status(page, "funded");
    }
    async function settle(page) {
      await action(page, "Connect wallet").click();
      const approve = action(page, "Approve USDC");
      await approve.click();
      await action(page, "Sign and settle deal").click();
      await status(page, "settled");
    }
    const brokerAsked = [];
    const broker = await tab("#/v3/new", "broker", { asked: brokerAsked });
    const immediate = await create(broker, { scene: "01-broker-review-immediate" });
    await shot(broker, "02-link-created");
    const plain = await tab(immediate);
    await status(plain, "awaiting");
    assert.equal(await id(plain, "action").count(), 0);
    await waitText(plain.locator(".broker-warning"), "Compare both token contract addresses");
    await waitText(id(plain, "terms"), "UTC");
    await shot(plain, "03-awaiting-funding-wallet-free");
    const seller = await tab(immediate, "seller");
    await fund(seller);
    await capture(seller, "immediateFunding", "funded");
    await shot(seller, "04-seller-funded");
    const walletFree = await tab(immediate);
    await status(walletFree, "funded");
    assert.equal(await id(walletFree, "action").count(), 0);
    await shot(walletFree, "05-fresh-funded-preview");
    const outsider = await tab(immediate, "other");
    await action(outsider, "Connect wallet").click();
    await waitText(id(outsider, "wrong-wallet"), "Select the named buyer wallet");
    assert.equal(await id(outsider, "action").count(), 0);
    await shot(outsider, "06-wrong-wallet");
    let firstConnect = true, firstSignature = true;
    const buyerAsked = [];
    const buyer = await tab(immediate, "buyer", { chainId: 1, asked: buyerAsked, intercept(request) {
      if (request.method === "eth_requestAccounts" && firstConnect) { firstConnect = false; return reject; }
      if (request.method === "eth_signTypedData_v4" && firstSignature) { firstSignature = false; return reject; }
      return null;
    } });
    await status(buyer, "funded");
    assert.ok(buyerAsked.every((method) => !["eth_requestAccounts", "eth_signTypedData_v4", "eth_sendTransaction"].includes(method)));
    const connect = action(buyer, "Connect wallet");
    await connect.focus();
    await connect.press("Enter");
    await waitText(id(buyer, "notice"), "You declined in your wallet");
    assert.equal(await connect.evaluate((node) => document.activeElement === node), true);
    await connect.click();
    await id(buyer, "wrong-chain").waitFor();
    await shot(buyer, "07-wrong-network");
    await buyer.getByRole("button", { name: /^Switch to / }).click();
    await action(buyer, "Approve USDC").click();
    const buyerAmountBefore = await w.usdc.read.balanceOf(w.buyer);
    const sign = action(buyer, "Sign and settle deal");
    await sign.focus();
    await sign.press("Enter");
    await waitText(id(buyer, "notice"), "You declined in your wallet");
    assert.equal(await sign.evaluate((node) => document.activeElement === node), true);
    assert.equal(await w.usdc.read.balanceOf(w.buyer), buyerAmountBefore);
    await status(buyer, "funded");
    await shot(buyer, "08-signature-declined-focus-restored");
    await sign.click();
    await status(buyer, "settled");
    await capture(buyer, "immediateSettlement", "settled");
    const settlement = id(buyer, "receipt-settled");
    for (const address of [w.seller, w.buyer, w.broker, w.treasury, w.fam.address, w.usdc.address]) await waitText(settlement, address);
    for (const raw of ["100500000000", "99500000000", "200000000", "800000000"]) {
      await waitText(id(buyer, "receipt-fees"), `(${raw} raw)`);
    }
    await buyer.reload();
    await status(buyer, "settled");
    assert.equal(await id(buyer, "receipt-settled").getAttribute("data-tx"), recorded.receipts.immediateSettlement.transactionHash);
    await shot(buyer, "09-settlement-receipt-after-reload");

    const fixedStart = size === DESKTOP ? (await w.chain.now()) + 3600 : null;
    const startInput = fixedStart ? new Date(fixedStart * 1000).toISOString().slice(0, 19).replace("T", " ") : undefined;
    const vesting = await create(broker, { delivery: "1", quote: "123.456789", fixedStart: startInput, scene: "10-broker-review-vesting" });
    await fund(await tab(vesting, "seller"));
    const vestBuyer = await tab(vesting, "buyer");
    await status(vestBuyer, "funded");
    await shot(vestBuyer, "11-fresh-vesting-preview");
    await settle(vestBuyer);
    await capture(vestBuyer, "vestingSettlement", "settled");
    await waitText(id(vestBuyer, "vault-balance"), "900.000000000000000001 FAM");
    await waitText(id(vestBuyer, "claimable"), "0 FAM");
    await shot(vestBuyer, "12-vesting-backed-at-settlement");
    const { grantId } = w.brokerDeals.interface.parseLog(recorded.receipts.vestingSettlement.logs
      .find((log) => log.topics[0] === w.brokerDeals.interface.getEvent("BrokerDealSettled").topicHash)).args;
    const grant = await w.brokerDeals.read.getGrant(grantId);
    if (fixedStart) assert.equal(grant.start, BigInt(fixedStart), "UTC form input matches the onchain start");
    recorded.schedule = { mode: fixedStart ? "fixed UTC" : "settlement-relative", start: String(grant.start) };
    await w.at(grant.cliff);
    await vestBuyer.reload();
    await waitText(id(vestBuyer, "role"), "Buyer connected");
    const wrong = await tab(vesting, "other");
    await action(wrong, "Connect wallet").click();
    await waitText(id(wrong, "wrong-wallet"), "Select the named beneficiary wallet");
    assert.equal(await id(wrong, "claim").count(), 0);
    await id(vestBuyer, "claim").click();
    await id(vestBuyer, "claimed").filter({ hasNotText: /^0 FAM$/ }).waitFor();
    const cliffClaimed = (await w.brokerDeals.read.getGrant(grantId)).claimed;
    const displayedClaim = formatAmount(cliffClaimed, 18) + " FAM";
    await waitText(id(vestBuyer, "claimed"), displayedClaim);
    const claim = vestBuyer.getByText("Claimed " + displayedClaim, { exact: true });
    await claim.click();
    await capture(vestBuyer, "cliffClaim", "claimed");
    await shot(vestBuyer, "13-beneficiary-claim");
    await w.at(grant.end);
    await vestBuyer.reload();
    await waitText(id(vestBuyer, "role"), "Buyer connected");
    await id(vestBuyer, "claim").click();
    await waitText(id(vestBuyer, "vault-balance"), /^0 FAM$/);
    const claimReceipts = id(vestBuyer, "receipt-claimed");
    await claimReceipts.first().locator("..").locator("summary").click();
    await capture(vestBuyer, "finalClaim", "claimed");
    assert.notEqual(recorded.receipts.finalClaim.transactionHash, recorded.receipts.cliffClaim.transactionHash);
    await shot(vestBuyer, "14-fully-claimed");

    const refundLink = await create(broker, { quote: "123.456789", hours: "0.02" });
    const refundSeller = await tab(refundLink, "seller");
    await fund(refundSeller);
    const pending = await create(broker, { quote: "123.456789" });
    const expired = await create(broker, { quote: "123.456789", hours: "0.02" });
    await w.at((await w.chain.now()) + 85);
    await refundSeller.bringToFront();
    await status(refundSeller, "expired");
    await shot(refundSeller, "15-expired-seller-refund");
    await capture(refundSeller, "expiredFunding", "funded");
    const freshSellerBook = await tab("#/v3/deals", "seller");
    await action(freshSellerBook, "Connect wallet").click();
    const expiredFunding = id(freshSellerBook, "book-entry").and(freshSellerBook.locator("[data-status=expired]"));
    await expiredFunding.getByRole("link", { name: "Open deal and receipt" }).click();
    await status(freshSellerBook, "expired");
    assert.equal(await id(freshSellerBook, "receipt-funded").getAttribute("data-tx"), recorded.receipts.expiredFunding.transactionHash);
    await id(refundSeller, "refund").click();
    await status(refundSeller, "refunded");
    await capture(refundSeller, "refund", "refunded");
    const expiredPage = await tab(expired);
    await status(expiredPage, "expired");
    assert.equal(await id(expiredPage, "action").count(), 0);
    const fundedLink = await create(broker, { quote: "123.456789" });
    await fund(await tab(fundedLink, "seller"));
    await broker.goto(site.url + "/#/v3/deals");
    await action(broker, "Connect wallet").click();
    await waitText(id(broker, "book-status"), "6 deals");
    const entries = await id(broker, "book-entry").evaluateAll((rows) => rows.map((r) => [r.dataset.role, r.dataset.status]));
    assert.deepEqual(entries.map(([role]) => role), Array(6).fill("broker"));
    assert.deepEqual(entries.map(([, state]) => state).sort(), ["awaiting", "expired", "funded", "refunded", "settled", "settled"]);
    assert.ok(brokerAsked.every((request) => !["eth_signTypedData_v4", "eth_sendTransaction"].includes(request)), "broker never signed or sent transactions");
    await shot(broker, "16-broker-deal-book");
    const freshBook = await tab("#/v3/deals", "broker");
    await action(freshBook, "Connect wallet").click();
    await waitText(id(freshBook, "book-status"), "4 deals");
    await shot(freshBook, "17-broker-onchain-history-fresh-profile");
    const freshBuyerBook = await tab("#/v3/deals", "buyer");
    await action(freshBuyerBook, "Connect wallet").click();
    await waitText(id(freshBuyerBook, "book-status"), "4 deals");
    assert.deepEqual(await id(freshBuyerBook, "book-entry").evaluateAll((rows) => rows.map((row) => row.dataset.role)), Array(4).fill("buyer"));
    await id(broker, "stage-filter").selectOption("awaiting");
    const pendingRow = id(broker, "book-entry").filter({ hasText: "Awaiting funding" });
    await broker.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("Clipboard denied")) });
    });
    await pendingRow.getByRole("button", { name: "Copy deal link" }).click();
    const copyFallback = pendingRow.getByRole("textbox", { name: "Full deal link" });
    assert.equal(await copyFallback.inputValue(), site.url + "/" + pending);
    assert.equal(await copyFallback.evaluate((node) => document.activeElement === node), true);
    await pendingRow.getByRole("button", { name: "Duplicate terms" }).click();
    assert.equal(await id(broker, "quote").inputValue(), "123.456789");
    assert.equal(await id(broker, "seller").inputValue(), w.seller);
    await id(broker, "review").click();
    await id(broker, "create").click();
    assert.notEqual(await id(broker, "open-link").getAttribute("href"), pending);
    const otherBook = await tab("#/v3/deals", "other");
    await action(otherBook, "Connect wallet").click();
    await waitText(id(otherBook, "book-status"), "0 deals");
    assert.deepEqual(errors, [], "there were no uncaught browser errors");
    evidence.push(recorded);
    console.log(`${size.width}px · ${recorded.screenshots.length} screenshots and ${Object.keys(recorded.receipts).length} verified receipts`);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await site.close();
    await browser?.close();
  }
}
writeFileSync(join(target, "browser-proof.json"), JSON.stringify(evidence, null, 2) + "\n");
