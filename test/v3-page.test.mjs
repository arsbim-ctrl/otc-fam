import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { CHAIN_ID } from "../.launchpad/checks/round-1/chain.mjs";
import { brokerWorld, demoPeople, demoWallet } from "../scripts/lib/broker-world.mjs";
import { browse, closeBrowser, DESKTOP, fits, PHONE, serve, shows } from "../scripts/lib/site.mjs";

const target = process.env.BROKER_EVIDENCE;
if (target) mkdirSync(target, { recursive: true });
after(closeBrowser);
const primary = page => page.getByTestId("broker-primary");
const status = async (page, expected) => {
  try {
    await shows(page, "broker-status", text => text === expected, expected);
  } catch (error) {
    throw new Error(`${error.message}\nPage: ${(await page.locator("main").innerText()).slice(0, 1200)}`);
  }
  assert.ok(await fits(page), `The ${expected} page fits its viewport`);
};
const withPath = (site, hash) => new URL(hash, site.url).hash;
const click = (page, text) => page.getByRole("button", { name: text, exact: true }).click();
const rejected = { error: { code: 4001, message: "User rejected the request" } };

function pictures(size, mode) {
  return async (page, name, focus) => {
    assert.ok(await fits(page), `${name} fits at ${size.width}px`);
    if (target) {
      if (focus) await focus.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(target, `${mode}-${name}-${size.width}.jpg`), quality: 76, fullPage: true });
    }
  };
}

