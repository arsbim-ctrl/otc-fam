import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { CHAIN_ID } from "../.launchpad/checks/round-1/chain.mjs";
import { brokerWorld, demoPeople, demoWallet, signers } from "../scripts/lib/broker-world.mjs";
import { browse, closeBrowser, DESKTOP, fits, PHONE, serve, seen, until as waitUntil } from "../scripts/lib/site.mjs";

const target = process.env.BROKER_EVIDENCE;
if (target) mkdirSync(target, { recursive: true });
after(closeBrowser);
const primary = page => page.getByTestId("broker-primary");
const until = (probe, message) => waitUntil(probe, message, 60_000);
async function shows(page, id, predicate, expected) {
  let text;
  await until(async () => {
    text = await seen(page, id);
    return text !== null && predicate(text);
  }, () => `Expected ${expected} at ${id}, got ${JSON.stringify(text)}`);
}
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
const pendingRecord = page => page.evaluate(() => {
  const key = Object.keys(sessionStorage).find(key => key.startsWith("otcfam:v3:pending:"));
  return key ? JSON.parse(sessionStorage.getItem(key)) : null;
});

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

        await primary(page).click();
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

function fixtureTerms(w, now) {
  return {
    seller: demoPeople.Seller, buyer: demoPeople.Buyer, broker: demoPeople.Broker,
    baseToken: w.fam.address, quoteToken: w.usdc.address, allocation: 1000n, quote: 1000n,
    expiry: BigInt(now) + 600n, nonce: 999n, delivery: 0n,
    fixedStart: 0n, cliffSeconds: 0n, durationSeconds: 0n, brokerBps: 0n,
  };
}

async function fundedDeal(w, changes = {}) {
  const { Seller, Buyer } = demoPeople;
  const { dealIdOf, domainOf, pack } = await import("../web/v3.js");
  const domain = domainOf(CHAIN_ID, w.brokerDeals.address);
  const terms = { ...fixtureTerms(w, await w.chain.now()), ...changes };
  const types = { BrokerTerms: w.brokerDeals.interface.getFunction("fund").inputs[0].components.map(({ name, type }) => ({ name, type })) };
  await w.fam.as(Seller).approve(w.brokerDeals.address, terms.allocation);
  await w.brokerDeals.as(Seller).fund(terms, await signers.Seller.signTypedData(domain, types, terms));
  await w.usdc.as(Buyer).approve(w.brokerDeals.address, terms.quote + terms.quote / 200n);
  return { id: dealIdOf(domain, terms), path: `#/v3/d/${pack(domain, terms)}` };
}

for (const size of [PHONE, DESKTOP]) {
  test(`a returned hash survives reload with the nonce lookup stalled at ${size.width}px`, async () => {
    const w = await brokerWorld();
    const site = await serve(w, { ...w.brokerConfig, explorerUrl: "https://example.test" });
    const picture = pictures(size, "vesting");
    const buyer = demoWallet(w, "Buyer");
    const stall = Promise.withResolvers();
    let broadcastHash, broadcasts = 0, stalledLookup = false;
    try {
      const { path } = await fundedDeal(w, {
        allocation: 900_000_000_000_000_000_001n, quote: 123_456_789n, brokerBps: 2_000n,
        delivery: 1n, cliffSeconds: 2_592_000n, durationSeconds: 7_776_000n,
      });
      const publicRpc = w.chain.publicRpc;
      w.chain.publicRpc = async request => {
        if (broadcastHash && request.method === "eth_getTransactionByHash" && request.params[0] === broadcastHash) {
          stalledLookup = true;
          await stall.promise;
        }
        return publicRpc(request);
      };
      await browse(site, path, { size, wallet: async request => {
        if (broadcastHash && request.method === "eth_getTransactionByHash") await stall.promise;
        const response = await buyer(request);
        if (request.method === "eth_sendTransaction") {
          broadcastHash = response.result;
          broadcasts++;
        }
        return response;
      } }, async page => {
        await status(page, "Funded");
        await click(page, "Connect wallet");
        await shows(page, "broker-primary", text => text === "Sign and settle deal", "buyer can authorize settlement");
        await w.chain.rpc("evm_setAutomine", [false]);
        await primary(page).click();
        await until(() => broadcastHash, "the wallet returned the settlement hash");
        await until(async () => (await pendingRecord(page))?.hash === broadcastHash, "hash stored before the nonce read finishes");
        assert.equal((await pendingRecord(page)).nonce, null);
        await page.reload();
        await page.getByText("Submitted · awaiting network confirmation", { exact: false }).waitFor();
        await until(() => stalledLookup, "the transaction lookup is still stalled");
        assert.equal(await page.getByTestId("broker-pending-transaction").innerText(), broadcastHash);
        assert.ok(await primary(page).isDisabled());
        await primary(page).dispatchEvent("click");
        const check = page.getByTestId("broker-refresh");
        await check.focus();
        await page.keyboard.press("Enter");
        assert.equal(await check.evaluate(el => document.activeElement === el), true);
        assert.equal(await w.chain.rpc("eth_getTransactionReceipt", [broadcastHash]), null);
        assert.equal(broadcasts, 1);
        await picture(page, "07-reloaded-pending");
        await w.chain.mine();
        await w.chain.rpc("evm_setAutomine", [true]);
        stall.resolve();
        await status(page, "Settled");
        const receipt = page.getByTestId("broker-settlement-receipt");
        assert.equal(await receipt.getAttribute("data-tx"), broadcastHash);
        assert.equal((await w.chain.rpc("eth_getTransactionReceipt", [broadcastHash])).status, "0x1");
        assert.equal(await pendingRecord(page), null);
        assert.equal(broadcasts, 1);
      });
    } finally {
      stall.resolve();
      await site.close();
    }
  });
}

