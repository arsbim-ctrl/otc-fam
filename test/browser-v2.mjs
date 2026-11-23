import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHAIN_ID } from "../.launchpad/checks/round-1/chain.mjs";
import { serve, shows, until, wallet } from "../.launchpad/checks/round-1/page.mjs";
import { chromium } from "../.launchpad/checks/round-1/tools.mjs";
import { feeBreakdown } from "../web/eth-v2.js";
import { v2Link } from "../web/v2-ui.js";
import { ALLOCATION, DAY, QUOTE, STATUS, v2World } from "./v2-fixture.mjs";

const FILLED_CALL = "0x3fda5389";
const FUND_CALL = "0x54695758";
const screenHeight = 900;
const evidence = process.env.V2_EVIDENCE;
const states = (p, value) => shows(p, "deal-status", (s) => s === value, value, "data-status");
const text = (p, id, value) => shows(p, id, (s) => s === value, value);
const button = (p, name) => p.getByRole("button", { name, exact: typeof name === "string" });
const notice = (p, pattern) => p.getByTestId("notice").filter({ hasText: pattern }).waitFor();

async function capture(page, name) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true, animations: "disabled" });
}

async function browserFixture(width, exercise) {
  const w = await v2World();
  const site = await serve(w);
  const browser = await chromium.launch();
  const deployment = { chainId: CHAIN_ID, contract: w.v2.address };
  const pages = [];
  async function open(route, handler) {
    const context = await browser.newContext({ viewport: { width, height: screenHeight }, locale: "en-US", timezoneId: "Asia/Tokyo" });
    await context.route("**/config.json", (r) => r.fulfill({ json: {
      chainId: CHAIN_ID, contract: w.deals.address, rpcUrl: "/rpc", v2: deployment,
    } }));
    if (handler) {
      await context.exposeBinding("walletRequest", (_source, req) => handler(req));
      await context.addInitScript(() => {
        window.ethereum = {
          async request(req) {
            const { result, error } = await window.walletRequest(req);
            if (error) throw Object.assign(new Error(error.message), error);
            return result;
          },
        };
      });
    }
    const page = await context.newPage();
    pages.push({ page, errors: [] });
    page.on("pageerror", (error) => pages.find((p) => p.page === page).errors.push(error.message));
    await page.goto(`${site.url}/${route}`);
    return page;
  }
  try {
    await exercise({ w, open, deployment });
    for (const { errors } of pages) assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await site.close();
  }
}

async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page fits the viewport");
}

async function enterTerms(p, w, delivery) {
  await p.getByTestId("delivery").selectOption(delivery);
  for (const [id, value] of Object.entries({
    "base-token": w.base.address, "quote-token": w.usdc.address, allocation: "1000000",
    price: "123.456789", buyer: w.taker,
  })) await p.getByTestId(id).fill(value);
}

