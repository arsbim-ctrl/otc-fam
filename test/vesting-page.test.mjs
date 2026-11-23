import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Interface } from "ethers";
import { CHAIN_ID, deploy, startChain } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { offered, serve, shows, wallet, withPage } from "../.launchpad/checks/round-1/page.mjs";
import { createV2Data } from "../web/vesting-chain.js";

const [deployer, seller, buyer, outsider, treasury] = ["11", "22", "33", "44", "55"].map((byte) => "0x" + byte.repeat(20));
const { OtcDealsV2 } = compile(ROOT, "contracts/OtcDealsV2.sol");
const { OtcDeals } = compile(ROOT, "contracts/OtcDeals.sol");
const { FixtureToken } = compile(ROOT, ".launchpad/checks/round-2/FixtureToken.sol");
const allocation = 10n ** 24n;
const quote = 123_456_789n;
const fee = 617_283n;
const day = 86_400n;
const screenshots = process.env.OTC_V2_EVIDENCE;
const fillSelector = "0x3fda5389";

async function world() {
  const chain = await startChain([deployer, seller, buyer, outsider, treasury]);
  const legacy = await deploy(chain, deployer, OtcDeals);
  const deals = await deploy(chain, deployer, OtcDealsV2, [treasury]);
  const base = await deploy(chain, deployer, FixtureToken, ["BASE", 18]);
  const payment = await deploy(chain, deployer, FixtureToken, ["USDC", 6]);
  await base.as(deployer).mint(seller, 2n * allocation);
  await payment.as(deployer).mint(buyer, 2n * (quote + fee));
  const site = await serve({ chain, deals: legacy });
  return { chain, deals, legacy, base, payment, site };
}

async function browser(w, hash, provider, width, steps) {
  return withPage(w.site, hash, provider, async (page) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.route("**/config.json", (route) => route.fulfill({ json: {
      chainId: CHAIN_ID, contract: w.legacy.address, contractV2: w.deals.address, rpcUrl: w.site.url + "/rpc",
    } }));
    await page.reload();
    return steps(page);
  });
}

async function evidence(page, name, width) {
  assert.ok(await page.evaluate((width) => document.documentElement.scrollWidth <= width, width),
    "No horizontal overflow at " + width + "px");
  if (screenshots) {
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, width + "-" + name + ".png"), fullPage: true });
  }
}

const button = (page, label) => page.getByRole("button", { name: label, exact: typeof label === "string" });
const status = (page, expected) => shows(page, "deal-status", (value) => value === expected, expected, "data-status");
const notice = (page, pattern) => shows(page, "notice", (value) => pattern.test(value), String(pattern));