for (const size of [PHONE, DESKTOP]) {
  test(`fresh broker history retains its confirmed funding receipt through expiry and shows the refund at ${size.width}px`, async () => {
    const w = await brokerWorld();
    const explorerUrl = "https://example.test";
    const site = await serve(w, { ...w.brokerConfig, explorerUrl });
    const picture = pictures(size, "history");
    try {
      const { dealIdOf, domainOf, pack } = await import("../web/v3.js");
      const domain = domainOf(CHAIN_ID, w.brokerDeals.address);
      const terms = fixtureTerms(w, await w.chain.now());
      const id = dealIdOf(domain, terms);
      const funding = w.brokerDeals.interface.getEvent("BrokerDealFunded").topicHash;
      const refund = w.brokerDeals.interface.getEvent("BrokerDealRefunded").topicHash;
      async function chainReceipt(topic) {
        const [log] = await w.chain.rpc("eth_getLogs", [{ address: w.brokerDeals.address, topics: [topic, id], fromBlock: "earliest", toBlock: "latest" }]);
        assert.ok(log?.transactionHash, "found the event for this deployment and deal");
        const receipt = await w.chain.rpc("eth_getTransactionReceipt", [log.transactionHash]);
        assert.equal(receipt.status, "0x1");
        return receipt;
      }

      await browse(site, `#/v3/d/${pack(domain, terms)}`, { size, wallet: demoWallet(w, "Seller") }, async sellerPage => {
        await status(sellerPage, "Awaiting funding");
        await click(sellerPage, "Connect wallet");
        await primary(sellerPage).click();
        await shows(sellerPage, "broker-primary", text => text === "Sign and fund deal", "seller approval confirmed");
        await primary(sellerPage).click();
        await status(sellerPage, "Funded");

        const funded = await chainReceipt(funding);
        await browse(site, "#/v3/history", { size, wallet: demoWallet(w, "Broker") }, async page => {
          const role = page.getByTestId("broker-history-role");
          const connect = page.getByTestId("broker-history-connect");
          await connect.focus();
          await page.keyboard.press("Enter");
          const link = page.getByTestId(`broker-history-receipt-${id}`);
          await status(page, "Funded");
          assert.equal(await role.evaluate(el => document.activeElement === el), true);
          assert.equal(await page.getByText("Created in this browser").count(), 0);
          const receiptRow = link.locator("..");
          async function matchesReceipt(verb, receipt) {
            await link.waitFor();
            assert.equal(await link.innerText(), receipt.transactionHash);
            assert.equal(await link.getAttribute("href"), `${explorerUrl}/tx/${receipt.transactionHash}`);
            assert.match(await receiptRow.innerText(), new RegExp(`${verb} transaction · confirmed in block ${Number(receipt.blockNumber)}`));
          }
          await matchesReceipt("Funding", funded);
          await role.selectOption("seller");
          await page.getByTestId("broker-history-empty").waitFor();
          assert.equal(await link.count(), 0);
          await role.selectOption("broker");
          await status(page, "Funded");
          await link.focus();
          await picture(page, "01-funded");

          await w.at(Number(terms.expiry));
          await page.evaluate(() => dispatchEvent(new Event("focus")));
          await status(page, "Expired");
          await matchesReceipt("Funding", funded);
          assert.equal(await link.evaluate(el => document.activeElement === el), true);
          await picture(page, "02-expired");
          await sellerPage.getByTestId("broker-refresh").click();
          await status(sellerPage, "Expired");
          assert.match(await sellerPage.getByTestId("broker-status-reason").innerText(), /seller can refund/);
          await click(sellerPage, "Refund escrow");
          await status(sellerPage, "Refunded");

          const refunded = await chainReceipt(refund);
          const check = page.getByTestId("broker-history-refresh");
          await check.focus();
          await page.keyboard.press("Enter");
          await status(page, "Refunded");
          await matchesReceipt("Refund", refunded);
          assert.equal(await check.evaluate(el => document.activeElement === el), true);
          await picture(page, "03-refunded");
          assert.equal((await w.brokerDeals.read.getDeal(id)).status, 3n);
          assert.equal(await w.usdc.read.balanceOf(terms.broker), 0n);
        });
      });
    } finally {
      await site.close();
    }
  });
}