for (const width of [390, 1440]) for (const delivery of ["vesting", "immediate"]) {
  test(`${width}px fresh seller and buyer complete ${delivery} delivery`, { timeout: 75_000 }, () =>
    browserFixture(width, async ({ w, open, deployment }) => {
      const vesting = delivery === "vesting";
      const sellerWallet = wallet(w, w.maker);
      const sellerRequests = [];
      const seller = await open("#/v2/new", (r) => { sellerRequests.push(r.method); return sellerWallet(r); });
      await seller.getByTestId("delivery").selectOption("external");
      await notice(seller, /Existing vesting positions/);
      assert.equal(await seller.getByTestId("primary-action").count(), 0);
      assert.equal(sellerRequests.includes("eth_requestAccounts"), false);
      assert.equal(sellerRequests.includes("eth_sendTransaction"), false);

      await enterTerms(seller, w, delivery);
      const fixed = vesting && width === 390;
      const future = BigInt(await w.chain.now()) + 2n * DAY;
      if (fixed) {
        await seller.getByTestId("start-mode").selectOption("fixed");
        await seller.getByTestId("fixed-start").fill(new Date(Number(future) * 1000).toISOString().slice(0, 19));
      }
      await text(seller, "buyer-total", "124.074072 USDC");
      await text(seller, "seller-net", "122.839506 USDC");
      await text(seller, "buyer-fee", "0.617283 USDC");
      await text(seller, "seller-fee", "0.617283 USDC");
      await noOverflow(seller);
      if (vesting && width === 1440) await capture(seller, "seller-review-1440");
      await button(seller, "Connect seller wallet").click();
      await button(seller, "Approve 1,000,000 BASE").click();
      await button(seller, "Fund deal & get link").click();
      await states(seller, "funded");
      await button(seller, "Copy link").waitFor();
      assert.equal((await w.v2.read.getDeal(1n)).terms.fixedStart, fixed ? future : 0n);
      assert.equal(await w.base.read.balanceOf(w.v2.address), ALLOCATION);
      assert.equal(await w.base.read.balanceOf(w.maker), 0n);
      const link = new URL(seller.url()).hash;
      assert.equal(link, v2Link(deployment, 1n));

      const spectator = await open(link);
      await states(spectator, "funded");
      await text(spectator, "receive-amount", "1,000,000");
      await text(spectator, "fee-pool", "1.234566 USDC");
      await spectator.getByText("Funded", { exact: true }).last().waitFor();
      await noOverflow(spectator);
      if (vesting && width === 390) await capture(spectator, "funded-readonly-390");

      const wrong = await open(link, wallet(w, w.other));
      await button(wrong, "Connect wallet").click();
      await notice(wrong, /designated buyer wallet/);
      assert.equal(await wrong.getByTestId("primary-action").count(), 0);

      let chainId = "0x1", rejected = false, reverted = false;
      const answerBuyer = wallet(w, w.taker);
      const buyer = await open(link, async (r) => {
        if (r.method === "eth_chainId") return { result: chainId };
        if (r.method === "wallet_switchEthereumChain") {
          const result = await answerBuyer(r);
          if (!result.error) chainId = r.params[0].chainId;
          return result;
        }
        if (r.method === "eth_sendTransaction") {
          assert.equal(Number(chainId), CHAIN_ID);
          if (!rejected) {
            rejected = true;
            return { error: { code: 4001, message: "User rejected the request" } };
          }
          if (r.params[0].data.startsWith(FILLED_CALL) && !reverted) {
            reverted = true;
            return answerBuyer({ ...r, params: [{ ...r.params[0], gas: "0x7530" }] });
          }
        }
        return answerBuyer(r);
      });
      const before = await w.balances(w.usdc);
      await button(buyer, "Connect wallet").click();
      await button(buyer, "Switch to Local test chain").click();
      const approve = button(buyer, "Approve 124.074072 USDC");
      await approve.click();
      await notice(buyer, /declined in your wallet/);
      assert.deepEqual(await w.balances(w.usdc), before);
      await approve.click();
      const settle = button(buyer, "Settle & pay 124.074072 USDC");
      await settle.focus();
      await buyer.evaluate(() => window.dispatchEvent(new Event("focus")));
      await settle.press("Enter");
      await notice(buyer, /failed on the chain/);
      assert.equal((await w.v2.read.getDeal(1n)).status, STATUS.funded);
      assert.deepEqual(await w.balances(w.usdc), before);
      await settle.click();
      await states(buyer, "settled");
      const { buyerTotal, sellerNet, feePool } = feeBreakdown(QUOTE);
      assert.deepEqual((await w.balances(w.usdc)).map((value, i) => value - before[i]),
        [sellerNet, -buyerTotal, feePool, 0n, 0n]);
      if (!vesting) {
        assert.equal(await w.base.read.balanceOf(w.taker), 2n * ALLOCATION);
        assert.equal(await w.base.read.balanceOf(w.v2.address), 0n);
        assert.equal(await buyer.getByText("Vesting grant #1").count(), 0);
        if (width === 1440) await capture(buyer, "immediate-settled-1440");
        return;
      }

      const grant = await w.v2.read.getGrant(1n);
      assert.equal(grant.allocation, ALLOCATION);
      assert.equal(grant.beneficiary.toLowerCase(), w.taker);
      assert.equal(await w.base.read.balanceOf(w.v2.address), ALLOCATION);
      assert.equal(await w.base.read.balanceOf(w.taker), ALLOCATION);
      await w.warp(grant.start + 29n * DAY);
      await spectator.reload();
      await text(spectator, "claimable", "0 BASE");
      assert.match(await spectator.getByTestId("claim-availability").innerText(), /UTC/);
      await w.warp(grant.cliff);
      await buyer.reload();
      await text(buyer, "claimable", "333,333.333333333333333333 BASE");
      if (width === 390) await capture(buyer, "cliff-390");
      await w.chain.setNextTime(grant.cliff);
      await button(buyer, /^Claim /).click();
      await notice(buyer, /Claim confirmed/);
      const first = ALLOCATION / 3n;
      assert.equal((await w.v2.read.getGrant(1n)).claimed, first);
      await w.warp(grant.start + 45n * DAY);
      await buyer.reload();
      await text(buyer, "vested", "500,000 BASE");
      await text(buyer, "claimable", "166,666.666666666666666667 BASE");
      await w.warp(grant.end);
      await buyer.reload();
      await text(buyer, "locked", "0 BASE");
      await button(buyer, /^Claim /).click();
      await text(buyer, "claimed", "1,000,000 BASE");
      await buyer.reload();
      await text(buyer, "claim-availability", "All units have been claimed.");
      await until(async () => await buyer.locator(".v2-activity li").count() === 5, "funding, grant, settlement and both claim receipts");
      assert.equal(await w.base.read.balanceOf(w.v2.address), 0n);
      assert.equal(await w.base.read.balanceOf(w.taker), 2n * ALLOCATION);
      if (width === 1440) await capture(buyer, "fully-claimed-1440");
    }));
}

