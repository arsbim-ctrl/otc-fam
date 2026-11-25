import assert from "node:assert/strict";
import { after, test } from "node:test";
import { TypedDataEncoder } from "ethers";
import { CHAIN_ID, deploy, startChain } from "../.launchpad/checks/round-1/chain.mjs";
import { compileTokens } from "../.launchpad/checks/round-1/compile.mjs";
import { brokerPeople, brokerWallet, deployBrokerStand } from "../scripts/lib/broker-stand.mjs";
import { browse, closeBrowser, DESKTOP, fits, PHONE, serve, until } from "../scripts/lib/site.mjs";
import { DAY, PEOPLE, ZERO } from "../scripts/lib/world.mjs";
import { brokerMoney, linkPayload, typedTerms, V3_SELECT } from "../web/v3.js";

after(closeBrowser);

const allocation = 900_000_000_000_000_000_001n;
const price = 123_456_789n;
const id = (page, key) => page.getByTestId(`broker-${key}`);
const phase = (page, status) => page.locator(`[data-testid="broker-status"][data-status="${status}"]`).waitFor();
const alertWith = (page, text) => page.getByRole("alert").filter({ hasText: text }).waitFor();
const focused = (page, key) => page.evaluate((target) => document.activeElement?.dataset.testid === target, `broker-${key}`);
const passiveRefresh = (page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
const offline = ({ id }) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "Test RPC unavailable" } });

let tokenArtifact;

async function fixtures() {
  const { deployer, treasury } = PEOPLE;
  const chain = await startChain([deployer]);
  tokenArtifact ??= compileTokens().PlainToken;
  const fam = await deploy(chain, deployer, tokenArtifact, ["FAM", 18], { label: "FAM" });
  const usdc = await deploy(chain, deployer, tokenArtifact, ["USDC", 6], { label: "USDC" });
  const w = { chain, deployer, treasury, fam, usdc, legacy: { address: ZERO }, deals: { address: ZERO } };
  const publicRpc = chain.publicRpc;
  let rpcFault;
  w.chain.publicRpc = (request) => rpcFault?.(request) ?? publicRpc(request);
  const fault = (callback) => { rpcFault = callback; };
  const broker = await deployBrokerStand(w);
  const { Seller: seller, Buyer: buyer, Broker: recipient, Stranger: stranger } = brokerPeople;
  const domain = { name: "OTC.fam Broker Deals", version: "3", chainId: CHAIN_ID, verifyingContract: broker.address.toLowerCase() };
  const fees = brokerMoney(price, 2_000n);
  await w.fam.as(w.deployer).mint(seller, 5n * allocation);
  await w.usdc.as(w.deployer).mint(buyer, 5n * fees.buyerTotal);
  await w.usdc.as(buyer).approve(broker.address, 5n * fees.buyerTotal);

  async function makeDeal(nonce, vesting = false) {
    const terms = {
      seller, buyer, broker: recipient, allocation, quote: price, brokerBps: 2_000n, nonce: BigInt(nonce),
      baseToken: w.fam.address, quoteToken: w.usdc.address, expiry: BigInt(await w.chain.now() + DAY),
      delivery: vesting ? 1n : 0n, fixedStart: 0n, cliffSeconds: vesting ? 30n * BigInt(DAY) : 0n,
      durationSeconds: vesting ? 90n * BigInt(DAY) : 0n,
    };
    const typed = typedTerms(domain, terms);
    const digest = TypedDataEncoder.hash(domain, { BrokerTerms: typed.types.BrokerTerms }, typed.message);
    async function sign(role, account) {
      const wallet = brokerWallet(w, role);
      await wallet({ method: "eth_requestAccounts" });
      const answer = await wallet({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typed)] });
      assert.ok(answer.result, answer.error?.message);
      return answer.result;
    }
    await w.fam.as(seller).approve(broker.address, allocation);
    await broker.as(seller).fund(terms, await sign("Seller", seller));
    return {
      hash: `#/v3/d/${linkPayload(domain, terms)}`,
      address: digest,
      async settle() { await broker.as(buyer).settle(digest, await sign("Buyer", buyer)); },
      async settleData() {
        return broker.interface.encodeFunctionData("settle", [digest, await sign("Buyer", buyer)]);
      },
    };
  }

  const site = await serve(w, { contractV3: broker.address, fromBlockV3: 0 });
  async function balances(extra = {}) {
    const owners = { seller, buyer, broker: recipient, treasury: w.treasury, escrow: broker.address, stranger, ...extra };
    const entries = await Promise.all(Object.entries(owners).flatMap(([account, address]) =>
      [[w.fam, "base"], [w.usdc, "quote"]].map(async ([token, side]) => [`${account}.${side}`, await token.read.balanceOf(address)])));
    return Object.fromEntries(entries);
  }

  return { w, broker, fees, site, makeDeal, balances, fault };
}

function deltas(before, after) {
  return Object.fromEntries(Object.entries(before).map(([key, value]) => [key, after[key] - value]));
}

