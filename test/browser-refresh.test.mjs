import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder } from "ethers";
import { chromium, expect } from "playwright/test";
import { contractAt } from "../.launchpad/checks/round-1/chain.mjs";
import { OTC_DEALS } from "../.launchpad/checks/round-1/world.mjs";
import { fees, SELECTORS } from "../web/v2-chain.js";
import { actors, ALLOCATION, QUOTE, serveV2, v2World } from "./support/v2-site.mjs";

const { buyer, seller, other } = actors;
const rawText = `fixture-internal: eth_call address=${other} params=[123] stack=debug.js:92`;
const rpcError = (request, data) => ({
  jsonrpc: "2.0", id: request.id, error: { code: -32000, message: rawText, data },
});
const button = (page) => page.getByTestId("primary-action");

async function withSite(t, fn) {
  const world = await v2World();
  const site = await serveV2(world);
  t.after(() => site.close());
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  t.after(() => browser.close());
  await fn({ world, site, browser });
}

async function open({ site, browser, world }, path, { account, draft, send } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (account) {
    await context.exposeBinding("fixtureReadWallet", (_source, { method, params }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return `0x${world.config.chainId.toString(16)}`;
      if (method === "eth_sendTransaction") return send(params[0]);
      throw Error("Unexpected fixture wallet request");
    });
    await context.exposeBinding("fixtureWriteAccount", (_source, next) => { account = next; });
    await context.addInitScript(() => {
      let update;
      window.ethereum = {
        on(event, listener) {
          if (event === "accountsChanged") update = listener;
        },
        async request(request) {
          const response = await window.fixtureReadWallet(request);
          if (response?.error) throw Object.assign(new Error(response.error.message), response.error);
          return response;
        },
      };
      window.fixtureChangeAccount = async (next) => {
        await window.fixtureWriteAccount(next);
        update([next]);
      };
    });
  }
  if (draft) {
    const key = `otc-v2:${world.config.chainId}:${world.deals.address}:draft`;
    await context.addInitScript(({ key, fields }) => {
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, JSON.stringify({ fields }));
    }, { key, fields: draft });
  }
  const page = await context.newPage();
  await page.goto(`${site.url}/${path}`);
  return page;
}

async function fundDeal({ chain, base, quote, config, deals }, legacy = false) {
  const contract = legacy ? contractAt(chain, OTC_DEALS, config.contract) : deals;
  await base.as(seller).approve(contract.address, ALLOCATION);
  await quote.as(buyer).approve(contract.address, legacy ? QUOTE : fees(QUOTE).buyerTotal);
  const expiry = (await chain.now()) + 86_400;
  if (legacy) await contract.as(seller).createDeal(base.address, ALLOCATION, quote.address, QUOTE, buyer, expiry);
  else await contract.as(seller).createDeal({
    baseToken: base.address, allocation: ALLOCATION, quoteToken: quote.address, quote: QUOTE, buyer, expiry,
    delivery: 0, fixedStart: 0, cliffSeconds: 0, durationSeconds: 0,
  });
}

function holdReads(chain, matches, { error = false } = {}) {
  const upstream = chain.publicRpc;
  let release;
  let waiting = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  chain.publicRpc = async (request) => {
    if (!matches(request)) return upstream(request);
    waiting++;
    await gate;
    return error ? rpcError(request) : upstream(request);
  };
  return {
    waiting: () => waiting,
    release() {
      chain.publicRpc = upstream;
      release();
    },
  };
}

const latestBlock = ({ method }) => method === "eth_getBlockByNumber";
const balanceRead = (token, owner) => ({ method, params }) => method === "eth_call"
  && params[0].to.toLowerCase() === token.toLowerCase()
  && params[0].data.startsWith("0x70a08231") && params[0].data.endsWith(owner.slice(2));
const focusWindow = (page) => page.evaluate(() => dispatchEvent(new Event("focus")));

