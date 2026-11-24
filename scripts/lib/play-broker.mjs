import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { unpack } from "../../web/broker-terms.js";
import { historyKey } from "../../web/broker-history-cache.js";
import { formatAmount } from "../../web/units.js";
import { browse, fits, read, serve, walletFor } from "./site.mjs";
import { DAY, world } from "./world.mjs";

const ALLOCATION = 900_000_000_000_000_000_001n;
const FUNDING = { "seller.FAM": -ALLOCATION, "escrow.FAM": ALLOCATION };
const PAYMENT = { "buyer.USDC": -124_074_072n, "seller.USDC": 122_839_506n, "broker.USDC": 246_913n, "treasury.USDC": 987_653n };
const fixtures = [
  ["31-small-quote-zero-share", "123.456789", "0", 124_074_072n, 122_839_506n, 0n, 1_234_566n, 1_234_566n],
  ["32-large-quote-zero-share", "100000", "0", 100_500_000_000n, 99_500_000_000n, 0n, 1_000_000_000n, 1_000_000_000n],
  ["33-large-quote-twenty-percent", "100000", "2000", 100_500_000_000n, 99_500_000_000n, 200_000_000n, 800_000_000n, 1_000_000_000n],
];
const usdc = (raw) => `${formatAmount(raw, 6)} USDC`;
const quiet = { cleanConsole: true };
const clipboard = ["clipboard-read", "clipboard-write"];