test("a wallet cancellation releases the form and a repriced funding receipt survives reload", { timeout: 75_000 }, () =>
  browserFixture(390, async ({ w, open }) => {
    const answer = wallet(w, w.maker);
    let original;
    const seller = await open("#/v2/new", async (r) => {
      if (r.method !== "eth_sendTransaction" || !r.params[0].data.startsWith(FUND_CALL)) return answer(r);
      await w.chain.rpc("evm_setAutomine", [false]);
      const tx = { ...r.params[0], gas: "0x100000", gasPrice: "0x77359400" };
      const result = await answer({ ...r, params: [tx] });
      original = await w.chain.rpc("eth_getTransactionByHash", [result.result]);
      return result;
    });
    const fund = button(seller, "Fund deal & get link");
    const tracked = () => seller.waitForFunction(() => Object.values(sessionStorage).some(
      (value) => value.startsWith("{") && typeof JSON.parse(value).nonce === "string",
    ));
    async function replace(tx) {
      const hash = await w.chain.submit(w.maker, { ...tx, nonce: original.nonce, gas: "0x100000", gasPrice: "0xee6b2800" });
      await w.chain.mine();
      await w.chain.rpc("evm_setAutomine", [true]);
      assert.equal((await w.chain.rpc("eth_getTransactionReceipt", [hash])).status, "0x1");
      return hash;
    }
    await enterTerms(seller, w, "vesting");
    await button(seller, "Connect seller wallet").click();
    await button(seller, "Approve 1,000,000 BASE").click();
    await fund.click();
    await tracked();
    await replace({ to: w.maker, value: "0x0" });
    await notice(seller, /replaced or cancelled/);
    assert.equal(await w.base.read.balanceOf(w.v2.address), 0n);

    await fund.click();
    await tracked();
    await seller.reload();
    const check = button(seller, "Check transaction");
    await check.waitFor();
    const minedHash = await replace({ to: original.to, data: original.input });
    await check.click();
    await states(seller, "funded");
    await seller.getByText(minedHash, { exact: true }).waitFor();
    assert.equal(await w.base.read.balanceOf(w.v2.address), ALLOCATION);
    assert.equal((await w.v2.read.getDeal(2n)).status, 0n, "retry funded exactly one deal");
  }));

