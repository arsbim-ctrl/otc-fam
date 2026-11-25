import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Interface, TypedDataEncoder, getAddress } from "ethers";
import { checkSettlementText, receiptEvent, rpc } from "./lib/broker-receipts.mjs";
import { chromium } from "playwright";

const evidence = process.env.OTC_V3_EVIDENCE;
const token = new Interface(["function balanceOf(address) view returns (uint256)"]);
const quoteRaw = 123_456_789n, baseRaw = 1_000_000n * 10n ** 18n, fee = 617_283n;
const day = 86_400;

async function start() {
  const dev = spawn(process.execPath, ["scripts/dev.mjs", "--broker"], {
    env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"],
  });
  const output = await new Promise((resolve, reject) => {
    let lines = "";
    dev.stdout.on("data", (chunk) => { if ((lines += chunk).includes("Ctrl-C")) resolve(lines); });
    dev.once("exit", (code) => reject(new Error("Local demo exited with " + code)));
  });
  const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(output)[0];
  const participants = Object.fromEntries(["Seller", "Buyer", "Broker", "Stranger", "Treasury", "FAM", "USDC"].map((name) =>
    [name, new RegExp("^" + name + "\\s+(0x[0-9a-fA-F]{40})", "m").exec(output)[1]]));
  const config = await fetch(url + "config.json").then((response) => response.json());
  return { dev, url, ...participants, contract: config.contractV3, chainId: config.chainId };
}

async function open(browser, width, account, url, before) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "UTC" });
  await context.addInitScript((selected) => {
    if (sessionStorage.getItem("dev-account") === null) sessionStorage.setItem("dev-account", selected);
  }, account);
  const page = await context.newPage();
  page.setDefaultTimeout(9000);
  await before?.(page);
  await page.goto(url);
  return page;
}

function button(page, name) {
  return page.getByRole("button", { name, exact: typeof name === "string" });
}

async function connectHistory(page) {
  const connect = button(page, "Connect broker wallet");
  await connect.or(page.getByTestId("v3-history")).or(page.getByText("No broker deals for this wallet.")).first().waitFor();
  if (await connect.isVisible()) await connect.click();
}

async function state(page, expected) {
  await page.getByTestId("v3-status").getByText(expected, { exact: true }).waitFor();
}

async function capture(page, width, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal scrolling");
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, width + "-" + name + ".png"), fullPage: true });
}

async function balances(w) {
  const people = [w.Seller, w.Buyer, w.Broker, w.Treasury, w.contract];
  return Promise.all([w.FAM, w.USDC].map((address) => Promise.all(people.map(async (who) => {
    const data = token.encodeFunctionData("balanceOf", [who]);
    return BigInt(await rpc(w, "eth_call", [{ to: address, data }, "latest"]));
  }))));
}

const deltas = (a, b) => b.map((row, i) => row.map((n, j) => n - a[i][j]));

function walletRecovery(page) {
  let connected = false, wrongChain = true, rejected = false;
  return page.route("**/dev/wallet", async (route) => {
    const { request } = route.request().postDataJSON();
    if (request.method === "eth_accounts" && !connected) return route.fulfill({ json: { result: [] } });
    if (request.method === "eth_requestAccounts") connected = true;
    if (request.method === "eth_chainId" && wrongChain) return route.fulfill({ json: { result: "0x1" } });
    if (request.method === "wallet_switchEthereumChain") wrongChain = false;
    if (request.method === "eth_signTypedData_v4" && !rejected) {
      rejected = true;
      return route.fulfill({ json: { error: { code: 4001, message: "Rejected" } } });
    }
    return route.continue();
  });
}