function output(width, name, values) {
  console.log(`[${width}px] ${name} (raw units) ${JSON.stringify(values, (_, value) => typeof value === "bigint" ? String(value) : value)}`);
}

function watchedWallet(w, role, beforeRequest) {
  const answer = brokerWallet(w, role);
  return (request) => beforeRequest(request, answer) ?? answer(request);
}

async function connected(wallet) {
  assert.ok((await wallet({ method: "eth_requestAccounts" })).result?.length);
  return wallet;
}

function metadataOutage(quote, broker, state) {
  return (request) => {
    if (request.method !== "eth_call") return;
    const call = request.params[0];
    const address = call.to?.toLowerCase();
    const selector = call.data?.slice(0, 10);
    if ((address === quote.toLowerCase() || address === state.base?.toLowerCase()) &&
        ["0x313ce567", "0x95d89b41"].includes(selector)) return offline(request);
    if (state.noDeal && address === broker.toLowerCase() && selector === V3_SELECT.getDeal) return offline(request);
  };
}

for (const size of [PHONE, DESKTOP]) {
  test(`verified refund and grant claim during token metadata outage at ${size.width}px`, async () => {
    const { w, broker, site, makeDeal, balances, fault } = await fixtures();
    try {
      const deal = await makeDeal(1);
      const before = await balances();
      const rpc = {};
      fault(metadataOutage(w.usdc.address, broker.address, rpc));
      for (const [role, wrongNetwork] of [["Stranger", false], ["Seller", true], ["Buyer", false]]) {
        let sends = 0;
        const wallet = watchedWallet(w, role, (request) => {
          if (request.method === "eth_sendTransaction") sends++;
          if (wrongNetwork && request.method === "eth_chainId") return { result: "0x1" };
        });
        await browse(site, deal.hash, { size, wallet: await connected(wallet), waitUntil: "commit" }, async (page) => {
          await phase(page, "funded");
          await id(page, "metadata").waitFor();
          assert.equal(await id(page, "refund").count(), 0);
          if (wrongNetwork) await page.getByRole("button", { name: /Switch to/ }).waitFor();
          if (role === "Buyer") {
            await id(page, "settle").waitFor();
            assert.equal(await id(page, "settle").isEnabled(), false);
          }
          assert.equal(sends, 0);
        });
      }
      assert.deepEqual(await balances(), before, "unrelated and wrong-network wallets move no balances");

      let sends = 0;
      const seller = watchedWallet(w, "Seller", (request) => {
        if (request.method === "eth_sendTransaction") sends++;
      });
      await browse(site, deal.hash, { size, wallet: await connected(seller), waitUntil: "commit" }, async (page) => {
        await phase(page, "funded");
        await page.getByText(`${price} raw units`, { exact: true }).waitFor();
        const refund = id(page, "refund");
        await refund.focus();
        assert.equal(await refund.isEnabled(), true);
        assert.ok(await fits(page));
        await page.evaluate(() => { window.savedAlert = document.querySelector('[data-testid="broker-errors"]'); });
        rpc.noDeal = true;
        await passiveRefresh(page);
        await alertWith(page, /Deal state could not be verified/);
        assert.equal(await refund.isEnabled(), false);
        assert.equal(await focused(page, "refund"), true);
        assert.ok(await page.evaluate(() => window.savedAlert === document.querySelector('[role="alert"][aria-atomic="true"]')));
        await page.keyboard.press("Enter");
        assert.equal(sends, 0);
        rpc.noDeal = false;
        await passiveRefresh(page);
        await until(() => refund.isEnabled(), "refund becomes available after authoritative state recovers");
        assert.equal(await focused(page, "refund"), true);
        await page.keyboard.press("Enter");
        await phase(page, "refunded");
        assert.equal(sends, 1);
      });
      const refundDelta = deltas(before, await balances());
      for (const [account, delta] of Object.entries(refundDelta)) {
        assert.equal(delta, account === "seller.base" ? allocation : account === "escrow.base" ? -allocation : 0n, account);
      }
      output(size.width, "verified refund during quote metadata outage", refundDelta);

      const vesting = await makeDeal(2, true);
      await vesting.settle();
      const dealData = await broker.read.getDeal(vesting.address);
      const grant = await broker.read.getGrant(dealData.grantId);
      const at = Number(grant.start) + 45 * DAY;
      await w.chain.setNextTime(at);
      await w.chain.mine();
      const claimable = await broker.read.claimable(dealData.grantId);
      const vault = { vault: grant.custodian };
      const preClaim = await balances(vault);
      rpc.base = w.fam.address;
      await browse(site, vesting.hash, { size, wallet: await connected(brokerWallet(w, "Buyer")), waitUntil: "commit" }, async (page) => {
        await phase(page, "settled");
        await page.getByText(`${claimable} raw units`, { exact: true }).waitFor();
        await w.chain.setNextTime(at);
        await id(page, "claim").press("Enter");
        await page.getByText("Claiming vested tokens confirmed.", { exact: true }).waitFor();
      });
      const claimDelta = deltas(preClaim, await balances(vault));
      assert.equal(claimable, allocation / 2n);
      for (const [account, delta] of Object.entries(claimDelta)) {
        assert.equal(delta, account === "buyer.base" ? claimable : account === "vault.base" ? -claimable : 0n, account);
      }
      output(size.width, "verified grant claim during metadata outage", claimDelta);
    } finally {
      await site.close();
    }
  });

  test(`broadcast recovery avoids duplicate sends and verifies receipt identity at ${size.width}px`, async () => {
    const { w, fees, site, makeDeal, balances, fault } = await fixtures();
    try {
      const deal = await makeDeal(1);
      const before = await balances();
      let broadcastHash;
      let sends = 0;
      let receiptReads = 0;
      let outage = true;
      const wallet = watchedWallet(w, "Buyer", (request, answer) => {
        if (request.method !== "eth_sendTransaction") return;
        sends++;
        return answer(request).then((response) => {
          assert.ok(response.result, response.error?.message);
          broadcastHash = response.result;
          return response;
        });
      });
      await w.chain.rpc("evm_setAutomine", [false]);
      fault((request) => {
        if (request.method !== "eth_getTransactionReceipt" || request.params[0] !== broadcastHash) return;
        receiptReads++;
        if (outage) return offline(request);
      });
      await browse(site, deal.hash, { size, wallet: await connected(wallet), waitUntil: "commit" }, async (page) => {
        await phase(page, "funded");
        const settle = id(page, "settle");
        await settle.press("Enter");
        await alertWith(page, /submitted transaction could not be checked/);
        assert.equal(await settle.isEnabled(), false);
        assert.equal(await focused(page, "settle"), true);
        await page.keyboard.press("Enter");
        assert.equal(sends, 1);
        assert.equal(await w.chain.rpc("eth_getTransactionReceipt", [broadcastHash]), null);
        assert.deepEqual(await balances(), before);

        await page.reload({ waitUntil: "commit" });
        await alertWith(page, /submitted transaction could not be checked/);
        assert.equal(await settle.isEnabled(), false);
        assert.match(await id(page, "pending").innerText(), new RegExp(broadcastHash));
        const previousReads = receiptReads;
        outage = false;
        await page.getByRole("button", { name: "Check transaction" }).press("Enter");
        await page.getByText(/submitted transaction has no receipt yet/i).waitFor();
        assert.ok(receiptReads > previousReads, "recovery button made a receipt query");
        await settle.focus();
        await page.keyboard.press("Enter");
        assert.equal(sends, 1);
        const refresh = id(page, "refresh");
        await refresh.focus();
        await passiveRefresh(page);
        assert.ok(await fits(page));
        outage = true;
        await w.chain.mine();
        await refresh.press("Enter");
        await phase(page, "settled");
        const receipt = id(page, "settlement-receipt");
        await receipt.waitFor();
        assert.equal(await receipt.getAttribute("data-tx"), broadcastHash);
        assert.equal(await focused(page, "refresh"), true);
        assert.equal(await settle.count(), 0);
        assert.equal(sends, 1);
      });
      fault(null);
      await w.chain.rpc("evm_setAutomine", [true]);
      const settlementDelta = deltas(before, await balances());
      for (const [account, delta] of Object.entries(settlementDelta)) {
        const expected = {
          "buyer.base": allocation, "escrow.base": -allocation, "buyer.quote": -fees.buyerTotal,
          "seller.quote": fees.sellerNet, "broker.quote": fees.brokerFee, "treasury.quote": fees.treasuryFee,
        };
        assert.equal(delta, expected[account] ?? 0n, account);
      }
      output(size.width, "one settlement after receipt error, unmined reload and recovery", settlementDelta);

      const target = await makeDeal(2);
      const other = await makeDeal(3);
      const otherData = await other.settleData();
      let unrelatedHash;
      const unrelated = watchedWallet(w, "Buyer", (request, answer) => {
        if (request.method !== "eth_sendTransaction") return;
        return answer({ ...request, params: [{ ...request.params[0], data: otherData }] }).then((response) => {
          unrelatedHash = response.result;
          return response;
        });
      });
      await browse(site, target.hash, { size, wallet: await connected(unrelated), waitUntil: "commit" }, async (page) => {
        await phase(page, "funded");
        await id(page, "settle").press("Enter");
        await alertWith(page, /receipt does not match this action/);
        assert.equal(await id(page, "settle").isEnabled(), false);
        assert.equal(await id(page, "settlement-receipt").count(), 0);
        await target.settle();
        await id(page, "refresh").press("Enter");
        await phase(page, "settled");
        await page.getByText(/submitted hash is still unconfirmed/).waitFor();
        const receipt = await id(page, "settlement-receipt").getAttribute("data-tx");
        assert.notEqual(receipt, unrelatedHash);
        assert.equal(await page.getByText("Settling deal confirmed.", { exact: true }).count(), 0);
        assert.equal(await id(page, "pending").count(), 0);
        console.log(`[${size.width}px] unrelated transaction rejected as confirmation; canonical settlement receipt reconciled`);
      });
    } finally {
      await site.close();
    }
  });
}
