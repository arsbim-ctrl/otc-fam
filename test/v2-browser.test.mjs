import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, expect } from "playwright/test";
import { CHAIN_ID } from "../.launchpad/checks/round-1/chain.mjs";
import { formatAmount } from "../web/units.js";
import { fees, SELECTORS } from "../web/v2-chain.js";
import { actors, ALLOCATION, DAY, QUOTE, serveV2, v2World } from "./support/v2-site.mjs";

const output = process.env.OTC_SCREENSHOTS;
const payment = fees(QUOTE);
const formatted = (n) => `${formatAmount(n, 18)} ALFA`;

async function screen(page, name) {
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true, animations: "disabled" });
}

async function open(browser, site, world, width, url, actor, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, timezoneId: "UTC" });
  if (actor) {
    let connected = false;
    let network = options.wrongNetwork ? "0x1" : `0x${CHAIN_ID.toString(16)}`;
    await context.exposeBinding("callFixtureWallet", async (_source, { method, params }) => {
      if (method === "eth_accounts") return { result: connected ? [actor] : [] };
      if (method === "eth_requestAccounts") {
        connected = true;
        return { result: [actor] };
      }
      if (method === "eth_chainId") return { result: network };
      if (method === "wallet_switchEthereumChain") {
        network = params[0].chainId;
        return { result: null };
      }
      if (method === "eth_sendTransaction" && connected && params[0].from === actor && Number(network) === CHAIN_ID) {
        const handled = await options.onSend?.(params[0]);
        if (handled) return handled;
        return { result: await world.chain.submit(actor, params[0]) };
      }
      return { error: { code: 4100, message: "Wallet request not available" } };
    });
    await context.addInitScript(() => {
      window.ethereum = { async request(request) {
        const { result, error } = await window.callFixtureWallet(request);
        if (error) throw Object.assign(new Error(error.message), { code: error.code });
        return result;
      } };
    });
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => { throw error; });
  await page.goto(`${site.url}/${url}`);
  return { context, page };
}

const primary = (page) => page.getByTestId("primary-action");
const press = async (page, label) => {
  await expect(primary(page)).toHaveText(label);
  await primary(page).click();
};
const status = (page, value) => expect(page.getByTestId("deal-status")).toHaveAttribute("data-status", value);
const delta = (before, after) => after.map((balance, index) => balance - before[index]);
const balances = ({ base, quote, deals }) => Promise.all([base, quote].map((token) =>
  Promise.all([actors.seller, actors.buyer, actors.treasury, deals.address].map((owner) => token.read.balanceOf(owner)))));