for (const size of [PHONE, DESKTOP]) for (const mode of ["immediate", "vesting"]) {
  test(`broker link, immediate or vesting settlement, receipts and history: ${mode} at ${size.width}px`, async () => {
    const w = await brokerWorld();
    const site = await serve(w, { ...w.brokerConfig, explorerUrl: "https://example.test" });
    const picture = pictures(size, mode);
    let link, hash, id, settledHash;
    const broker = demoWallet(w, "Broker");
    const record = [];
    try {
      await browse(site, "#/v3/new", { size, wallet: async request => { record.push(request.method); return broker(request); } }, async page => {
        const input = name => page.getByTestId(`broker-input-${name}`);
        for (const [name, value] of Object.entries({
          broker: demoPeople.Broker, seller: demoPeople.Seller, buyer: demoPeople.Buyer,
          baseToken: w.fam.address, quoteToken: w.usdc.address, allocation: "900.000000000000000001", quote: "123.456789", share: "20",
        })) await input(name).fill(value);
        if (mode === "vesting") await input("delivery").selectOption("1");
        await shows(page, "brokerFee", text => text === "0.246913 USDC", "the exact rounded broker fee");
        await picture(page, "01-terms");
        await page.getByTestId("broker-create").click();
        await status(page, "Awaiting funding");
        link = page.url();
        hash = withPath(site, link);
        id = await page.getByTestId("broker-deal-id").innerText();
        assert.match(hash, /^#\/v3\/d\/[\w-]{683}$/);
        assert.match(id, /^0x[0-9a-f]{64}$/);
        assert.doesNotMatch(record.join(" "), /eth_(requestAccounts|signTypedData|sendTransaction)/);
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.getByTestId("broker-copy").click();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
        await page.getByRole("link", { name: "Deal history" }).click();
        await page.getByTestId("broker-history-connect").click();
        await status(page, "Awaiting funding");
        assert.ok(await page.getByText("Created in this browser").isVisible());
        await picture(page, "02-history-draft");
        await page.getByRole("link", { name: "Duplicate terms" }).click();
        await input("allocation").waitFor();
        assert.equal(await input("quote").inputValue(), "123.456789");
        await page.getByTestId("broker-create").click();
        await status(page, "Awaiting funding");
        assert.notEqual(await page.getByTestId("broker-deal-id").innerText(), id);
        assert.notEqual(page.url(), link);
      });

      const seller = demoWallet(w, "Seller");
      let reject = true;
      await browse(site, hash, { size, wallet: request => {
        if (request.method === "eth_signTypedData_v4" && reject) { reject = false; return rejected; }
        return seller(request);
      } }, async page => {
        await status(page, "Awaiting funding");
        await click(page, "Connect wallet");
        await primary(page).click();
        await shows(page, "broker-primary", text => text === "Sign and fund deal", "seller approval confirmed");
        await primary(page).focus();
        await page.keyboard.press("Enter");
        await page.getByRole("alert").filter({ hasText: "You declined in your wallet" }).waitFor();
        assert.equal(await primary(page).evaluate(el => document.activeElement === el), true);
        assert.equal((await w.brokerDeals.read.getDeal(id)).status, 0n);
        await picture(page, "03-rejected-signature");
        await primary(page).click();
        await status(page, "Funded");
        assert.ok(await page.locator("[data-kind=BrokerDealFunded]").isVisible());
        assert.ok(await page.getByRole("button", { name: "Refund escrow" }).isVisible());
      });

      await browse(site, hash, { size }, async page => {
        await status(page, "Funded");
        assert.match(await page.getByTestId("broker-delivery").innerText(), mode === "vesting" ? /funded vesting grant/ : /Immediate delivery/);
        assert.ok(await page.getByText("Wallet-free preview.", { exact: false }).isVisible());
        assert.ok(await page.getByText("Buyer wallet required", { exact: false }).isVisible());
        await picture(page, "04-wallet-free-buyer");
      });

      await browse(site, hash, { size, wallet: demoWallet(w, "Stranger") }, async page => {
        await status(page, "Funded");
        await click(page, "Connect wallet");
        await page.getByText("This wallet can inspect the deal.", { exact: false }).waitFor();
        assert.equal(await primary(page).count(), 0);
        if (mode === "immediate") await picture(page, "05-wrong-wallet");
        await page.getByRole("link", { name: "Deal history" }).click();
        await page.getByTestId("broker-history-role").selectOption("buyer");
        await page.getByTestId("broker-history-empty").waitFor();
      });

      const buyer = demoWallet(w, "Buyer");
      let walletChain = 1;
      const pauseForReload = mode === "vesting" && size.width === 390;
      await browse(site, hash, { size, wallet: request => {
        if (request.method === "eth_chainId") return { result: `0x${walletChain.toString(16)}` };
        if (request.method === "wallet_switchEthereumChain") walletChain = CHAIN_ID;
        return buyer(request);
      } }, async page => {
        await status(page, "Funded");
        await click(page, "Connect wallet");
        await shows(page, "broker-primary", text => text.startsWith("Switch to "), "chain mismatch is actionable");
        if (mode === "immediate") await picture(page, "06-wrong-chain");
        await primary(page).click();
        await shows(page, "broker-primary", text => text === "Approve 124.074072 USDC", "exact buyer approval");
        await primary(page).click();
        await shows(page, "broker-primary", text => text === "Sign and settle deal", "buyer approval confirmed");

        if (pauseForReload) await w.chain.rpc("evm_setAutomine", [false]);
        await primary(page).click();
        if (pauseForReload) {
          await page.getByText("Submitted · awaiting network confirmation", { exact: false }).waitFor();
          await page.reload();
          await page.getByText("Submitted · awaiting network confirmation", { exact: false }).waitFor();
          assert.ok(await primary(page).isDisabled());
          await picture(page, "07-reloaded-pending");
          await w.chain.mine();
          await w.chain.rpc("evm_setAutomine", [true]);
        }
        await status(page, "Settled");
        const receipt = page.getByTestId("broker-settlement-receipt");
        await receipt.waitFor();
        settledHash = await receipt.getAttribute("data-tx");
        const onchain = await w.chain.rpc("eth_getTransactionReceipt", [settledHash]);
        assert.equal(onchain.status, "0x1");
        assert.equal(await receipt.getByRole("link", { name: settledHash }).getAttribute("href"), `https://example.test/tx/${settledHash}`);
        assert.equal(await receipt.getByTestId("brokerFee").innerText(), "0.246913 USDC");
        assert.equal(await receipt.getByTestId("treasuryFee").innerText(), "0.987653 USDC");
        assert.equal(await receipt.getByTestId("sellerNet").innerText(), "122.839506 USDC");
        await page.reload();
        await status(page, "Settled");
        assert.equal(await page.getByTestId("broker-settlement-receipt").getAttribute("data-tx"), settledHash);
        await picture(page, "08-settled-receipt", receipt);
        const deal = await w.brokerDeals.read.getDeal(id);
        if (mode === "vesting") {
          const grant = await w.brokerDeals.read.getGrant(deal.grantId);
          assert.equal(await w.fam.read.balanceOf(grant.custodian), grant.allocation);
          assert.match(await page.getByTestId("broker-grant").innerText(), new RegExp(grant.custodian, "i"));
          await w.at(Number(grant.cliff));
          await page.getByTestId("broker-refresh").click();
          await page.getByTestId("broker-claim").click();
          await shows(page, "broker-claimed", text => text.startsWith("300"), "vesting claim reflected in grant");
          const claim = page.locator("[data-kind=BrokerGrantClaimed]");
          await claim.waitFor();
          const claimReceipt = await w.chain.rpc("eth_getTransactionReceipt", [await claim.getAttribute("data-tx")]);
          const at = BigInt((await w.chain.rpc("eth_getBlockByNumber", [claimReceipt.blockNumber, false])).timestamp);
          const expected = grant.allocation * (at - grant.start) / (grant.end - grant.start);
          assert.equal(await w.fam.read.balanceOf(demoPeople.Buyer), expected);
          assert.equal(await w.fam.read.balanceOf(grant.custodian), grant.allocation - expected);
          await picture(page, "09-grant-claimed");
        } else {
          assert.equal(await w.fam.read.balanceOf(demoPeople.Buyer), deal.terms.allocation);
        }
      });

      await browse(site, "#/v3/history", { size, wallet: demoWallet(w, "Broker") }, async page => {
        await page.getByTestId("broker-history-connect").click();
        await status(page, "Settled");
        assert.ok(await page.getByTestId(`broker-history-deal-${id}`).isVisible());
        assert.ok(await page.getByRole("link", { name: settledHash }).isVisible());
        await picture(page, "10-history-settled");
      });
    } finally {
      await site.close();
    }
  });
}

test("seller recovers expired escrow and its refund appears on a fresh broker history", async () => {
  const w = await brokerWorld();
  const site = await serve(w, w.brokerConfig);
  try {
    const { dealIdOf, domainOf, pack } = await import("../web/v3.js");
    const domain = domainOf(CHAIN_ID, w.brokerDeals.address);
    const terms = {
      seller: demoPeople.Seller, buyer: demoPeople.Buyer, broker: demoPeople.Broker,
      baseToken: w.fam.address, quoteToken: w.usdc.address, allocation: 1000n, quote: 1000n,
      expiry: BigInt(await w.chain.now()) + 600n, nonce: 999n, delivery: 0n,
      fixedStart: 0n, cliffSeconds: 0n, durationSeconds: 0n, brokerBps: 0n,
    };
    const id = dealIdOf(domain, terms);
    await browse(site, `#/v3/d/${pack(domain, terms)}`, { wallet: demoWallet(w, "Seller") }, async page => {
      await status(page, "Awaiting funding");
      await click(page, "Connect wallet");
      await primary(page).click();
      await shows(page, "broker-primary", text => text === "Sign and fund deal", "seller approval confirmed");
      await primary(page).click();
      await status(page, "Funded");
      await w.at(Number(terms.expiry));
      await page.getByTestId("broker-refresh").click();
      await status(page, "Expired");
      assert.match(await page.getByTestId("broker-status-reason").innerText(), /seller can refund/);
      await click(page, "Refund escrow");
      await status(page, "Refunded");
      assert.equal((await w.brokerDeals.read.getDeal(id)).status, 3n);
      assert.equal(await w.usdc.read.balanceOf(terms.broker), 0n);
    });
    await browse(site, "#/v3/history", { wallet: demoWallet(w, "Broker") }, async page => {
      await page.getByTestId("broker-history-connect").click();
      await status(page, "Refunded");
      assert.ok(await page.getByTestId(`broker-history-deal-${id}`).isVisible());
    });
  } finally {
    await site.close();
  }
});
