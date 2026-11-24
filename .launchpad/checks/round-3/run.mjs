import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_ID, contractAt, deploy, Reverted, startChain } from "../round-1/chain.mjs";
import { compile } from "../round-1/compile.mjs";
import { ROOT } from "../round-1/lib/entry.mjs";
import { harness } from "../round-1/lib/harness.mjs";

const toolsDir = process.env.LAUNCHPAD_SANDBOXED === "1" && existsSync("/tools/node_modules")
  ? "/tools/node_modules"
  : join(ROOT, "node_modules");
const { Wallet, TypedDataEncoder } = createRequire(join(toolsDir, "tools"))("ethers");
const names = JSON.parse(readFileSync(new URL("./check.json", import.meta.url))).tests;
const checksRoot = fileURLToPath(new URL("../", import.meta.url));
const { test, done } = harness();
const [seller, buyer, broker, other, treasury] = [1, 2, 3, 4, 5]
  .map(n => new Wallet("0x" + n.toString(16).padStart(64, "0")));
const wallets = [seller, buyer, broker, other, treasury];
const allocation = 900_000_000_000_000_000_001n;
const smallQuote = 123_456_789n;
const largeQuote = 100_000_000_000n;
const day = 86_400;
const funded = 1n, settled = 2n, refunded = 3n;
const address = wallet => wallet.address.toLowerCase();
let artifacts;

function load() {
  const { BrokerDeals } = compile(ROOT, "contracts/BrokerDeals.sol");
  assert.ok(BrokerDeals?.bytecode.length > 2, "Deployable BrokerDeals is required");
  const { IBrokerDeals } = compile(checksRoot, "round-3/IBrokerDeals.sol");
  const { FixtureToken } = compile(checksRoot, "round-2/FixtureToken.sol");
  const fields = IBrokerDeals.abi.find(item => item.name === "fund").inputs[0].components;
  return { BrokerDeals, IBrokerDeals, FixtureToken, types: {
    BrokerTerms: fields.map(({ name, type }) => ({ name, type })),
  } };
}

async function world({ quote = smallQuote, brokerBps = 2_000, vesting = false } = {}) {
  artifacts ??= load();
  const chain = await startChain(wallets.map(address));
  const { BrokerDeals, IBrokerDeals, FixtureToken, types } = artifacts;
  const entry = await deploy(chain, address(other), BrokerDeals, [treasury.address], { label: "BrokerDeals" });
  const deals = contractAt(chain, IBrokerDeals.abi, entry.address, { label: "BrokerDeals" });
  const base = await deploy(chain, address(other), FixtureToken, ["BASE", 18]);
  const payment = await deploy(chain, address(other), FixtureToken, ["USDC", 6]);
  const fee = quote / 200n;
  await base.as(address(other)).mint(seller.address, 2n * allocation);
  await base.as(address(seller)).approve(deals.address, 2n * allocation);
  await payment.as(address(other)).mint(buyer.address, 2n * (quote + fee));
  await payment.as(address(buyer)).approve(deals.address, 2n * (quote + fee));
  const terms = {
    seller: seller.address, buyer: buyer.address, baseToken: base.address, quoteToken: payment.address,
    allocation, quote, expiry: (await chain.now()) + day, nonce: 71n,
    delivery: vesting ? 1 : 0, fixedStart: 0, cliffSeconds: vesting ? 30 * day : 0,
    durationSeconds: vesting ? 90 * day : 0, broker: broker.address, brokerBps,
  };
  const domain = { name: "OTC.fam Broker Deals", version: "3", chainId: CHAIN_ID, verifyingContract: deals.address };
  return {
    chain, deals, base, payment, fee, terms, domain,
    id: TypedDataEncoder.hash(domain, types, terms),
    sign: (wallet, value = terms, scope = domain) => wallet.signTypedData(scope, types, value),
  };
}