export async function playBroker(size, folder) {
  mkdirSync(folder, { recursive: true });
  const w = await world({ withBroker: true });
  await w.fam.as(w.deployer).mint(w.seller, 12n * ALLOCATION);
  await w.usdc.as(w.deployer).mint(w.buyer, 250_000_000_000n);
  const site = await serve(w);
  let shots = 0;
  const status = (page, name) => page.locator(`[data-testid="deal-status"][data-status="${name}"]`).first().waitFor();
  const text = (page, content) => page.getByText(content, { exact: false }).first().waitFor();
  const primary = (page, label) => page.getByRole("button", { name: label, exact: true }).click();
  const connect = (page) => primary(page, "Connect wallet");
  const parsed = (hash) => ({ ...unpack(hash.split("/").at(-1)), id: hash.split("/")[3] });
  const wallet = (person, instead, calls) => walletFor(w, person, instead, calls);
  const visit = (hash, options, act) => browse(site, hash, { size, ...quiet, ...options }, act);

  async function look(page, scene) {
    const name = `${scene}-${size.width}.jpg`;
    assert.ok(await fits(page), `${scene}: layout fits ${size.width} px`);
    await page.screenshot({ path: join(folder, name), fullPage: true, type: "jpeg", quality: 63, animations: "disabled" });
    console.log(`\n--- ${name}\n${(await read(page)).split("\n").map((line) => line ? `    ${line}` : "").join("\n")}`);
    shots++;
  }
  async function moved(before, exact, what) {
    assert.deepEqual(await w.moved(before), exact, what);
    console.log(`\n    RAW BALANCES · ${what}\n    ${Object.entries(exact).map(([key, value]) => `${key} ${value}`).join(", ") || "All balances unchanged"}`);
  }
  async function refundShown(page) {
    await status(page, "refunded");
    await text(page, "The allocation returned to the seller. No fees were paid.");
    assert.equal(await page.getByTestId("headline-total").innerText(), "0 USDC");
    assert.equal(await page.getByText("Buyer pays", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Proposed payment split" }).count(), 0);
    await page.locator('[data-kind="refunded"]').getByText("returned to the seller · no fees", { exact: false }).waitFor();
    await page.locator('[data-kind="funded"]').getByText("funded · no fees", { exact: false }).waitFor();
  }
  async function fund(hash, scenes) {
    return visit(hash, { wallet: wallet(w.seller) }, async (page) => {
      await status(page, "unfunded");
      await connect(page);
      await page.getByRole("button", { name: "Sign terms and fund" }).waitFor();
      if (scenes) await look(page, scenes[0]);
      const before = await w.holdings();
      await primary(page, "Sign terms and fund");
      await status(page, "funded");
      await page.locator('[data-kind="funded"]').waitFor();
      await moved(before, FUNDING, "seller funding");
      if (scenes) await look(page, scenes[1]);
    });
  }

  try {
    console.log(`\n=== BROKER DEALS · ${size.width} px`);
    await visit("#/v3/new", { wallet: wallet(w.broker), permissions: clipboard }, async (desk) => {
      const inputs = { seller: w.seller, buyer: w.buyer, broker: w.broker, baseToken: w.fam.address,
        quoteToken: w.usdc.address, allocation: "900.000000000000000001", quote: "123.456789" };
      const prepare = async ({ delivery = "0", lifetime = "24", share = "2000", price = inputs.quote, brokerFee = share === "0" ? 0n : 246_913n, copy = true, scenes } = {}) => {
        await desk.goto(`${site.url}/#/v3/new`);
        for (const [name, value] of Object.entries({ ...inputs, quote: price, lifetime, brokerBps: share })) {
          await desk.getByTestId(name).fill(value);
        }
        await desk.getByTestId("delivery").selectOption(delivery);
        await desk.getByTestId("broker-fee").getByText(usdc(brokerFee), { exact: true }).waitFor();
        const before = await w.holdings();
        if (scenes) {
          await desk.getByTestId("quote").focus();
          await desk.keyboard.press("Tab");
          assert.equal(await desk.evaluate(() => document.activeElement.dataset.testid), "lifetime");
          assert.match(await desk.getByTestId("lifetime").evaluate((node) => getComputedStyle(node).outlineStyle), /solid/);
          await look(desk, scenes[0]);
        }
        await desk.getByTestId("create-link").click();
        const hash = await desk.getByTestId("deal-link").getAttribute("href");
        const { id } = parsed(hash);
        assert.equal((await w.brokerDeals.read.getDeal(id)).status, 0n);
        if (copy) {
          await primary(desk, "Copy link");
          await text(desk, "Link copied. The named seller");
          assert.equal(await desk.evaluate(() => navigator.clipboard.readText()), site.url + "/" + hash);
          if (scenes) await look(desk, scenes[1]);
        }
        await moved(before, {}, "preparing a share link");
        return hash;
      };

      const immediate = await prepare({ scenes: ["01-broker-enters-terms", "02-link-copied"] });
      await visit(immediate, {}, async (page) => {
        await status(page, "unfunded");
        await text(page, "The buyer can settle after the named seller funds");
        assert.equal(await page.getByRole("button", { name: /settle/ }).count(), 0);
        await look(page, "05-awaiting-funding");
      });
      await fund(immediate, ["03-seller-inspects", "04-seller-funded"]);
      await visit(immediate, {}, async (page) => {
        await status(page, "funded");
        await page.getByTestId("no-wallet").waitFor();
        await text(page, "Immediate · full allocation");
        await look(page, "06-fresh-buyer-immediate");
      });

      const calls = [];
      let reject = true;
      const buyer = wallet(w.buyer, (request) => {
        if (request.method === "eth_signTypedData_v4" && reject) {
          reject = false;
          return { error: { code: 4001, message: "User rejected the request." } };
        }
        return null;
      }, calls);
      await visit(immediate, { wallet: buyer }, async (page) => {
        await status(page, "funded");
        assert.ok(calls.every((method) => ["eth_accounts", "eth_chainId"].includes(method)));
        await connect(page);
        const before = await w.holdings();
        await primary(page, "Sign terms and settle");
        await text(page, "You declined in your wallet. Nothing was sent.");
        assert.ok(!calls.includes("eth_sendTransaction"), "a declined signature leaves approvals untouched");
        await moved(before, {}, "declined buyer signature");
        await look(page, "07-wallet-request-declined");
        await primary(page, "Sign terms and settle");
        await status(page, "settled");
        const receipt = page.locator('[data-kind="settled"]');
        await receipt.waitFor();
        const hash = await receipt.getAttribute("data-tx");
        assert.match(hash, /^0x[0-9a-f]{64}$/);
        assert.equal((await w.chain.rpc("eth_getTransactionReceipt", [hash])).status, "0x1");
        for (const [field, exact] of Object.entries({ "buyer-total": "124.074072 USDC", "seller-net": "122.839506 USDC",
          "broker-fee": "0.246913 USDC", "treasury-fee": "0.987653 USDC", "buyer-fee": "0.617283 USDC", "seller-fee": "0.617283 USDC" })) {
          await page.getByTestId(field).getByText(exact, { exact: true }).waitFor();
        }
        await moved(before, { ...PAYMENT, "escrow.FAM": -ALLOCATION, "buyer.FAM": ALLOCATION }, "immediate settlement");
        await page.locator('[data-kind="funded"]').getByText("funded · no fees", { exact: false }).waitFor();
        await look(page, "08-immediate-receipt");
        await page.reload();
        await status(page, "settled");
        assert.equal(await receipt.getAttribute("data-tx"), hash);
        await look(page, "09-reload-confirmed");
        await page.evaluate((account) => window.__standEmit("accountsChanged", [account]), w.other);
        assert.equal(await receipt.getAttribute("data-tx"), hash);
      });

      const vesting = await prepare({ delivery: "1", scenes: ["25-broker-sets-vesting", "26-vesting-link-copied"] });
      await fund(vesting, ["27-seller-inspects-vesting", "28-seller-funded-vesting"]);
      await visit(vesting, {}, async (page) => {
        await status(page, "funded");
        await page.getByTestId("no-wallet").waitFor();
        await text(page, "30 days cliff · 90 days total");
        await look(page, "10-fresh-buyer-vesting");
      });
      const unrelatedCalls = [];
      await visit(vesting, { wallet: wallet(w.other, undefined, unrelatedCalls) }, async (page) => {
        await connect(page);
        await text(page, `Connected wallet ${w.other}. To act here, switch to ${w.buyer}`);
        assert.equal(await page.getByRole("button", { name: /settle/ }).count(), 0);
        assert.ok(unrelatedCalls.every((method) => ["eth_accounts", "eth_requestAccounts", "eth_chainId"].includes(method)));
        await look(page, "11-wrong-wallet");
      });
      let chainId = "0x1";
      const elsewhere = wallet(w.buyer, (request) => {
        if (request.method === "eth_chainId") return { result: chainId };
        if (request.method === "wallet_switchEthereumChain") chainId = request.params[0].chainId;
        return null;
      });
      await visit(vesting, { wallet: elsewhere }, async (page) => {
        await connect(page);
        await text(page, "Wallet is on Ethereum (chain 1)");
        await look(page, "12-wrong-network");
        await primary(page, "Switch to Local test chain");
        const before = await w.holdings();
        await primary(page, "Sign terms and settle");
        await status(page, "settled");
        const { grantId } = await w.brokerDeals.read.getDeal(parsed(vesting).id);
        const grant = await w.brokerDeals.read.getGrant(grantId);
        w.watch("vestingVault", grant.custodian);
        await moved(before, { ...PAYMENT, "escrow.FAM": -ALLOCATION, "vestingVault.FAM": ALLOCATION }, "vesting settlement");
        await text(page, "Settlement confirmed");
        await page.getByTestId("grant-claimable").getByText("0 FAM", { exact: true }).waitFor();
        await page.locator('[data-kind="funded"]').getByText("funded · no fees", { exact: false }).waitFor();
        await look(page, "13-vesting-receipt");
        await w.at(grant.cliff);
        await page.evaluate(() => dispatchEvent(new Event("focus")));
        await page.getByTestId("grant-claimable").getByText("300 FAM", { exact: true }).waitFor();
        await look(page, "14-vesting-cliff");
        const atCliff = await w.holdings();
        await w.next(grant.cliff);
        await primary(page, "Claim vested tokens");
        await page.getByTestId("grant-claimed").getByText("300 FAM", { exact: true }).waitFor();
        await moved(atCliff, { "buyer.FAM": 300_000_000_000_000_000_000n, "vestingVault.FAM": -300_000_000_000_000_000_000n }, "beneficiary claim, no fees");
        await look(page, "15-vesting-claimed");
      });

      await prepare({ lifetime: "168", share: "0" }); // awaiting funding
      await prepare({ lifetime: "168", copy: false }); // created
      const live = await prepare({ lifetime: "168" });
      await fund(live);
      const expired = await prepare({ lifetime: "1" });
      await fund(expired);
      const refundable = await prepare({ lifetime: "168" });
      await fund(refundable);
      await visit(refundable, { wallet: wallet(w.seller) }, async (page) => {
        await status(page, "funded");
        await connect(page);
        const before = await w.holdings();
        await primary(page, "Refund allocation to seller");
        await refundShown(page);
        await moved(before, { "seller.FAM": ALLOCATION, "escrow.FAM": -ALLOCATION }, "seller refund, no fees");
        await look(page, "16-refund-receipt");
      });
      await w.at(parsed(expired).terms.expiry);
      await visit(expired, { wallet: wallet(w.buyer) }, async (page) => {
        await status(page, "expired");
        await text(page, "The settlement deadline has passed");
        await connect(page);
        await text(page, "Only the seller can refund the allocation.");
        await text(page, "This wallet has no action on the expired deal.");
        await text(page, "Settlement is no longer possible.");
        await page.getByText("Still in escrow", { exact: true }).waitFor();
        await page.locator('[data-kind="funded"]').getByText("in escrow · no fees", { exact: false }).waitFor();
        assert.equal(await page.getByText("Buyer pays", { exact: true }).count(), 0);
        assert.equal(await page.getByRole("heading", { name: "Proposed payment split" }).count(), 0);
        assert.equal(await page.getByText(/To act here, switch/).count(), 0);
        assert.equal(await page.getByRole("button", { name: /settle|refund allocation/i }).count(), 0);
        await look(page, "17-expired");
      });

      await desk.goto(`${site.url}/#/v3/history`);
      await connect(desk);
      const rows = desk.locator(".broker-history-row");
      await rows.first().waitFor();
      await desk.getByTestId("history-role").selectOption("broker");
      assert.equal(await rows.count(), 7);
      for (const state of ["created", "unfunded", "funded", "settled", "expired", "refunded"]) {
        assert.ok(await rows.filter({ has: desk.locator(`[data-testid="deal-status"][data-status="${state}"]`) }).count(), state);
      }
      await look(desk, "18-broker-history");
      await desk.getByTestId("history-role").selectOption("buyer");
      await text(desk, "No deals for this wallet and role");
      await look(desk, "19-history-role-filter");
      await desk.getByTestId("history-role").selectOption("broker");
      const row = desk.locator(`[data-deal-id="${parsed(immediate).id}"]`);
      await row.getByRole("button", { name: "Copy link" }).click();
      await text(desk, "Deal link copied");
      assert.equal(await desk.evaluate(() => navigator.clipboard.readText()), site.url + "/" + immediate);
      await look(desk, "20-history-link-copied");
      await row.getByRole("link", { name: "Duplicate terms" }).click();
      await text(desk, "Duplicate broker terms");
      await desk.getByTestId("broker-fee").getByText("0.246913 USDC", { exact: true }).waitFor();
      assert.notEqual(await desk.getByTestId("nonce").inputValue(), String(parsed(immediate).terms.nonce));
      await look(desk, "21-duplicate-terms");
      await desk.getByTestId("create-link").click();
      const duplicate = parsed(await desk.getByTestId("deal-link").getAttribute("href"));
      assert.notEqual(duplicate.id, parsed(immediate).id);
      assert.equal((await w.brokerDeals.read.getDeal(duplicate.id)).status, 0n);
      assert.equal((await w.brokerDeals.read.getDeal(parsed(immediate).id)).status, 2n);
      await visit("#/v3/history", { wallet: wallet(w.other) }, async (page) => {
        await connect(page);
        await text(page, "No deals for this wallet and role");
        await look(page, "22-unrelated-wallet-history");
      });

      for (const [role, account, scene] of [["seller", w.seller, "29-seller-history"], ["buyer", w.buyer, "30-buyer-history"]]) {
        await visit("#/v3/history", { wallet: wallet(account) }, async (page) => {
          assert.equal(await page.evaluate(() => localStorage.length), 0);
          await connect(page);
          await page.getByTestId("history-role").selectOption(role);
          const liveRow = page.locator(`[data-deal-id="${parsed(live).id}"][data-status="funded"]`);
          await liveRow.getByText("Funding confirmed", { exact: false }).waitFor();
          const rows = page.locator(".broker-history-row");
          assert.equal(await rows.count(), 5, `the ${role} sees the five funded deals, without browser drafts`);
          for (const state of ["funded", "settled", "refunded", "expired"]) {
            assert.ok(await rows.and(page.locator(`[data-status="${state}"][data-roles="${role}"]`)).count(), state);
          }
          const key = historyKey(w.brokerDomain, account);
          const cached = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
          const ids = await rows.evaluateAll((items) => items.map((row) => row.dataset.dealId));
          assert.deepEqual(cached.records.map(({ id }) => id).sort(), ids.sort(), "only this role's onchain history was cached");
          assert.equal((await w.brokerDeals.read.getDeal(parsed(live).id)).status, 1n);
          console.log(`    HISTORY · fresh ${role} profile, empty localStorage, an unsettled funded deal verified onchain`);
          const payment = role === "buyer" ? ["Buyer pays", "124.074072 USDC", "Buyer receives"] : ["Seller net", "122.839506 USDC", "Allocation"];
          for (const label of payment) await liveRow.getByText(label, { exact: true }).waitFor();
          assert.equal(await page.getByRole("link", { name: "Duplicate terms" }).count(), 0);
          const { id: vestingId } = parsed(vesting);
          const grantRow = page.locator(`[data-deal-id="${vestingId}"]`);
          await grantRow.getByText(/Vesting grant #\d+/).waitFor();
          if (role === "seller") {
            const expiredRow = page.locator(`[data-deal-id="${parsed(expired).id}"]`);
            await expiredRow.getByText("Allocation in escrow", { exact: true }).waitFor();
            await expiredRow.getByText("Refund available").waitFor();
          } else {
            const { grantId } = await w.brokerDeals.read.getDeal(vestingId);
            const grant = await w.brokerDeals.read.getGrant(grantId);
            const current = BigInt(await w.chain.now());
            const vested = grant.allocation * (current - grant.start) / (grant.end - grant.start);
            const held = await w.fam.read.balanceOf(grant.custodian);
            for (const [label, units] of Object.entries({
              "Funded into grant vault": grant.allocation, "Still in grant vault": held, Vested: vested, Claimed: grant.claimed,
              Claimable: vested - grant.claimed,
            })) {
              const fact = grantRow.getByText(label, { exact: true }).locator("xpath=following-sibling::dd");
              assert.equal(await fact.innerText(), `${formatAmount(units, 18)} FAM`);
            }
            assert.equal(await grantRow.getByText("Buyer received", { exact: true }).count(), 0);
          }
          await look(page, scene);
        });
      }

      // Keep the deal funded through the history scenes, then actually submit its settlement during a connection failure.
      await w.usdc.as(w.buyer).approve(w.brokerDeals.address, -PAYMENT["buyer.USDC"]);
      await visit(live, { wallet: wallet(w.buyer) }, async (page) => {
        await status(page, "funded");
        await page.locator('[data-kind="funded"]').waitFor();
        await connect(page);
        let blocked = false;
        await page.route("**/rpc", (route) => {
          const request = route.request().postDataJSON();
          if (blocked && ["eth_getBlockByNumber", "eth_getTransactionReceipt"].includes(request.method)) {
            return route.fulfill({ json: { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Node temporarily unavailable." } } });
          }
          return route.continue();
        });
        const before = await w.holdings();
        await w.chain.rpc("evm_setAutomine", [false]);
        try {
          await primary(page, "Sign terms and settle");
          const pending = page.getByTestId("pending-transaction");
          await pending.waitFor();
          const hash = await pending.locator(".mono").innerText();
          assert.equal(await w.chain.rpc("eth_getTransactionReceipt", [hash]), null);
          blocked = true;
          await page.reload();
          await status(page, "unverified");
          await text(page, "Node temporarily unavailable.");
          await page.getByText("Refresh chain status to retry.", { exact: true }).waitFor();
          await page.getByRole("button", { name: "Stop waiting and refresh" }).waitFor();
          await page.getByRole("heading", { name: "Deal terms from the link" }).waitFor();
          await page.locator("#broker-exact-terms").getByText(parsed(live).id, { exact: true }).waitFor();
          assert.equal(await pending.locator(".mono").innerText(), hash);
          assert.equal(await page.getByRole("heading", { name: /receipts|payment split/i }).count(), 0);
          await look(page, "23-rpc-interruption");

          await w.chain.mine();
          blocked = false;
          await primary(page, "Refresh chain status");
          await status(page, "settled");
          await page.getByRole("heading", { name: "Confirmed payment split" }).waitFor();
          assert.equal(await page.locator('[data-kind="settled"]').getAttribute("data-tx"), hash);
          await moved(before, { ...PAYMENT, "escrow.FAM": -ALLOCATION, "buyer.FAM": ALLOCATION }, "settlement recovered after RPC outage");
          await look(page, "24-rpc-recovered");
        } finally {
          await w.chain.rpc("evm_setAutomine", [true]);
        }
      });

      for (const [scene, price, share, total, net, brokerFee, treasuryFee, pool] of fixtures) {
        const hash = await prepare({ price, share, brokerFee });
        await fund(hash);
        await visit(hash, { wallet: wallet(w.buyer) }, async (page) => {
          await status(page, "funded");
          await connect(page);
          const before = await w.holdings();
          await primary(page, "Sign terms and settle");
          await status(page, "settled");
          await page.getByRole("heading", { name: "Confirmed payment split" }).waitFor();
          const receipt = page.locator('[data-kind="settled"]');
          assert.equal((await w.chain.rpc("eth_getTransactionReceipt", [await receipt.getAttribute("data-tx")])).status, "0x1");
          for (const [field, raw] of Object.entries({ "agreed-quote": parsed(hash).terms.quote, "buyer-total": total,
            "seller-net": net, "broker-fee": brokerFee, "treasury-fee": treasuryFee, "fee-pool": pool })) {
            await page.getByTestId(field).getByText(usdc(raw), { exact: true }).waitFor();
          }
          const delta = { "buyer.USDC": -total, "seller.USDC": net, "treasury.USDC": treasuryFee, "buyer.FAM": ALLOCATION, "escrow.FAM": -ALLOCATION };
          if (brokerFee) delta["broker.USDC"] = brokerFee;
          await moved(before, delta, `${price} USDC at ${share} broker bps`);
          await look(page, scene);
        });
      }

      const interruptedDeal = await prepare();
      await fund(interruptedDeal);
      const beforeRace = await w.holdings();
      const asked = [];
      const racingWallet = wallet(w.buyer, async (request) => {
        if (request.method === "eth_signTypedData_v4") await w.brokerDeals.as(w.seller).refund(parsed(interruptedDeal).id);
        return null;
      }, asked);
      await visit(interruptedDeal, { wallet: racingWallet }, async (page) => {
        await status(page, "funded");
        await connect(page);
        await page.getByTestId("refund-window").waitFor();
        await primary(page, "Sign terms and settle");
        await refundShown(page);
        await text(page, "Ask the broker for a new deal link.");
        await page.locator('[data-kind="refunded"]').waitFor();
        assert.ok(!asked.includes("eth_sendTransaction"));
        assert.equal(await page.getByRole("button", { name: "Sign terms and settle" }).count(), 0);
        await moved(beforeRace, { "seller.FAM": ALLOCATION, "escrow.FAM": -ALLOCATION }, "seller refunds while buyer signs, zero deal payment or fees");
        await look(page, "34-refund-during-signing");
      });
    });
    console.log(`\nBroker deal replay verified at ${size.width} px · ${shots} screenshots.`);
    return shots;
  } finally {
    await site.close();
  }
}