async function prepare(broker, w, vesting, seconds = "90", brokerBps = "2000") {
  await broker.goto(w.url + "#/");
  await broker.goto(w.url + "#/v3/new");
  await broker.locator("#v3-mode").selectOption(vesting ? "1" : "0");
  if (vesting) await broker.getByTestId("v3-durationSeconds").fill(seconds);
  for (const [key, value] of Object.entries({
    seller: w.Seller, buyer: w.Buyer, broker: w.Broker, baseToken: w.FAM, quoteToken: w.USDC,
    allocation: "1000000", quote: "123.456789", brokerBps,
  })) {
    await broker.getByTestId("v3-" + key).fill(value);
  }
  await button(broker, "Preview terms").click();
  try {
    await broker.getByText("124.074072 USDC", { exact: true }).waitFor();
  } catch (error) {
    const reason = await broker.getByTestId("notice").first().textContent({ timeout: 300 }).catch(() => "");
    throw new Error("Preview failed. " + reason, { cause: error });
  }
  await button(broker, "Create shareable link").click();
  await broker.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: w.url });
  await button(broker, "Copy link").focus();
  await broker.keyboard.press("Enter");
  await button(broker, "Link copied").waitFor();
  assert.equal(await button(broker, "Link copied").evaluate((element) => element === document.activeElement), true);
  const copied = await broker.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, await broker.getByTestId("v3-link").getAttribute("href"));
  return copied;
}

function signedPayload(page) {
  return page.waitForRequest((request) => request.url().endsWith("/dev/wallet")
    && request.postDataJSON()?.request.method === "eth_signTypedData_v4").then((request) => {
    const [actor, data] = request.postDataJSON().request.params;
    return { actor: getAddress(actor), ...JSON.parse(data) };
  });
}

async function reviewSignature(page, w, terms) {
  const data = (name) => page.getByText(name, { exact: true }).and(page.locator("dt")).first()
    .locator("xpath=following-sibling::dd").innerText();
  assert.match(await data("Signing domain"), new RegExp(" · chain " + w.chainId + "$"));
  assert.equal(getAddress(await data("Verifying contract")), getAddress(w.contract));
  assert.equal(await data("Allocation in base units"), baseRaw.toString());
  assert.equal(await data("Quote in base units"), quoteRaw.toString());
  assert.equal(getAddress(await data("Payment token contract")), getAddress(w.USDC));
  if (terms) assert.equal(await data("Signed deal ID"), terms);
  return data("Signed deal ID");
}

