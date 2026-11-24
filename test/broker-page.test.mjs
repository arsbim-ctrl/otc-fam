import assert from "node:assert/strict";
import { after, test } from "node:test";
import { browse, closeBrowser, serve, walletFor } from "../scripts/lib/site.mjs";
import { DAY, world } from "../scripts/lib/world.mjs";
import { BrokerChain } from "../web/broker.js";
import { historyKey } from "../web/broker-history-cache.js";
import { abi, dealHash } from "../web/broker-terms.js";
import { Chain } from "../web/eth.js";

after(closeBrowser);

async function onSite(steps) {
  const w = await world({ withBroker: true });
  const site = await serve(w);
  try {
    await steps(w, site);
  } finally {
    await site.close();
  }
}

async function funded(w, nonce, changes) {
  const terms = await w.brokerTerms(nonce, changes);
  await w.fam.as(w.deployer).mint(w.seller, terms.allocation);
  await w.fam.as(w.seller).approve(w.brokerDeals.address, terms.allocation);
  await w.brokerDeals.as(w.seller).fund(terms, await w.brokerSign(w.seller, terms));
  const id = w.brokerId(terms);
  assert.equal((await w.brokerDeals.read.getDeal(id)).status, 1n);
  return { id, terms };
}

const connect = (page) => page.getByRole("button", { name: "Connect wallet", exact: true }).click();
const status = (page, name) => page.locator(`[data-testid="deal-status"][data-status="${name}"]`).waitFor();
const rows = (page) => page.locator(".broker-history-row");
const walletAction = (page, name) => page.getByRole("button", { name, exact: true }).click();

async function readyBuyer(w, terms) {
  const total = terms.quote + terms.quote / 200n;
  await w.usdc.as(w.deployer).mint(w.buyer, total);
  await w.usdc.as(w.buyer).approve(w.brokerDeals.address, total);
}

async function settleDeal(w, id, terms) {
  return w.brokerDeals.as(w.buyer).settle(id, await w.brokerSign(w.buyer, terms));
}