for (const path of ["deal", "create"]) {
  test(`a slow V2 ${path} read survives two background ticks and discards invalidated wallet or draft reads`,
    { timeout: 50_000 }, (t) => withSite(t, async (fixture) => {
      const { world } = fixture;
      const creating = path === "create";
      if (!creating) await fundDeal(world);
      const heldBlock = holdReads(world.chain, latestBlock);
      try {
        const page = await open(fixture, creating ? "#/v2/new" : world.route(1), {
          account: creating ? seller : buyer,
          draft: creating ? { baseToken: world.base.address, quoteToken: world.quote.address, allocation: "1000000", quote: "123.456789", buyer } : null,
        });
        await expect.poll(heldBlock.waiting).toBe(1);
        await page.waitForTimeout(creating ? 9_300 : 8_300);
        assert.equal(heldBlock.waiting(), 1, "two background ticks should leave the first RPC in flight");
        heldBlock.release();
        await expect(button(page)).toHaveText(creating ? "Approve 1,000,000 ALFA" : "Settle · pay 124.074072 USDC");
        await expect(button(page)).toBeEnabled();

        const oldFunds = holdReads(world.chain, balanceRead(creating ? world.base.address : world.quote.address, creating ? seller : buyer), { error: true });
        try {
          if (creating) await page.getByTestId("allocation").fill("2000000");
          else await focusWindow(page);
          await expect.poll(oldFunds.waiting).toBe(1);
          await page.locator(".v2-read-message").evaluate((region) => {
            window.staleReadAnnouncements = 0;
            new MutationObserver((records) => { window.staleReadAnnouncements += records.length; })
              .observe(region, { childList: true, characterData: true, subtree: true });
          });
          await page.evaluate((next) => window.fixtureChangeAccount(next), other);
          if (creating) {
            await page.getByTestId("base-token").fill(world.quote.address);
            await page.getByTestId("quote-token").fill(world.base.address);
            await page.getByTestId("quote").fill("7.25");
            await page.getByTestId("allocation").fill("3");
            await page.getByTestId("allocation").focus();
            await expect(button(page)).toBeDisabled();
          } else {
            await expect(button(page)).toBeHidden();
          }
          oldFunds.release();

          if (creating) {
            await expect(page.getByText("This wallet holds 0 USDC. Funding requires 3 USDC.")).toBeVisible();
            await expect(page.getByTestId("allocation")).toBeFocused();
            await expect(page.getByText("7.25 ALFA", { exact: true })).toBeVisible();
            assert.equal(await page.evaluate(() => window.staleReadAnnouncements), 0);
            await page.reload();
            await expect(page.getByTestId("allocation")).toHaveValue("3");
            await expect(page.getByTestId("quote")).toHaveValue("7.25");
            await expect(page.getByTestId("base-token")).toHaveValue(world.quote.address);
            await expect(page.getByText("This wallet holds 0 USDC. Funding requires 3 USDC.")).toBeVisible();
          } else {
            await expect(page.getByText("This wallet cannot settle.", { exact: false })).toBeVisible();
            await page.evaluate((next) => window.fixtureChangeAccount(next), buyer);
            await expect(button(page)).toHaveText("Settle · pay 124.074072 USDC");
            await expect(button(page)).toBeEnabled();
            assert.equal(await page.evaluate(() => window.staleReadAnnouncements), 0);
          }
          await expect(page.getByRole("status").filter({ hasText: "Could not read the network" })).toHaveCount(0);
        } finally {
          oldFunds.release();
        }
      } finally {
        heldBlock.release();
      }
    }));
}