async function demo(browser, w, broker, width, vesting) {
  const before = await balances(w);
  const kind = vesting ? "vesting" : "immediate";
  const url = await prepare(broker, w, vesting);
  await capture(broker, width, kind + "-prepare");

  const viewer = await open(browser, width, "none", url);
  await state(viewer, "Awaiting funding");
  assert.equal(await button(viewer, "Sign and settle").count(), 0);
  await capture(viewer, width, kind + "-unfunded");

  const seller = await open(browser, width, w.Seller, url);
  await state(seller, "Awaiting funding");
  if (await button(seller, "Connect wallet").isVisible()) await button(seller, "Connect wallet").click();
  await button(seller, "Approve 1,000,000 FAM").click();
  const reviewedId = await reviewSignature(seller, w);
  const sellerSigning = signedPayload(seller);
  await button(seller, "Sign and fund").click();
  const signed = await sellerSigning;
  assert.equal(signed.actor, getAddress(w.Seller));
  assert.equal(Number(signed.domain.chainId), w.chainId);
  assert.equal(getAddress(signed.domain.verifyingContract), getAddress(w.contract));
  assert.equal(TypedDataEncoder.hash(signed.domain, { BrokerTerms: signed.types.BrokerTerms }, signed.message), reviewedId);
  await state(seller, "Funded");
  const escrow = await balances(w);
  assert.deepEqual(deltas(before, escrow), [[-baseRaw, 0n, 0n, 0n, baseRaw], [0n, 0n, 0n, 0n, 0n]]);
  const deal = await seller.getByTestId("v3-deal-id").innerText();
  assert.equal(deal, reviewedId);
  const funded = await receiptEvent(seller, w, "Funded", "BrokerDealFunded");
  const funding = funded.hash;
  assert.equal(funded.args.dealId, deal);
  assert.equal(funded.args.seller, getAddress(w.Seller));
  assert.equal(funded.args.broker, getAddress(w.Broker));

  await viewer.reload();
  await state(viewer, "Funded");
  await capture(viewer, width, kind + "-funded");
  const stranger = await open(browser, width, w.Stranger, url);
  await state(stranger, "Funded");
  if (await button(stranger, "Connect wallet").isVisible()) await button(stranger, "Connect wallet").click();
  await stranger.getByText(/Only the named seller or buyer can act/).waitFor();
  assert.equal(await button(stranger, "Sign and settle").count(), 0);
  await stranger.close();

  const buyer = await open(browser, width, w.Buyer, url, walletRecovery);
  await state(buyer, "Funded");
  await reviewSignature(buyer, w, deal);
  assert.equal(await button(buyer, "Sign and settle").count(), 0);
  await button(buyer, "Connect wallet").click();
  await button(buyer, "Switch to Local test chain").click();
  await button(buyer, "Approve 124.074072 USDC").click();
  await button(buyer, "Sign and settle").click();
  await buyer.getByTestId("notice").getByText(/declined/i).waitFor();
  assert.deepEqual(await balances(w), escrow);
  await reviewSignature(buyer, w, deal);
  const buyerSigning = signedPayload(buyer);
  await button(buyer, "Sign and settle").click();
  const confirmed = await buyerSigning;
  assert.equal(confirmed.actor, getAddress(w.Buyer));
  assert.deepEqual(confirmed.domain, signed.domain);
  assert.deepEqual(confirmed.message, signed.message);
  assert.deepEqual(confirmed.types, signed.types);
  await state(buyer, "Settled");
  await buyer.reload();
  await state(buyer, "Settled");
  const settled = await receiptEvent(buyer, w, "Settled", "BrokerDealSettled");
  const settlement = settled.hash;
  assert.equal(settled.args.dealId, deal);
  assert.equal(settled.args.buyer, getAddress(w.Buyer));
  assert.equal(settled.args.grantId, vesting ? 1n : 0n);
  checkSettlementText(await settled.row.innerText(), settled.args, quoteRaw, "1,000,000 FAM");
  assert.match(deal, /^0x[0-9a-f]{64}$/);
  assert.match(funding, /^0x[0-9a-f]{64}$/);
  assert.match(settlement, /^0x[0-9a-f]{64}$/);
  const after = await balances(w);
  assert.deepEqual(deltas(escrow, after), [
    [0n, vesting ? 0n : baseRaw, 0n, 0n, -baseRaw],
    [quoteRaw - fee, -(quoteRaw + fee), 246_913n, 987_653n, 0n],
  ]);
  await capture(buyer, width, kind + "-settled");
  let claim = null;
  if (vesting) {
    await buyer.getByRole("heading", { name: "Vesting grant #1" }).waitFor();
    await fetch(w.url + "dev/time", { method: "POST", body: JSON.stringify({ seconds: day }) });
    await buyer.reload();
    await button(buyer, "Claim vested tokens").click();
    const claimed = await receiptEvent(buyer, w, "Claimed", "BrokerGrantClaimed");
    claim = claimed.hash;
    assert.equal(claimed.args.grantId, settled.args.grantId);
    assert.equal(claimed.args.beneficiary, getAddress(w.Buyer));
    assert.equal(claimed.args.amount, baseRaw);
    assert.deepEqual(deltas(after, await balances(w)), [[0n, baseRaw, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n]]);
    await capture(buyer, width, kind + "-claimed");
  }
  await Promise.all([seller.close(), buyer.close(), viewer.close()]);
  return { width, kind, deal, funding, settlement, claim,
    settlementDelta: Object.fromEntries(["FAM", "USDC"].map((asset, i) => [asset,
      Object.fromEntries(["seller", "buyer", "broker", "treasury", "escrow"].map((role, j) =>
        [role, (after[i][j] - escrow[i][j]).toString()]))])),
  };
}