function event(events, name) {
  const matches = events.filter(entry => entry.name === name);
  assert.equal(matches.length, 1, `Expected exactly one ${name} event`);
  return matches[0].args;
}

async function balances(w) {
  const owners = [...wallets.map(wallet => wallet.address), w.deals.address];
  return Promise.all([w.base, w.payment].map(token => Promise.all(owners.map(owner => token.read.balanceOf(owner)))));
}

async function fund(w) {
  const before = await balances(w);
  const events = await w.deals.as(address(seller)).fund(w.terms, await w.sign(seller));
  const data = event(events, "BrokerDealFunded");
  assert.equal(data.dealId, w.id);
  assert.equal(data.seller.toLowerCase(), address(seller));
  assert.equal(data.broker.toLowerCase(), address(broker));
  const deal = await w.deals.read.getDeal(w.id);
  assert.equal(deal.status, funded);
  assert.equal(deal.grantId, 0n);
  for (const [field, value] of Object.entries(w.terms)) {
    if (typeof value === "string") assert.equal(deal.terms[field].toLowerCase(), value.toLowerCase(), field);
    else assert.equal(deal.terms[field], BigInt(value), field);
  }
  const after = await balances(w);
  assert.deepEqual(after[1], before[1], "Funding must transfer no quote or fees");
  assert.equal(before[0][0] - after[0][0], allocation);
  assert.deepEqual(after[0].slice(1, 5), before[0].slice(1, 5));
  assert.equal(after[0][5] - before[0][5], allocation);
}

async function settle(w) {
  const before = await balances(w);
  const events = await w.deals.as(address(buyer)).settle(w.id, await w.sign(buyer));
  const data = event(events, "BrokerDealSettled");
  const brokerFee = (2n * w.fee * BigInt(w.terms.brokerBps)) / 10_000n;
  const treasuryFee = 2n * w.fee - brokerFee;
  assert.equal(data.dealId, w.id);
  assert.equal(data.buyer.toLowerCase(), address(buyer));
  assert.equal(data.buyerFee, w.fee);
  assert.equal(data.sellerFee, w.fee);
  assert.equal(data.brokerFee, brokerFee);
  assert.equal(data.treasuryFee, treasuryFee);
  const deal = await w.deals.read.getDeal(w.id);
  assert.equal(deal.status, settled);
  assert.equal(deal.grantId, data.grantId);
  const [base, payment] = await balances(w);
  assert.deepEqual(payment.map((value, i) => value - before[1][i]),
    [w.terms.quote - w.fee, -(w.terms.quote + w.fee), brokerFee, 0n, treasuryFee, 0n]);
  assert.deepEqual(base.map((value, i) => value - before[0][i]),
    [0n, w.terms.delivery === 0 ? allocation : 0n, 0n, 0n, 0n, -allocation]);
  return data.grantId;
}

await test(names[0], async () => {
  const w = await world();
  assert.equal((await w.deals.read.getDeal(w.id)).status, 0n);
  await fund(w);
  assert.equal(await settle(w), 0n);
});

