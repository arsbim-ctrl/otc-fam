// web/v2.js writes the v2 contract's ABI by hand, and repeats its fee and vesting arithmetic so that the page can
// say before a press what the chain will do. Both must be what the compiled OtcDealsV2 says and does, and every
// error it can revert with must have words on the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { id, Interface } from "ethers";
import { explain } from "../web/eth.js";
import { explorerOf } from "../web/ui.js";
import { createDealData, DealsV2, FEE_BPS, fundedId, money, vestedAt } from "../web/v2.js";
import { ALLOCATION, artifacts, DAY, errors, world } from "./lib/v2-world.mjs";

const contract = new Interface(artifacts().OtcDealsV2.abi);

test("each selector and topic in web/v2.js is the keccak of the signature written next to it, and names something the contract has", () => {
  const pairs = [...readFileSync("web/v2.js", "utf8").matchAll(/"(0x[0-9a-f]{8}|0x[0-9a-f]{64})",? \/\/ (\w+\(.*\))$/gm)];
  assert.equal(pairs.length, 15, "the 10 calls and the 5 events");
  for (const [, hex, signature] of pairs) {
    assert.equal(hex, id(signature).slice(0, hex.length), signature);
    assert.ok(hex.length === 10 ? contract.getFunction(hex) : contract.getEvent(hex), `${signature} is in the contract`);
  }
});

test("every error OtcDealsV2 can revert with from the page has words there, and the words carry its arguments", () => {
  const source = readFileSync("web/eth.js", "utf8");
  // BadTreasury is the constructor's and NotDeals the vault's answer to a stranger: the page can meet neither.
  errors().forEachError((error) => ["BadTreasury", "NotDeals"].includes(error.name) || assert.ok(source.includes(`"${error.selector}": `), `${error.format()} has no reason in web/eth.js`));
  const buyer = "0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
  assert.equal(explain({ code: 3, data: contract.encodeErrorResult("NotBuyer", [7n, buyer]) }), `This deal is for ${buyer}: only that address can settle it.`);
  assert.match(explain({ code: -32000, data: { data: contract.encodeErrorResult("StartPassed", [7n]) } }), /fixed vesting start has passed/);
  assert.match(explain({ code: 3, data: contract.encodeErrorResult("NothingToClaim", [7n]) }), /nothing to claim yet/);
});

test("a transaction is looked up on the network's own explorer, or on the https address the site's config names, and nowhere else", () => {
  assert.equal(explorerOf({ chainId: 84532 }), "https://sepolia.basescan.org");
  assert.equal(explorerOf({ chainId: 8453 }), "https://basescan.org");
  assert.equal(explorerOf({ chainId: 31337 }), null, "a local chain has none");
  assert.equal(explorerOf({ chainId: 31337, explorerUrl: "https://explorer.example/" }), "https://explorer.example");
  for (const explorerUrl of ["javascript:alert(1)", "http://explorer.example", "https://explorer.example/\"onclick=\"x", 42, null]) {
    assert.equal(explorerOf({ chainId: 84532, explorerUrl }), "https://sepolia.basescan.org", `${explorerUrl} is not taken from a config`);
  }
});

test("the page's fee and vesting arithmetic is the contract's, to the last unit", async () => {
  const w = await world();
  assert.equal(await w.deals.read.FEE_BPS(), FEE_BPS);
  for (const quote of [1n, 199n, 200n, 201n, 123_456_789n, 10n ** 30n + 7n, 2n ** 255n]) {
    const { buyerFee, sellerFee } = await w.deals.read.fees(quote), m = money(quote);
    assert.deepEqual([m.buyerFee, m.sellerFee], [buyerFee, sellerFee], `fees on ${quote}`);
    assert.deepEqual([m.buyerTotal, m.sellerNet, m.feePool], [quote + buyerFee, quote - sellerFee, buyerFee + sellerFee]);
    assert.equal(m.buyerTotal, m.sellerNet + m.feePool);
  }
  const t = await w.vesting({ allocation: ALLOCATION + 1n, cliffSeconds: 7 * DAY, durationSeconds: 100 * DAY - 1 });
  const dealId = await w.fund(t);
  await w.settle(dealId, t);
  const grant = await w.deals.read.getGrant(dealId);
  for (const time of [grant.start, grant.cliff - 1n, grant.cliff, grant.cliff + 1n, grant.start + 4_321_987n, grant.end - 1n, grant.end, grant.end + 5n]) {
    await w.at(time);
    assert.equal(vestedAt(grant, time), await w.deals.read.vested(dealId), `vested ${time - grant.start} s after the start`);
  }
});