test("a mined replacement unlocks retry only after the exact transaction nonce is verified", async () => {
  const w = await brokerWorld();
  const site = await serve(w, w.brokerConfig);
  const { Buyer, Seller } = demoPeople;
  try {
    const { id, path } = await fundedDeal(w);

    const buyer = demoWallet(w, "Buyer");
    let broadcasts = 0;
    await browse(site, path, { wallet: async request => {
      if (request.method === "eth_sendTransaction") broadcasts++;
      return buyer(request);
    } }, async page => {
      await status(page, "Funded");
      await click(page, "Connect wallet");
      await shows(page, "broker-primary", text => text === "Sign and settle deal", "buyer can authorize settlement");
      await w.chain.rpc("evm_setAutomine", [false]);
      const priorNonce = await w.chain.rpc("eth_getTransactionCount", [Buyer, "latest"]);
      const prior = await w.chain.submit(Buyer, { to: Seller, nonce: priorNonce, gas: "0x5208", value: "0x0" });
      await primary(page).click();
      let record;
      await until(async () => (record = await pendingRecord(page))?.nonceVerified, "exact nonce persisted from the transaction");
      const submitted = await w.chain.rpc("eth_getTransactionByHash", [record.hash]);
      assert.equal(BigInt(record.nonce), BigInt(submitted.nonce));
      assert.equal(BigInt(record.nonce), BigInt(priorNonce) + 1n);
      await page.reload();
      await page.getByText("Submitted · awaiting network confirmation", { exact: false }).waitFor();
      assert.ok(await primary(page).isDisabled());

      const gasPrice = `0x${(BigInt(submitted.gasPrice) * 2n + 1n).toString(16)}`;
      const replacement = await w.chain.submit(Buyer, { to: Seller, nonce: submitted.nonce, gas: "0x5208", gasPrice, value: "0x0" });
      await w.chain.mine();
      await w.chain.rpc("evm_setAutomine", [true]);
      for (const hash of [prior, replacement]) assert.equal((await w.chain.rpc("eth_getTransactionReceipt", [hash])).status, "0x1");
      assert.equal(await w.chain.rpc("eth_getTransactionReceipt", [record.hash]), null);
      assert.equal(await w.chain.rpc("eth_getTransactionByHash", [record.hash]), null);
      const notice = page.getByText("Your wallet replaced the transaction.", { exact: false });
      await until(async () => {
        if (await notice.isVisible()) return true;
        await page.getByTestId("broker-refresh").click();
        return false;
      }, "the tracker observed the mined replacement");
      assert.equal(await pendingRecord(page), null);
      assert.equal((await w.brokerDeals.read.getDeal(id)).status, 1n);
      assert.equal(broadcasts, 1);
      await primary(page).click();
      await status(page, "Settled");
      assert.equal(broadcasts, 2, "only the buyer's explicit retry sent a second transaction");
    });
  } finally {
    await site.close();
  }
});