test("a passive vesting update keeps keyboard focus on the claim control", { timeout: 45_000 }, () =>
  browserFixture(390, async ({ w, open, deployment }) => {
    await w.base.as(w.maker).approve(w.v2.address, ALLOCATION);
    await w.v2.as(w.maker).createDeal(await w.termsV2());
    await w.usdc.as(w.taker).approve(w.v2.address, feeBreakdown(QUOTE).buyerTotal);
    await w.v2.as(w.taker).fill(1n);
    const grant = await w.v2.read.getGrant(1n);
    const answer = wallet(w, w.taker);
    await answer({ method: "eth_requestAccounts" });
    const page = await open(v2Link(deployment, 1n), answer);
    const claim = button(page, /^Claim /);

    await text(page, "claimable", "0 BASE");
    assert.equal(await claim.count(), 0);

    await w.warp(grant.cliff);
    await text(page, "claimable", "333,333.333333333333333333 BASE");
    const control = await claim.elementHandle();
    for (let i = 0; i < 5 && !await control.evaluate((node) => node === document.activeElement); i++) {
      await page.keyboard.press("Tab");
    }
    assert.equal(await control.evaluate((node) => node === document.activeElement), true, "Tab reaches the claim button");
    assert.equal(await claim.isEnabled(), true);

    const midpoint = grant.start + 45n * DAY;
    await w.warp(midpoint);
    await text(page, "claimable", "500,000 BASE");
    assert.equal(await control.evaluate((node) => node.isConnected && node === document.activeElement), true,
      "the same native button keeps focus through the polling update");
    assert.equal(await claim.isEnabled(), true);

    await w.chain.setNextTime(midpoint);
    await page.keyboard.press("Enter");
    await notice(page, /Claim confirmed/);
    await text(page, "claimable", "0 BASE");
    assert.equal(await claim.count(), 0, "no claim action remains when the available units are paid");
    assert.equal((await w.v2.read.getGrant(1n)).claimed, ALLOCATION / 2n);
  }));

test("a seller can recheck balance after a same-account top-up and keep the draft", { timeout: 45_000 }, () =>
  browserFixture(1440, async ({ w, open }) => {
    const topUp = ALLOCATION / 10n;
    await w.base.as(w.maker).transfer(w.other, topUp);
    const answer = wallet(w, w.maker);
    const walletRequests = [];
    const page = await open("#/v2/new", (request) => {
      walletRequests.push(request.method);
      return answer(request);
    });
    await enterTerms(page, w, "vesting");
    await page.getByTestId("cliff").fill("17");
    await page.getByTestId("duration").fill("72");
    await button(page, "Connect seller wallet").click();
    const lowBalance = /holds 900,000 BASE/;
    await notice(page, lowBalance);
    assert.equal(await button(page, /^Approve |^Fund deal/).count(), 0);

    const requestsBefore = [...walletRequests];
    const recheck = button(page, "Recheck balance");
    await recheck.click({ timeout: 3000 });
    await notice(page, lowBalance);
    assert.equal(await button(page, /^Approve |^Fund deal/).count(), 0);

    await w.base.as(w.other).transfer(w.maker, topUp);
    await recheck.click();
    const approve = button(page, "Approve 1,000,000 BASE");
    await approve.waitFor();
    assert.deepEqual(walletRequests, requestsBefore, "balance rechecks use only the read-only RPC");
    for (const [id, value] of Object.entries({
      delivery: "vesting", "base-token": w.base.address, allocation: "1000000", "quote-token": w.usdc.address,
      price: "123.456789", buyer: w.taker, cliff: "17", duration: "72",
    })) assert.equal(await page.getByTestId(id).inputValue(), value);

    await approve.click();
    await button(page, "Fund deal & get link").click();
    await states(page, "funded");
    const { terms, seller } = await w.v2.read.getDeal(1n);
    assert.equal(seller.toLowerCase(), w.maker);
    assert.equal(terms.cliffSeconds, 17n * DAY);
    assert.equal(terms.durationSeconds, 72n * DAY);
    assert.equal(await w.base.read.balanceOf(w.v2.address), ALLOCATION);
  }));