async function createFromPage(w, width, vesting) {
  const fixed = BigInt(await w.chain.now()) + day;
  return browser(w, "#/v2/new", wallet(w, seller), width, async (page) => {
    if (vesting) {
      await page.getByTestId("v2-delivery").selectOption("unsupported");
      await page.getByText(/Existing positions, revocable rights/).waitFor();
      assert.equal(await offered(page), false);
      await page.getByTestId("v2-delivery").selectOption("vesting");
      await page.getByTestId("v2-start-mode").selectOption("fixed");
      const value = new Date(Number(fixed) * 1000).toISOString().slice(0, 19);
      await page.getByTestId("v2-fixedStart").fill(value);
    } else {
      await page.getByTestId("v2-delivery").selectOption("immediate");
    }
    for (const [key, value] of Object.entries({
      baseToken: w.base.address, allocation: "1000000", quoteToken: w.payment.address,
      quote: "123.456789", buyer,
    })) {
      await page.getByTestId("v2-" + key).fill(value);
    }
    await page.getByText("124.074072 USDC", { exact: true }).waitFor();
    await evidence(page, vesting ? "seller-vesting" : "seller-immediate", width);
    await button(page, "Connect wallet").click();
    await button(page, /^Approve 1,000,000 BASE$/).click();
    await button(page, "Fund deal").click();
    await page.waitForURL(/#\/v2\/[1-9]\d*$/);
    await status(page, "funded");
    const id = BigInt(page.url().split("/").at(-1));
    const deal = await w.deals.read.getDeal(id);
    assert.equal(deal.terms.buyer.toLowerCase(), buyer);
    assert.equal(deal.terms.fixedStart, vesting ? fixed : 0n);
    assert.equal(deal.terms.delivery, vesting ? 1n : 0n);
    assert.equal(await w.base.read.balanceOf(w.deals.address), allocation);
    return id;
  });
}

async function publicLink(w, id, width) {
  await browser(w, "#/v2/" + id, null, width, async (page) => {
    await status(page, "funded");
    await shows(page, "v2-funding", (value) => /full allocation is escrowed/.test(value), "fully escrowed");
    const terms = await page.getByTestId("v2-fees").innerText();
    for (const number of ["123.456789", "0.617283", "124.074072", "122.839506", "1.234566"]) {
      assert.ok(terms.includes(number), "Displayed exact amount " + number);
    }
    assert.equal(await offered(page), false);
    await evidence(page, "buyer-read-only", width);
  });
}

function recoverableWallet(w) {
  const answer = wallet(w, buyer);
  let chainId = "0x1";
  const faults = ["reject", "revert", "replace"];
  return async (request) => {
    if (request.method === "eth_chainId") return { result: chainId };
    if (request.method === "wallet_switchEthereumChain") {
      const response = await answer(request);
      if (!response.error) chainId = request.params[0].chainId;
      return response;
    }
    const transaction = request.params?.[0];
    if (request.method !== "eth_sendTransaction" || !transaction?.data?.startsWith(fillSelector)) return answer(request);
    switch (faults.shift()) {
      case "reject": return { error: { code: 4001, message: "User rejected." } };
      case "revert": return answer({ ...request, params: [{ ...transaction, gas: "0x7530" }] });
      case "replace":
        await w.chain.submit(buyer, { to: buyer, value: "0x0" });
        return { result: "0x" + "f8".repeat(32) };
      default: return answer(request);
    }
  };
}

async function balances(w) {
  return Promise.all([w.base, w.payment].map((token) =>
    Promise.all([seller, buyer, treasury, w.deals.address].map((party) => token.read.balanceOf(party)))));
}

async function settleFromPage(w, id, width, vesting, recover) {
  const before = await balances(w);
  const provider = recover ? recoverableWallet(w) : wallet(w, buyer);
  await browser(w, "#/v2/" + id, provider, width, async (page) => {
    await status(page, "funded");
    await button(page, "Connect wallet").click();
    if (recover) await button(page, "Switch to Local test chain").click();
    await button(page, /^Approve 124\.074072 USDC$/).click();
    const settle = vesting ? "Settle and fund grant" : "Settle for immediate delivery";
    if (recover) {
      for (const pattern of [/declined/, /reverted/, /replaced or cancelled/]) {
        await button(page, settle).click();
        await notice(page, pattern);
        assert.equal((await w.deals.read.getDeal(id)).status, 1n);
        assert.deepEqual(await balances(w), before);
      }
      await evidence(page, "buyer-recovered", width);
    }
    await button(page, settle).click();
    await status(page, "settled");
    await page.reload();
    await status(page, "settled");
    await page.getByText("On-chain events and receipts", { exact: true }).click();
    await page.getByText("Deal settled", { exact: true }).waitFor();
    if (vesting) await page.getByText("Grant created", { exact: true }).waitFor();
    await evidence(page, vesting ? "buyer-grant" : "buyer-immediate", width);
  });
  const after = await balances(w);
  const delta = (index) => after[index].map((value, i) => value - before[index][i]);
  assert.deepEqual(delta(1), [quote - fee, -(quote + fee), 2n * fee, 0n]);
  assert.deepEqual(delta(0), vesting ? [0n, 0n, 0n, 0n] : [0n, allocation, 0n, -allocation]);
}

async function grantScenarios(w, id, width) {
  const grant = await w.deals.read.getGrant(id);
  for (const [elapsed, amount] of [
    [29n, "0 BASE"], [30n, "333,333.333333333333333333 BASE"],
    [45n, "500,000 BASE"], [90n, "1,000,000 BASE"],
  ]) {
    await w.chain.setNextTime(Number(grant.start + elapsed * day));
    await w.chain.mine();
    if (elapsed === 29n || elapsed === 30n) {
      await browser(w, "#/v2/" + id, null, width, async (page) => {
        await shows(page, "v2-claimable", (value) => value === amount, amount);
        await evidence(page, elapsed === 29n ? "before-cliff" : "at-cliff", width);
      });
    } else if (elapsed === 45n) {
      await browser(w, "#/v2/" + id, wallet(w, buyer), width, async (page) => {
        await shows(page, "v2-claimable", (value) => value === amount, amount);
        await button(page, "Connect wallet").click();
        await button(page, "Claim 500,000 BASE").click();
        await shows(page, "v2-claimable", (value) => value === "0 BASE", "zero after claim");
        await page.getByTestId("v2-receipt").waitFor();
        await evidence(page, "midpoint-claimed", width);
      });
      assert.equal(await w.base.read.balanceOf(buyer), allocation / 2n);
    } else {
      await browser(w, "#/v2/" + id, wallet(w, buyer), width, async (page) => {
        await shows(page, "v2-claimable", (value) => value === "500,000 BASE", "final claim less prior claims");
        await button(page, "Connect wallet").click();
        await button(page, "Claim 500,000 BASE").click();
        await page.getByText("All tokens have been claimed.").waitFor();
        await evidence(page, "final-claim", width);
      });
      assert.equal(await w.base.read.balanceOf(buyer), allocation);
      assert.equal(await w.base.read.balanceOf(w.deals.address), 0n);
    }
  }
}

for (const width of [390, 1440]) {
  test("private funded vesting, recovery and cumulative claims at " + width + "px", async () => {
    const w = await world();
    try {
      const id = await createFromPage(w, width, true);
      await publicLink(w, id, width);
      await settleFromPage(w, id, width, true, true);
      await grantScenarios(w, id, width);
    } finally {
      await w.site.close();
    }
  });
  test("private immediate delivery has exact transfers and no grant at " + width + "px", async () => {
    const w = await world();
    try {
      const id = await createFromPage(w, width, false);
      await settleFromPage(w, id, width, false, false);
      assert.equal((await w.deals.read.getDeal(id)).grantId, 0n);
    } finally {
      await w.site.close();
    }
  });
}

test("the page encodes the published V2 tuple in the exact Solidity order", () => {
  const terms = { baseToken: seller, quoteToken: buyer, buyer: outsider, allocation, quote, expiry: 91n,
    delivery: 1, fixedStart: 12n, cliffSeconds: 13n, durationSeconds: 14n };
  assert.equal(createV2Data(terms), new Interface(OtcDealsV2.abi).encodeFunctionData("createDeal", [terms]));
});