await test(names[1], async () => {
  const w = await world();
  const { deals, terms, id, sign, domain, chain } = w;
  const sellerSig = await sign(seller);
  const buyerSig = await sign(buyer);
  const before = await balances(w);
  await assert.rejects(deals.as(address(buyer)).settle(id, buyerSig), Reverted);
  await assert.rejects(deals.as(address(broker)).fund(terms, sellerSig), Reverted);
  await assert.rejects(deals.as(address(seller)).fund({ ...terms, quote: terms.quote + 1n }, sellerSig), Reverted);
  for (const scope of [{ ...domain, chainId: CHAIN_ID + 1 }, { ...domain, verifyingContract: other.address }]) {
    await assert.rejects(deals.as(address(seller)).fund(terms, await sign(seller, terms, scope)), Reverted);
  }
  assert.deepEqual(await balances(w), before);
  await fund(w);
  const escrowed = await balances(w);
  await assert.rejects(deals.as(address(seller)).fund(terms, sellerSig), Reverted);
  const reused = { ...terms, quote: terms.quote + 1n };
  await assert.rejects(deals.as(address(seller)).fund(reused, await sign(seller, reused)), Reverted);
  await assert.rejects(deals.as(address(other)).settle(id, buyerSig), Reverted);
  await assert.rejects(deals.as(address(buyer)).settle(id, await sign(buyer, reused)), Reverted);
  await assert.rejects(deals.as(address(buyer)).settle(id, await sign(other)), Reverted);
  assert.deepEqual(await balances(w), escrowed);
  await chain.setNextTime(terms.expiry);
  await chain.mine();
  await assert.rejects(deals.as(address(buyer)).settle(id, buyerSig), Reverted);
  assert.equal((await deals.read.getDeal(id)).status, funded);
  assert.deepEqual(await balances(w), escrowed);
});

await test(names[2], async () => {
  for (const quote of [largeQuote, smallQuote]) {
    for (const brokerBps of [0, 2_000]) {
      const w = await world({ quote, brokerBps });
      await fund(w);
      assert.equal(await settle(w), 0n);
    }
  }
});

await test(names[3], async () => {
  const w = await world();
  const { base, deals, id, sign } = w;
  const before = await balances(w);
  await fund(w);
  await base.as(address(other)).setBlockedSender(deals.address);
  const escrowed = await balances(w);
  await assert.rejects(deals.as(address(buyer)).settle(id, await sign(buyer)), Reverted);
  assert.deepEqual(await balances(w), escrowed);
  assert.equal((await deals.read.getDeal(id)).status, funded);
  await base.as(address(other)).setBlockedSender("0x" + "00".repeat(20));
  await assert.rejects(deals.as(address(broker)).refund(id), Reverted);
  assert.equal(event(await deals.as(address(seller)).refund(id), "BrokerDealRefunded").dealId, id);
  assert.equal((await deals.read.getDeal(id)).status, refunded);
  await assert.rejects(deals.as(address(buyer)).settle(id, await sign(buyer)), Reverted);
  assert.deepEqual(await balances(w), before);
});

await test(names[4], async () => {
  const w = await world({ vesting: true });
  await fund(w);
  const grantId = await settle(w);
  const { deals, base, chain, id, sign } = w;
  assert.ok(grantId > 0n);
  const grant = await deals.read.getGrant(grantId);
  assert.equal(grant.beneficiary.toLowerCase(), address(buyer));
  assert.equal(grant.token.toLowerCase(), base.address.toLowerCase());
  assert.equal(grant.allocation, allocation);
  assert.equal(grant.claimed, 0n);
  assert.equal(grant.start, BigInt(await chain.now()));
  assert.equal(grant.cliff, grant.start + BigInt(w.terms.cliffSeconds));
  assert.equal(grant.end, grant.start + BigInt(w.terms.durationSeconds));
  assert.equal(await base.read.balanceOf(grant.custodian), allocation);
  const before = await balances(w);
  await assert.rejects(deals.as(address(buyer)).settle(id, await sign(buyer)), Reverted);
  await assert.rejects(deals.as(address(seller)).refund(id), Reverted);
  for (const [time, total] of [[grant.cliff, allocation / 3n], [grant.end, allocation]]) {
    await chain.setNextTime(Number(time));
    await deals.as(address(buyer)).claim(grantId);
    assert.equal(await base.read.balanceOf(buyer.address), total);
    assert.equal((await deals.read.getGrant(grantId)).claimed, total);
    assert.equal(await base.read.balanceOf(grant.custodian), allocation - total);
  }
  const after = await balances(w);
  assert.deepEqual(after[0].filter((_, i) => i !== 1), before[0].filter((_, i) => i !== 1));
  assert.deepEqual(after[1], before[1], "Claims must transfer no quote or fees");
});

done();