const assertLayout = async (page) => {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const buttons = page.locator("button:visible:enabled");
  if (await buttons.count()) {
    await buttons.first().focus();
    assert.equal(await buttons.first().evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
  }
};

async function makeDeal(page, world, kind) {
  await page.getByTestId("delivery-mode").selectOption(kind);
  for (const [id, value] of [
    ["base-token", world.base.address], ["allocation", "1000000"], ["quote-token", world.quote.address],
    ["quote", "123.456789"], ["buyer", actors.buyer],
  ]) await page.getByTestId(id).fill(value);
  await expect(page.getByText("124.074072 USDC", { exact: true })).toBeVisible();
  await expect(page.getByText("0.617283 USDC", { exact: true })).toHaveCount(2);
}

for (const [width, kind] of [[390, "vesting"], [1440, "vesting"], [390, "immediate"], [1440, "immediate"]]) {
  test(`${kind} seller and fresh buyer at ${width}px`, { timeout: 90_000 }, async () => {
    const world = await v2World();
    const site = await serveV2(world);
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const { chain, base, deals, quote } = world;
    const vesting = kind === "vesting";
    const recover = vesting && width === 390;
    const replace = !vesting && width === 1440;
    let rejects = recover, reverts = recover, writes = 0, original, replacementHash, originalIndexed = false;
    const publicRpc = chain.publicRpc;
    chain.publicRpc = (request) => {
      if (original && request.method === "eth_getTransactionByHash" && request.params[0] === original) originalIndexed = true;
      return publicRpc(request);
    };
    try {
      const { page: seller, context: sellerContext } = await open(browser, site, world, width, "#/v2/new", actors.seller, {
        onSend() { writes++; },
      });
      if (recover) {
        await seller.getByTestId("delivery-mode").selectOption("external");
        await expect(seller.getByTestId("unsupported-position")).toContainText("Sablier positions");
        await expect(primary(seller)).toBeDisabled();
        assert.equal(writes, 0);
        await screen(seller, "390-unsupported");
      }
      await makeDeal(seller, world, kind);
      const fixedStart = vesting && width === 1440 ? (await chain.now()) + 3600 : 0;
      if (fixedStart) {
        await seller.getByTestId("start-mode").selectOption("fixed");
        await seller.getByTestId("fixed-start").fill(new Date(fixedStart * 1000).toISOString().slice(0, 19));
        await expect(seller.getByText("Start (UTC)", { exact: true })).toBeVisible();
      }
      const before = await balances(world);
      await assertLayout(seller);
      if (vesting) await screen(seller, `${width}-seller-review`);
      await press(seller, "Connect wallet");
      await press(seller, "Approve 1,000,000 ALFA");
      await press(seller, "Fund and create link");
      await expect(seller.getByTestId("deal-link")).toBeVisible();
      assert.equal((await seller.getByTestId("deal-link").getAttribute("href")), `${site.url}/${world.route(1)}`);
      assert.equal(writes, 2);
      assert.equal(await base.read.balanceOf(deals.address), ALLOCATION);
      assert.deepEqual((await balances(world))[1], before[1]);
      await seller.reload();
      await expect(seller.getByTestId("deal-link")).toBeVisible();
      await sellerContext.close();

      const { page: spectator, context: spectatorContext } = await open(browser, site, world, width, world.route(1));
      await status(spectator, "funded");
      await expect(spectator.getByTestId("deal-summary")).toContainText("full allocation is in escrow");
      await expect(spectator.getByText("Deal funded", { exact: true })).toBeVisible();
      await expect(primary(spectator)).toBeHidden();
      await assertLayout(spectator);
      if (vesting && width === 1440) await screen(spectator, "1440-fresh-buyer");
      await spectatorContext.close();

      if (recover) {
        const { page: stranger, context: strangerContext } = await open(browser, site, world, width, world.route(1), actors.other);
        await press(stranger, "Connect wallet");
        await expect(stranger.getByText("This wallet cannot settle.", { exact: false })).toBeVisible();
        await expect(primary(stranger)).toBeHidden();
        await strangerContext.close();
      }
      const { page: buyer } = await open(browser, site, world, width, world.route(1), actors.buyer, {
        wrongNetwork: recover,
        onSend: async (tx) => {
          if (rejects) {
            rejects = false;
            return { error: { code: 4001, message: "Declined" } };
          }
          if (replace && tx.data.startsWith(SELECTORS.fill)) {
            await chain.rpc("evm_setAutomine", [false]);
            original = await chain.submit(actors.buyer, { ...tx, gas: "0x2dc6c0", gasPrice: "0x77359400" });
            return { result: original };
          }
          if (reverts && tx.data.startsWith(SELECTORS.fill)) {
            reverts = false;
            return { result: await chain.submit(actors.buyer, { ...tx, gas: "0x7530" }) };
          }
          return null;
        },
      });
      await press(buyer, "Connect wallet");
      if (recover) await press(buyer, "Switch to Local test chain");
      await press(buyer, "Approve 124.074072 USDC");
      if (recover) {
        await expect(buyer.getByTestId("notice")).toContainText("You declined in your wallet");
        assert.equal(await quote.read.allowance(actors.buyer, deals.address), 0n);
        await press(buyer, "Approve 124.074072 USDC");
      }
      await expect(primary(buyer)).toHaveText("Settle · pay 124.074072 USDC");
      if (recover) {
        await primary(buyer).focus();
        await buyer.waitForTimeout(4300);
        await expect(primary(buyer)).toBeFocused();
      }
      await press(buyer, "Settle · pay 124.074072 USDC");
      if (recover) {
        await expect(buyer.getByTestId("notice")).toContainText("The transaction reverted");
        await status(buyer, "funded");
        assert.deepEqual((await balances(world))[1], before[1]);
        assert.equal(await base.read.balanceOf(deals.address), ALLOCATION);
        await screen(buyer, "390-reverted-settlement");
        await buyer.reload();
        await status(buyer, "funded");
        await press(buyer, "Settle · pay 124.074072 USDC");
      }
      if (replace) {
        await expect.poll(() => originalIndexed).toBe(true);
        const tx = await chain.rpc("eth_getTransactionByHash", [original]);
        replacementHash = await chain.submit(actors.buyer, {
          to: tx.to, data: tx.input, nonce: tx.nonce, gas: tx.gas, gasPrice: "0xee6b2800",
        });
        assert.notEqual(replacementHash, original);
        await chain.mine();
        await chain.rpc("evm_setAutomine", [true]);
        await expect(buyer.getByTestId("notice")).toContainText("Your wallet changed the transaction hash");
      }
      await status(buyer, "settled");
      await expect(buyer.getByText("Deal settled", { exact: true })).toBeVisible();
      assert.deepEqual(delta(before[1], (await balances(world))[1]), [payment.sellerNet, -payment.buyerTotal, payment.pool, 0n]);
      assert.equal(await base.read.balanceOf(deals.address), 0n);
      if (!vesting) {
        assert.equal(await base.read.balanceOf(actors.buyer), ALLOCATION);
        await expect(buyer.getByTestId("deal-summary")).toContainText("delivered directly");
        await expect(buyer.getByRole("heading", { name: /Vesting grant/ })).toHaveCount(0);
        if (width === 1440) await screen(buyer, "1440-immediate-settled");
        return;
      }

      const grant = await deals.read.getGrant(1n);
      assert.equal(await base.read.balanceOf(grant.custodian), ALLOCATION);
      assert.equal(await base.read.balanceOf(actors.buyer), 0n);
      assert.equal(grant.beneficiary.toLowerCase(), actors.buyer);
      if (fixedStart) assert.equal(grant.start, BigInt(fixedStart));
      const warp = async (time) => {
        await chain.setNextTime(Number(time));
        await chain.mine();
        await buyer.reload();
      };
      await warp(grant.start + 29n * BigInt(DAY));
      await expect(buyer.getByTestId("claimable")).toHaveText("0 ALFA");
      await expect(buyer.getByText("The next raw unit becomes claimable at", { exact: false })).toBeVisible();
      await expect(primary(buyer)).toBeHidden();
      if (recover) await screen(buyer, "390-day-29");

      await warp(grant.cliff);
      const cliff = ALLOCATION / 3n;
      await expect(buyer.getByTestId("claimable")).toHaveText(formatted(cliff));
      if (!recover) await screen(buyer, "1440-cliff");
      await press(buyer, `Claim ${formatted(cliff)}`);
      await expect(buyer.getByTestId("claimable")).toHaveText("0 ALFA");
      assert.equal(await base.read.balanceOf(actors.buyer), cliff);
      assert.equal(await base.read.balanceOf(grant.custodian), ALLOCATION - cliff);
      await expect(buyer.getByText(`Grant claimed · ${formatted(cliff)}`, { exact: true })).toBeVisible();

      await warp(grant.start + 45n * BigInt(DAY));
      await expect(buyer.getByTestId("claimable")).toHaveText(formatted(ALLOCATION / 2n - cliff));
      if (recover) await screen(buyer, "390-day-45");

      await warp(grant.end);
      await press(buyer, `Claim ${formatted(ALLOCATION - cliff)}`);
      await expect(buyer.getByText("The full allocation has been claimed.")).toBeVisible();
      await expect(buyer.getByText(`Grant claimed · ${formatted(ALLOCATION - cliff)}`, { exact: true })).toBeVisible();
      assert.equal(await base.read.balanceOf(actors.buyer), ALLOCATION);
      assert.equal(await base.read.balanceOf(grant.custodian), 0n);
      assert.deepEqual(delta(before[1], (await balances(world))[1]), [payment.sellerNet, -payment.buyerTotal, payment.pool, 0n]);
      if (!recover) await screen(buyer, "1440-final-claim");
    } finally {
      await browser.close();
      await site.close();
    }
  });
}