for (const width of [390, 1440]) {
  test("V3 broker, seller and buyer complete both modes at " + width + "px", { timeout: 90_000 }, async () => {
    const w = await start();
    const browser = await chromium.launch();
    try {
      const broker = await open(browser, width, w.Broker, w.url);
      const ids = [];
      for (const kind of [false, true]) ids.push(await demo(browser, w, broker, width, kind));
      const recovered = await open(browser, width, w.Broker, w.url + "#/v3/history");
      await connectHistory(recovered);
      for (const entry of ids) {
        const item = recovered.getByTestId("v3-history").locator("li").filter({ hasText: entry.settlement });
        await item.getByText("Broker earned 0.246913 USDC", { exact: true }).waitFor();
      }
      await recovered.close();
      const refundUrl = await prepare(broker, w, false);
      const refundSeller = await open(browser, width, w.Seller, refundUrl);
      await state(refundSeller, "Awaiting funding");
      if (await button(refundSeller, "Connect wallet").isVisible()) await button(refundSeller, "Connect wallet").click();
      const beforeRefundDeal = await balances(w);
      await button(refundSeller, "Approve 1,000,000 FAM").click();
      await button(refundSeller, "Sign and fund").click();
      await state(refundSeller, "Funded");
      const refundId = await refundSeller.getByTestId("v3-deal-id").innerText();
      const refundFunding = await receiptEvent(refundSeller, w, "Funded", "BrokerDealFunded");
      const awaiting = await prepare(broker, w, false, "90", "0");
      await broker.goto(w.url + "#/v3/history");
      await connectHistory(broker);
      await broker.getByTestId("v3-history").getByText(/Awaiting funding/).waitFor();
      assert.equal(await broker.getByTestId("v3-history").locator("li > strong").filter({ hasText: /Settled/ }).count(), 2);
      await broker.getByTestId("v3-history").getByText(refundFunding.hash, { exact: true }).waitFor();
      await capture(broker, width, "broker-history");
      await broker.getByRole("link", { name: "Duplicate", exact: true }).first().click();
      await broker.getByTestId("v3-seller").waitFor();
      assert.equal((await broker.getByTestId("v3-seller").inputValue()).toLowerCase(), w.Seller.toLowerCase());
      await broker.goto(w.url + "#/v3/history");
      await Promise.all([broker.waitForEvent("load"), broker.selectOption("#dev-account", w.Stranger)]);
      await connectHistory(broker);
      await broker.getByText("No broker deals for this wallet.").waitFor();
      await fetch(w.url + "dev/time", { method: "POST", body: JSON.stringify({ seconds: 2 * day }) });
      const expired = await open(browser, width, "none", awaiting);
      await state(expired, "Expired");
      assert.equal(await button(expired, "Sign and settle").count(), 0);
      await refundSeller.reload();
      await state(refundSeller, "Expired");
      if (await button(refundSeller, "Connect wallet").isVisible()) await button(refundSeller, "Connect wallet").click();
      await button(refundSeller, "Refund allocation").click();
      await state(refundSeller, "Refunded");
      const refund = await receiptEvent(refundSeller, w, "Refunded", "BrokerDealRefunded");
      assert.equal(refund.args.dealId, refundId);
      assert.deepEqual(await balances(w), beforeRefundDeal);
      const refundHistory = await open(browser, width, w.Broker, w.url + "#/v3/history");
      await connectHistory(refundHistory);
      await refundHistory.locator("li").filter({ hasText: refund.hash }).getByText("Refunded · no fee paid").waitFor();
      await capture(refundSeller, width, "refunded");
      ids.push({ width, kind: "expired-refund", deal: refundId, funding: refundFunding.hash, refund: refund.hash });
      if (evidence) writeFileSync(join(evidence, width + "-receipts.json"), JSON.stringify(ids, null, 2) + "\n");
      console.log(JSON.stringify(ids));
    } finally {
      await browser.close();
      w.dev.kill();
    }
  });
}