for (const legacy of [false, true]) {
  test(`plain, stable ${legacy ? "V1" : "V2"} notices for RPC reads, preflight reverts and wallet errors`,
    { timeout: 45_000 }, (t) => withSite(t, async (fixture) => {
      const { world } = fixture;
      await fundDeal(world, legacy);
      const { chain } = world;
      const original = chain.publicRpc;
      let fault = "read", reads = 0, sends = 0;
      const revert = "0x08c379a0" + AbiCoder.defaultAbiCoder().encode(["string"], [rawText]).slice(2);
      chain.publicRpc = (request) => {
        const [call] = request.params;
        if (request.method === "eth_call" && fault === "read" && call.data.startsWith(SELECTORS.getDeal)) {
          reads++;
          return rpcError(request);
        }
        if (request.method === "eth_call" && fault === "preflight" && call.data.startsWith(SELECTORS.fill)) {
          return rpcError(request, { data: revert });
        }
        return original(request);
      };
      const page = await open(fixture, legacy ? "#/d/1" : world.route(1), {
        account: buyer,
        send() {
          sends++;
          return { error: { code: -32603, message: rawText } };
        },
      });
      const readError = page.getByRole("status").filter({ hasText: "Could not read the network" });
      await expect(readError).toHaveCount(1);
      const retry = page.getByRole("button", { name: legacy ? "Try again" : "Retry read" });
      await retry.focus();
      await readError.evaluate((region) => {
        window.observedError = region;
        window.errorMutations = 0;
        new MutationObserver((records) => { window.errorMutations += records.length; })
          .observe(region, { childList: true, characterData: true, subtree: true });
      });
      const initialReads = reads;
      const backgroundRead = page.waitForResponse((response) => {
        if (!response.url().endsWith("/rpc")) return false;
        const { method, params } = response.request().postDataJSON();
        return method === "eth_call" && params[0].data.startsWith(SELECTORS.getDeal);
      });
      await focusWindow(page);
      await (await backgroundRead).finished();
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      assert.ok(reads > initialReads);
      await expect(retry).toBeFocused();
      assert.deepEqual(await readError.evaluate((region) => [region === window.observedError, window.errorMutations]), [true, 0]);

      fault = "preflight";
      await retry.click();
      await expect(button(page)).toHaveText(legacy ? "Fill: pay 123.456789 USDC" : "Settle · pay 124.074072 USDC");
      await button(page).click();
      await expect(page.getByTestId("notice")).toContainText("The transaction would fail on the chain");
      assert.equal(sends, 0);
      fault = null;
      await button(page).click();
      await expect(page.getByTestId("notice")).toHaveText("Your wallet could not complete the request. Check its network and activity before trying again.");
      await expect(page.getByRole("status").filter({ hasText: "Your wallet could not complete the request" })).toHaveCount(1);
      await expect(page.locator("body")).not.toContainText("fixture-internal");
      assert.equal(sends, 1);
    }));
}

for (const legacy of [false, true]) {
  test(`the ${legacy ? "V1" : "V2"} seller can retry a balance read and still gets amount validation`,
    { timeout: 40_000 }, (t) => withSite(t, async (fixture) => {
      const { world } = fixture;
      const original = world.chain.publicRpc;
      let failBalance = true;
      const matches = balanceRead(world.base.address, seller);
      world.chain.publicRpc = (request) => failBalance && matches(request) ? rpcError(request) : original(request);
      const page = await open(fixture, legacy ? "#/new" : "#/v2/new", {
        account: seller,
        draft: legacy ? null : { baseToken: world.base.address, quoteToken: world.quote.address, allocation: "1000000", quote: "123.456789", buyer },
      });
      if (legacy) {
        for (const [id, value] of [
          ["sell-token", world.base.address], ["buy-token", world.quote.address],
          ["sell-amount", "1000000"], ["buy-amount", "123.456789"],
        ]) await page.getByTestId(id).fill(value);
      }
      await expect(page.getByRole("status").filter({ hasText: "Could not read the network" })).toHaveCount(1);
      await expect(page.locator("body")).not.toContainText("fixture-internal");
      failBalance = false;
      await page.getByRole("button", { name: "Retry read" }).click();
      await expect(button(page)).toHaveText("Approve 1,000,000 ALFA");
      await expect(button(page)).toBeEnabled();
      await page.getByTestId(legacy ? "buy-amount" : "quote").fill("123.4567891");
      await expect(page.getByText("USDC has 6 decimals: write at most 6 digits after the dot.")).toBeVisible();
      await expect(button(page)).toBeDisabled();
    }));
}