test("a fresh buyer discovers only their funded deals, while seller, broker and unrelated histories stay scoped", () => onSite(async (w, site) => {
  const { id } = await funded(w, 101n, { expiry: await w.chain.now() + 35 * DAY });
  const { id: anotherDeal } = await funded(w, 102n, { buyer: w.treasury });
  const vested = await funded(w, 105n, { delivery: 1, cliffSeconds: 30 * DAY, durationSeconds: 90 * DAY,
    allocation: 900_000_000_000_000_000_001n });
  await readyBuyer(w, vested.terms);
  await settleDeal(w, vested.id, vested.terms);
  const grant = (await w.brokerDeals.read.getDeal(vested.id)).grantId;
  const { cliff } = await w.brokerDeals.read.getGrant(grant);
  await w.next(cliff);
  await w.brokerDeals.as(w.buyer).claim(grant);
  for (const [account, role, expected] of [
    [w.buyer, "buyer", [id, vested.id]], [w.seller, "seller", [id, anotherDeal, vested.id]],
    [w.broker, "broker", [id, anotherDeal, vested.id]], [w.other, null, []],
  ]) {
    await browse(site, "#/v3/history", { wallet: walletFor(w, account), cleanConsole: true }, async (page) => {
      assert.equal(await page.evaluate(() => localStorage.length), 0);
      await connect(page);
      if (role) {
        await page.getByTestId("history-role").selectOption(role);
        const row = page.locator(`[data-deal-id="${id}"][data-status="funded"][data-roles="${role}"]`);
        await row.getByText("Funding confirmed", { exact: false }).waitFor();
        const expectedCopy = {
          buyer: ["Buyer pays", "124.074072 USDC", "Buyer receives", "1,000,000 FAM"],
          seller: ["Seller net", "122.839506 USDC", "Allocation", "1,000,000 FAM"],
          broker: ["Proposed broker fee", "0.246913 USDC", "Broker share", "20% of the fee pool"],
        };
        for (const copy of expectedCopy[role]) await row.getByText(copy, { exact: true }).waitFor();
        await row.getByText(/Immediate delivery/).waitFor();
        await row.locator(`[title="${id}"]`).waitFor();
        const grantRow = page.locator(`[data-deal-id="${vested.id}"][data-status="settled"]`);
        await grantRow.getByText(`Vesting grant #${grant}`, { exact: false }).waitFor();
        await grantRow.getByText({ buyer: "Buyer paid", seller: "Seller received", broker: "Broker paid" }[role], { exact: true }).waitFor();
        if (role === "buyer") {
          const expectedGrant = {
            "Funded into grant vault": "900.000000000000000001 FAM",
            "Still in grant vault": "600.000000000000000001 FAM",
            "Vested": "300 FAM",
            "Claimed": "300 FAM",
            "Claimable": "0 FAM",
          };
          for (const [label, value] of Object.entries(expectedGrant)) {
            const fact = grantRow.getByText(label, { exact: true }).locator("xpath=following-sibling::dd");
            assert.equal(await fact.innerText(), value);
          }
          assert.equal(await grantRow.getByText("Buyer received", { exact: true }).count(), 0);

          await page.route("**/rpc", (route) => {
            const request = route.request().postDataJSON();
            return request.method === "eth_call" && request.params[0].data.startsWith(abi.getFunction("getGrant").selector)
              ? route.fulfill({ json: { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Grant read unavailable." } } })
              : route.continue();
          });
          await walletAction(page, "Refresh history");
          await grantRow.getByText("Vault details unavailable", { exact: true }).waitFor();
          assert.equal(await grantRow.getByText("Buyer received", { exact: true }).count(), 0);
        }
        if (role !== "buyer") {
          const available = grantRow.getByText("Claimable by buyer", { exact: true }).locator("xpath=following-sibling::dd");
          assert.equal(await available.innerText(), "0 FAM");
        }
        if (role === "seller") {
          const expired = page.locator(`[data-deal-id="${anotherDeal}"][data-status="expired"]`);
          await expired.getByText("Allocation in escrow", { exact: true }).waitFor();
          await expired.getByText("1,000,000 FAM · Refund available", { exact: true }).waitFor();
        }
        for (const item of [row, grantRow]) assert.equal(await item.getByRole("link", { name: "Duplicate terms" }).count(), role === "broker" ? 1 : 0);
        if (role !== "broker") assert.equal(await page.getByRole("link", { name: "Duplicate terms" }).count(), 0);
      } else {
        await page.getByText("No deals for this wallet and role.", { exact: false }).waitFor();
      }
      const displayed = await rows(page).evaluateAll((items) => items.map((row) => row.dataset.dealId));
      assert.deepEqual(displayed.sort(), expected.sort());
      const key = historyKey(w.brokerDomain, account);
      const cached = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
      assert.deepEqual(cached.records.map(({ id }) => id).sort(), expected);
      assert.equal(cached.fromBlock, w.brokerConfig.fromBlockBroker);
      assert.match(cached.block.hash, /^0x[0-9a-f]{64}$/);
    });
  }
}));

test("an RPC outage hides stale broker receipts, payment and actions until a live refresh succeeds", () => onSite(async (w, site) => {
  const { id } = await funded(w, 103n);
  await browse(site, `#/v3/d/${id}`, { wallet: walletFor(w, w.buyer), cleanConsole: true }, async (page) => {
    await status(page, "funded");
    await connect(page);
    const settle = page.getByRole("button", { name: "Sign terms and settle" });
    const split = page.getByRole("heading", { name: "Proposed payment split" });
    const receipt = page.locator('[data-kind="funded"]');
    await settle.waitFor();
    const hash = await receipt.getAttribute("data-tx");

    const maintenance = "The RPC endpoint is under maintenance.";
    await page.route("**/rpc", (route) => {
      const { id, method } = route.request().postDataJSON();
      return method === "eth_getBlockByNumber"
        ? route.fulfill({ json: { jsonrpc: "2.0", id, error: { code: -32000, message: maintenance } } })
        : route.continue();
    });
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await status(page, "unverified");
    await page.getByRole("alert").getByText(maintenance, { exact: true }).waitFor();
    await page.getByText("Refresh chain status to retry.", { exact: true }).waitFor();
    for (const stale of [receipt, split, settle]) assert.equal(await stale.count(), 0);

    await page.unroute("**/rpc");
    await page.getByRole("button", { name: "Refresh chain status", exact: true }).click();
    await status(page, "funded");
    await split.waitFor();
    await settle.waitFor();
    assert.equal(await receipt.getAttribute("data-tx"), hash);
  });
}));

test("only the seller sees a refund action when a funded deal has expired", () => onSite(async (w, site) => {
  const { id, terms } = await funded(w, 104n);
  await w.at(terms.expiry);
  for (const account of [w.buyer, w.seller]) {
    await browse(site, `#/v3/d/${id}`, { wallet: walletFor(w, account), cleanConsole: true }, async (page) => {
      await status(page, "expired");
      await connect(page);
      await page.getByText("Only the seller can refund the allocation.", { exact: false }).waitFor();
      await page.getByText("Settlement is no longer possible.", { exact: false }).waitFor();
      await page.getByText("Still in escrow", { exact: true }).waitFor();
      await page.locator('[data-kind="funded"]').getByText("1,000,000 FAM in escrow · no fees", { exact: true }).waitFor();
      assert.equal(await page.getByText("Buyer pays", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("heading", { name: "Proposed payment split" }).count(), 0);
      const refund = page.getByRole("button", { name: "Refund allocation to seller", exact: true });
      if (account === w.seller) {
        await refund.waitFor();
        assert.ok(await refund.isEnabled());
      } else {
        await page.getByText("This wallet has no action on the expired deal.", { exact: true }).waitFor();
        assert.equal(await refund.count(), 0);
        assert.equal(await page.getByText(/To act here, switch/).count(), 0);
      }
      assert.equal(await page.getByRole("button", { name: /settle/i }).count(), 0);
    });
  }

  const unfunded = { ...terms, nonce: 112n };
  await browse(site, dealHash(w.brokerDomain, unfunded), { wallet: walletFor(w, w.seller), cleanConsole: true }, async (page) => {
    await status(page, "expired");
    await page.getByText("The broker can prepare a new link with a new nonce.", { exact: false }).waitFor();
    assert.equal(await page.getByText("Buyer pays", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Proposed payment split" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Refund allocation to seller" }).count(), 0);
  });
}));

test("history reuses the same head, reads only changed deals at new blocks, and rebuilds after a reorg", async () => {
  const w = await world({ withBroker: true });
  const original = await funded(w, 106n);
  const chain = new Chain(null, w.brokerDeals.address);
  const calls = [];
  chain.rpc = (method, params) => {
    calls.push({ method, params });
    return w.chain.rpc(method, params);
  };
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const config = { ...w.brokerConfig, chainId: w.brokerDomain.chainId };
  const openHistory = () => new BrokerChain(chain, config, storage);
  let api = openHistory();
  const key = historyKey(w.brokerDomain, w.buyer);
  const ranges = () => calls.filter(({ method }) => method === "eth_getLogs").map(({ params: [p] }) => [Number(p.fromBlock), Number(p.toBlock)]);
  const reads = () => calls.filter(({ method }) => method === "eth_call")
    .map(({ params: [p] }) => abi.decodeFunctionData("getDeal", p.data)[0]);
  const scan = async (expected) => {
    const result = await api.activity(w.buyer);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.entries.map(({ deal }) => deal.id).sort(), expected.sort());
    return result;
  };
  const first = await scan([original.id]);
  assert.deepEqual(ranges(), [[w.brokerConfig.fromBlockBroker, first.block.number]]);
  assert.deepEqual(reads(), [original.id]);
  calls.length = 0;
  await scan([original.id]);
  assert.deepEqual(ranges(), []);
  assert.deepEqual(reads(), []);
  assert.deepEqual(JSON.parse(store.get(key)).block, { number: first.block.number, hash: first.block.hash });
  api = openHistory();
  calls.length = 0;
  await scan([original.id]);
  assert.deepEqual(ranges(), [], "a reload at the same head skips log scans");
  assert.deepEqual(reads(), [original.id], "a reload verifies cached deal status onchain");
  calls.length = 0;

  const snapshot = await w.chain.rpc("evm_snapshot");
  const newDeal = await funded(w, 107n);
  const second = await scan([original.id, newDeal.id]);
  assert.deepEqual(ranges(), [[first.block.number + 1, second.block.number]]);
  assert.deepEqual(reads(), [newDeal.id]);
  calls.length = 0;
  await w.brokerDeals.as(w.seller).refund(original.id);
  api = openHistory();
  const third = await scan([original.id, newDeal.id]);
  assert.deepEqual(ranges(), [[second.block.number + 1, third.block.number]]);
  assert.deepEqual(reads().sort(), [original.id, newDeal.id].sort());
  const refunded = third.entries.find(({ deal }) => deal.id === original.id);
  assert.equal(refunded.deal.status, "refunded");
  assert.equal(refunded.receipts.at(-1).kind, "refunded");

  assert.equal(await w.chain.rpc("evm_revert", [snapshot]), true);
  const alternate = await funded(w, 108n);
  calls.length = 0;
  api = openHistory();
  const reorganized = await scan([original.id, alternate.id]);
  assert.deepEqual(ranges(), [[w.brokerConfig.fromBlockBroker, reorganized.block.number]]);
  assert.deepEqual(reads().sort(), [original.id, alternate.id].sort());
  assert.equal(reorganized.entries.find(({ deal }) => deal.id === original.id).deal.status, "funded");

  const incomplete = JSON.parse(store.get(key));
  delete incomplete.records[0].receipts;
  store.set(key, JSON.stringify(incomplete));
  api = openHistory();
  calls.length = 0;
  await scan([original.id, alternate.id]);
  assert.deepEqual(ranges(), [[w.brokerConfig.fromBlockBroker, reorganized.block.number]], "a partial cache is rebuilt");

  const unavailable = () => { throw new Error("Browser storage unavailable"); };
  api = new BrokerChain(chain, config, { getItem: unavailable, setItem: unavailable });
  await scan([original.id, alternate.id]);
  calls.length = 0;
  await scan([original.id, alternate.id]);
  assert.deepEqual(ranges(), [], "blocked storage falls back to the in-memory cursor");
  assert.deepEqual(reads(), []);
});

test("link terms and a submitted broker transaction survive an RPC outage and reload", () => onSite(async (w, site) => {
  const { id, terms } = await funded(w, 109n);
  await readyBuyer(w, terms);
  await browse(site, dealHash(w.brokerDomain, terms), { wallet: walletFor(w, w.buyer), cleanConsole: true }, async (page) => {
    const pending = page.getByTestId("pending-transaction");
    const stop = page.getByRole("button", { name: "Stop waiting and refresh", exact: true });
    const receipt = page.locator('[data-kind="settled"]');
    await status(page, "funded");
    await connect(page);
    let down = false;
    await page.route("**/rpc", (route) => {
      const { id, method } = route.request().postDataJSON();
      if (down && ["eth_getBlockByNumber", "eth_getTransactionReceipt"].includes(method)) {
        return route.fulfill({ json: { jsonrpc: "2.0", id, error: { code: -32000, message: "RPC unavailable." } } });
      }
      return route.continue();
    });
    await w.chain.rpc("evm_setAutomine", [false]);
    try {
      await walletAction(page, "Sign terms and settle");
      await pending.waitFor();
      const hash = await pending.locator(".mono").innerText();
      assert.match(hash, /^0x[0-9a-f]{64}$/);
      assert.equal(await w.chain.rpc("eth_getTransactionReceipt", [hash]), null);
      down = true;
      await page.reload();
      await status(page, "unverified");
      await stop.waitFor();
      await page.getByRole("heading", { name: "Deal terms from the link" }).waitFor();
      const termsCard = page.locator("#broker-exact-terms");
      for (const value of [id, String(terms.nonce), String(terms.quote)]) {
        await termsCard.getByText(value, { exact: true }).waitFor();
      }
      assert.equal(await pending.locator(".mono").innerText(), hash);
      assert.equal(await page.getByRole("heading", { name: /receipts|payment split/i }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Sign terms and settle" }).count(), 0);

      await w.chain.mine();
      down = false;
      await walletAction(page, "Refresh chain status");
      await status(page, "settled");
      assert.equal(await receipt.getAttribute("data-tx"), hash);
    } finally {
      await w.chain.rpc("evm_setAutomine", [true]);
    }
  });
}));

test("refund and settlement races show the winning action and remove the losing action", () => onSite(async (w, site) => {
  const warning = "The seller can refund until settlement is mined";
  const buying = await funded(w, 110n);
  await readyBuyer(w, buying.terms);
  const before = await w.holdings();
  const sent = [];
  const buyer = walletFor(w, w.buyer, async (request) => {
    if (request.method === "eth_signTypedData_v4") await w.brokerDeals.as(w.seller).refund(buying.id);
    return null;
  }, sent);
  await browse(site, dealHash(w.brokerDomain, buying.terms), { wallet: buyer, cleanConsole: true }, async (page) => {
    await connect(page);
    await page.getByText(warning, { exact: false }).waitFor();
    await walletAction(page, "Sign terms and settle");
    await status(page, "refunded");
    await page.getByText("Ask the broker for a new deal link.", { exact: false }).waitFor();
    await page.getByText("The allocation returned to the seller. No fees were paid.", { exact: true }).waitFor();
    await page.getByText("Returned to seller", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("headline-total").innerText(), "0 USDC");
    assert.equal(await page.getByText("Buyer pays", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Proposed payment split" }).count(), 0);
    await page.locator('[data-kind="refunded"]').getByText("1,000,000 FAM returned to the seller · no fees", { exact: true }).waitFor();
    const funding = page.locator('[data-kind="funded"]');
    await funding.getByText("1,000,000 FAM funded · no fees", { exact: true }).waitFor();
    assert.equal(await funding.getByText(/in escrow/).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Sign terms and settle" }).count(), 0);
    assert.ok(!sent.includes("eth_sendTransaction"));
  });
  assert.deepEqual(await w.moved(before), { "seller.FAM": buying.terms.allocation, "escrow.FAM": -buying.terms.allocation });

  const selling = await funded(w, 111n);
  const seller = walletFor(w, w.seller, async (request, answer) => {
    if (request.method !== "eth_sendTransaction") return null;
    await settleDeal(w, selling.id, selling.terms);
    return answer({ ...request, params: [{ ...request.params[0], gas: "0x200000" }] });
  });
  await browse(site, dealHash(w.brokerDomain, selling.terms), { wallet: seller, cleanConsole: true }, async (page) => {
    await connect(page);
    await page.getByText(warning, { exact: false }).waitFor();
    await walletAction(page, "Refund allocation to seller");
    await status(page, "settled");
    await page.getByText("The buyer settled the deal before the refund.", { exact: false }).waitFor();
    await page.getByRole("heading", { name: "Confirmed payment split" }).waitFor();
    assert.equal(await page.getByText("Buyer pays", { exact: true }).count(), 0);
    await page.locator('[data-kind="settled"]').waitFor();
    const funding = page.locator('[data-kind="funded"]');
    await funding.getByText("1,000,000 FAM funded · no fees", { exact: true }).waitFor();
    assert.equal(await funding.getByText(/in escrow/).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Refund allocation to seller" }).count(), 0);
  });
}));
