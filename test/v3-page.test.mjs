import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { brokerPeople, brokerWallet, deployBrokerStand } from "../scripts/lib/broker-stand.mjs";
import { browse, closeBrowser, DESKTOP, fits, PHONE, serve, until } from "../scripts/lib/site.mjs";
import { DAY, world } from "../scripts/lib/world.mjs";

after(closeBrowser);

const testId = (page, id) => page.getByTestId(id);
const status = (page, phase) => page.locator(`[data-testid="broker-status"][data-status="${phase}"]`).first().waitFor();
const ready = (page, id) => until(() => testId(page, id).isEnabled().catch(() => false), `${id} is ready`);
const awaitCount = (page, id) => testId(page, id).count();

async function matches(page, id, expected) {
  await until(async () => expected.test(await testId(page, id).first().innerText().catch(() => "")), `${id} matches ${expected}`);
}

async function screenshot(page, name, size) {
  assert.ok(await fits(page), `no horizontal overflow in ${name} at ${size.width}px`);
  const dir = process.env.BROKER_EVIDENCE_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}-${size.width}.jpg`), fullPage: true, quality: 83 });
}

async function makeProposal(page, w, delivery, hours = "24") {
  await page.getByTestId("broker-review").waitFor();
  for (const [id, value] of Object.entries({
    "broker-seller": brokerPeople.Seller, "broker-buyer": brokerPeople.Buyer, "broker-recipient": brokerPeople.Broker,
    "broker-base-token": w.fam.address, "broker-quote-token": w.usdc.address,
    "broker-allocation": "900.000000000000000001", "broker-quote": delivery ? "100000" : "123.456789",
    "broker-share": "20", "broker-expiry-hours": hours,
  })) await testId(page, id).fill(value);
  await testId(page, "broker-delivery").selectOption(String(delivery));
  await testId(page, "broker-review").click();
  await matches(page, "broker-cut", delivery ? /^200 USDC$/ : /^0\.246913 USDC$/);
  await testId(page, "broker-create").click();
  return testId(page, "broker-deal-link").getAttribute("href");
}

for (const size of [PHONE, DESKTOP]) {
  test(`broker, designated wallets and fresh previews at ${size.width}px`, async () => {
    const w = await world();
    const broker = await deployBrokerStand(w);
    const baseUnits = 900_000_000_000_000_000_001n;
    await w.fam.as(w.deployer).mint(brokerPeople.Seller, baseUnits * 5n);
    await w.usdc.as(w.deployer).mint(brokerPeople.Buyer, 250_000n * 10n ** 6n);
    const site = await serve(w, { contractV3: broker.address, fromBlockV3: 0, explorerUrl: "https://example.test" });
    const anotherBrowser = (hash, role, steps, wallet = role ? brokerWallet(w, role) : null) => browse(site, hash, { size, wallet }, steps);
    try {
      await anotherBrowser("#/v3/new", "Broker", async (brokerPage) => {
        const immediate = await makeProposal(brokerPage, w, 0);
        assert.ok(immediate.startsWith("#/v3/d/"));
        await brokerPage.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await testId(brokerPage, "copy-broker-link").click();
        assert.equal(await brokerPage.evaluate(() => navigator.clipboard.readText()), site.url + "/" + immediate);
        await screenshot(brokerPage, "01-proposal-and-link", size);

        await brokerPage.getByRole("link", { name: "Deal history" }).click();
        await testId(brokerPage, "broker-wallet").click();
        await status(brokerPage, "unfunded");
        assert.match(await testId(brokerPage, "broker-history-entry").innerText(), /Created in this browser/);
        await brokerPage.getByRole("link", { name: "Duplicate terms" }).click();
        await until(async () => (await testId(brokerPage, "broker-allocation").inputValue()) === "900.000000000000000001", "duplicate preserves exact allocation");
        await testId(brokerPage, "broker-review").click();
        await testId(brokerPage, "broker-create").click();
        const refunded = await testId(brokerPage, "broker-deal-link").getAttribute("href");
        assert.notEqual(refunded, immediate, "duplicating creates a fresh nonce");
        await brokerPage.getByRole("link", { name: "Prepare deal" }).click();
        const vesting = await makeProposal(brokerPage, w, 1);
        await brokerPage.getByRole("link", { name: "Prepare deal" }).click();
        const expired = await makeProposal(brokerPage, w, 0, "1");

        await anotherBrowser(immediate, null, async (page) => {
          await status(page, "unfunded");
          await matches(page, "broker-next", /buyer cannot settle until the named seller funds/i);
          assert.equal(await awaitCount(page, "broker-wallet"), 0);
          await screenshot(page, "02-wallet-free-unfunded", size);
        });

        await anotherBrowser(immediate, "Stranger", async (page) => {
          await status(page, "unfunded");
          await testId(page, "broker-wallet").click();
          await matches(page, "broker-next", /cannot take this step/);
          assert.equal(await awaitCount(page, "broker-fund"), 0);
          await page.getByRole("link", { name: "Deal history" }).click();
          await page.getByRole("heading", { name: "No broker deals yet" }).waitFor();
        });

        const seller = brokerWallet(w, "Seller");
        let rejectSignature = true;
        const sellerWithRejection = (request) => {
          if (rejectSignature && request.method === "eth_signTypedData_v4") {
            rejectSignature = false;
            return { error: { code: 4001, message: "User rejected signature" } };
          }
          return seller(request);
        };
        await anotherBrowser(immediate, "Seller", async (page) => {
          await testId(page, "broker-wallet").click();
          await ready(page, "broker-fund");
          await testId(page, "broker-fund").focus();
          await page.keyboard.press("Enter");
          await page.getByRole("alert").filter({ hasText: /declined in your wallet/ }).waitFor();
          await ready(page, "broker-fund");
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "broker-fund");
          await status(page, "unfunded");
          await screenshot(page, "03-signature-declined", size);
          await testId(page, "broker-fund").click();
          await status(page, "funded");
          await screenshot(page, "04-seller-funded", size);
        }, sellerWithRejection);
        await brokerPage.getByRole("link", { name: "Deal history" }).click();
        await status(brokerPage, "funded");

        await anotherBrowser(vesting, "Seller", async (page) => {
          await testId(page, "broker-wallet").click();
          await testId(page, "broker-fund").click();
          await status(page, "funded");
        });
        await anotherBrowser(refunded, "Seller", async (page) => {
          await testId(page, "broker-wallet").click();
          await testId(page, "broker-fund").click();
          await status(page, "funded");
          await testId(page, "broker-refund").click();
          await status(page, "refunded");
        });

        await anotherBrowser(vesting, null, async (page) => {
          await status(page, "funded");
          await page.getByText("New vesting grant", { exact: true }).first().waitFor();
          assert.equal(await awaitCount(page, "broker-settle"), 0);
          await screenshot(page, "05-fresh-buyer-preview", size);
        });

        const buyer = brokerWallet(w, "Buyer");
        let wrongChain = true;
        let rejectSettlement = true;
        const buyerWrongChain = (request) => {
          if (wrongChain && request.method === "eth_chainId") return { result: "0x1" };
          if (request.method === "wallet_switchEthereumChain") wrongChain = false;
          if (rejectSettlement && request.method === "eth_sendTransaction" && request.params[0]?.to?.toLowerCase() === broker.address.toLowerCase()) {
            rejectSettlement = false;
            return { error: { code: 4001, message: "User rejected settlement" } };
          }
          return buyer(request);
        };
        await anotherBrowser(immediate, "Buyer", async (page) => {
          await testId(page, "broker-wallet").click();
          await matches(page, "broker-next", /wallet is on chain 1/);
          assert.equal(await awaitCount(page, "broker-settle"), 0);
          await screenshot(page, "06-wrong-chain", size);
          await testId(page, "broker-wallet").click();
          await testId(page, "broker-settle").click();
          await page.getByRole("alert").filter({ hasText: /declined in your wallet.*approval already confirmed/ }).waitFor();
          await status(page, "funded");
          assert.equal(await w.usdc.read.balanceOf(brokerPeople.Broker), 0n);
          assert.equal(await w.usdc.read.balanceOf(w.treasury), 0n);
          await testId(page, "broker-settle").click();
          await status(page, "settled");
          const receipt = testId(page, "broker-settlement-receipt");
          await receipt.waitFor();
          const hash = await receipt.getAttribute("data-tx");
          const chainReceipt = await w.chain.rpc("eth_getTransactionReceipt", [hash]);
          assert.equal(chainReceipt.status, "0x1");
          assert.equal(chainReceipt.to.toLowerCase(), broker.address.toLowerCase());
          assert.equal(await receipt.getByRole("link").getAttribute("href"), `https://example.test/tx/${hash}`);
          assert.match(await receipt.innerText(), /Confirmed.*Block/);
          assert.match(await receipt.innerText(), /0\.246913 USDC/);
          await page.reload();
          await status(page, "settled");
          await receipt.waitFor();
          assert.equal(await receipt.getAttribute("data-tx"), hash);
          await screenshot(page, "07-reloaded-settlement-receipt", size);
        }, buyerWrongChain);

        await anotherBrowser(vesting, "Buyer", async (page) => {
          await testId(page, "broker-wallet").click();
          await testId(page, "broker-settle").click();
          await status(page, "settled");
          await page.getByRole("heading", { name: "Vesting grant #1" }).waitFor();
          await screenshot(page, "08-settled-vesting", size);
          await w.at(await w.chain.now() + 45 * DAY);
          await page.getByRole("button", { name: "Refresh chain data" }).click();
          await testId(page, "broker-claim").click();
          await until(async () => (await w.fam.read.balanceOf(brokerPeople.Buyer)) > baseUnits, "grant paid its buyer");
          await page.getByRole("link", { name: "Deal history" }).click();
          await page.getByTestId("broker-role-buyer").click();
          await until(async () => (await page.getByTestId("broker-history-entry").count()) === 3, "buyer sees the three funded deals");
        });

        await brokerPage.getByRole("button", { name: "Refresh history" }).click();
        await status(brokerPage, "expired");
        await status(brokerPage, "refunded");
        await until(async () => (await brokerPage.locator('[data-testid="broker-status"][data-status="settled"]').count()) === 2, "both receipts in broker history");
        const states = await brokerPage.getByTestId("broker-status").evaluateAll((nodes) => nodes.map((node) => node.dataset.status).sort());
        assert.deepEqual(states, ["expired", "refunded", "settled", "settled"]);
        assert.equal(await brokerPage.getByRole("link", { name: "Settlement receipt" }).count(), 2);
        await screenshot(brokerPage, "09-broker-history", size);
        await anotherBrowser("#/v3/history", "Broker", async (page) => {
          await testId(page, "broker-wallet").click();
          await until(async () => await testId(page, "broker-history-entry").count() === 3, "fresh broker history recovers only onchain deals");
          assert.equal(await page.getByText("Created in this browser", { exact: false }).count(), 0);
        });
        await anotherBrowser(expired, null, (page) => status(page, "expired"));
      });
    } finally {
      await site.close();
    }
  });
}