test("the page writes a deal's terms as the contract reads them, and reads a deal and its grant as the contract gives them", async () => {
  const w = await world();
  const t = await w.vesting({ fixedStart: (await w.chain.now()) + 3600 });
  const data = createDealData({ ...t, delivery: "vesting" });
  assert.equal(data, w.deals.interface.encodeFunctionData("createDeal", [t]));
  assert.throws(() => createDealData({ ...t, delivery: "existing" }), /not supported/, "no other delivery can be written");

  // A funded deal's number is read from the event that names its seller, whatever else the transaction carries.
  const topic = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`, funded = w.deals.interface.getEvent("DealFunded").topicHash;
  const log = (address, dealId, seller) => ({ address, topics: [funded, topic(dealId), topic(seller), topic(w.buyer)] });
  const bundled = { logs: [log(w.legacy.address, 9, w.seller), log(w.deals.address, 7, w.other), log(w.deals.address.toUpperCase().replace("0X", "0x"), 8, w.seller)] };
  assert.equal(fundedId(bundled, w.deals.address, w.seller), 8n, "not another contract's event, and not another seller's deal");
  assert.throws(() => fundedId(bundled, w.deals.address, w.buyer), /names no new deal of this wallet's/);
  await w.fam.as(w.deployer).mint(w.seller, t.allocation);
  await w.fam.as(w.seller).approve(w.deals.address, t.allocation);
  await w.chain.send(w.seller, { to: w.deals.address, data });
  await w.settle(1n, t);

  const chain = { call: (to, callData) => w.chain.rpc("eth_call", [{ to, data: callData }, "latest"]), rpc: w.chain.rpc, balanceOf: (token, owner) => w.fam.read.balanceOf(owner) };
  const page = new DealsV2(chain, w.deals.address);
  assert.equal((await page.setup()).treasury, w.treasury);
  const deal = await page.deal(1n), onChain = await w.deals.read.getDeal(1n);
  assert.deepEqual([deal.seller, deal.baseToken, deal.quoteToken, deal.buyer], [w.seller, t.baseToken, t.quoteToken, t.buyer].map((a) => a.toLowerCase()));
  assert.deepEqual([deal.allocation, deal.quote, deal.expiry, deal.delivery, deal.fixedStart, deal.cliffSeconds, deal.durationSeconds, deal.status, deal.grantId],
    [t.allocation, t.quote, t.expiry, "vesting", t.fixedStart, BigInt(t.cliffSeconds), BigInt(t.durationSeconds), "settled", onChain.grantId]);
  assert.equal((await page.deal(2n)).status, "none");
  const grant = await page.grant(1n), g = await w.deals.read.getGrant(1n);
  assert.deepEqual([grant.dealId, grant.token, grant.beneficiary, grant.custodian, grant.allocation, grant.start, grant.cliff, grant.end, grant.claimed, grant.vested, grant.claimable, grant.held],
    [1n, g.token.toLowerCase(), g.beneficiary.toLowerCase(), g.custodian.toLowerCase(), g.allocation, g.start, g.cliff, g.end, 0n, 0n, 0n, t.allocation]);
  assert.deepEqual((await page.history(1n)).map((e) => e.kind), ["funded", "granted", "settled"]);
  await assert.rejects(new DealsV2(chain, w.legacy.address).setup(), /no v2 deal contract/, "the round 1 contract is not taken for a v2 one");
});
