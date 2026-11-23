import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractAt, deploy, Reverted, startChain } from "../round-1/chain.mjs";
import { compile } from "../round-1/compile.mjs";
import { ROOT } from "../round-1/lib/entry.mjs";
import { harness } from "../round-1/lib/harness.mjs";

const names = JSON.parse(readFileSync(new URL("./check.json", import.meta.url))).tests;
const checksRoot = fileURLToPath(new URL("../", import.meta.url));
const { test, done } = harness();
const ZERO = "0x" + "00".repeat(20);
const [deployer, seller, buyer, other, treasury] = ["11", "22", "33", "44", "55"]
  .map(byte => "0x" + byte.repeat(20));
const QUOTE = 123_456_789n;
const ALLOCATION = 1_000_000n * 10n ** 18n;
const FUNDED = 1n, SETTLED = 2n, CANCELLED = 3n;
const DAY = 86_400;
let artifacts;

function load() {
  const { OtcDealsV2 } = compile(ROOT, "contracts/OtcDealsV2.sol");
  assert.ok(OtcDealsV2?.bytecode.length > 2, "Deployable OtcDealsV2 is required");
  const { IOtcDealsV2 } = compile(checksRoot, "round-2/IOtcDealsV2.sol");
  const { FixtureToken } = compile(checksRoot, "round-2/FixtureToken.sol");
  return { OtcDealsV2, IOtcDealsV2, FixtureToken };
}

async function world({ allocation = ALLOCATION, quote = QUOTE, vesting = true, future = false, life = DAY } = {}) {
  artifacts ??= load();
  const chain = await startChain([deployer, seller, buyer, other, treasury]);
  const { OtcDealsV2, IOtcDealsV2, FixtureToken } = artifacts;
  const entry = await deploy(chain, deployer, OtcDealsV2, [treasury], { label: "OtcDealsV2" });
  const deals = contractAt(chain, IOtcDealsV2.abi, entry.address, { label: "OtcDealsV2" });
  assert.equal((await deals.read.treasury()).toLowerCase(), treasury);
  const base = await deploy(chain, deployer, FixtureToken, ["BASE", 18]);
  const payment = await deploy(chain, deployer, FixtureToken, ["USDC", 6]);
  const fee = quote / 200n;
  await base.as(deployer).mint(seller, allocation);
  for (const wallet of [buyer, other]) {
    await payment.as(deployer).mint(wallet, 2n * (quote + fee));
    await payment.as(wallet).approve(deals.address, 2n * (quote + fee));
  }
  await base.as(seller).approve(deals.address, allocation);
  const now = await chain.now();
  const terms = {
    baseToken: base.address, quoteToken: payment.address, buyer, allocation, quote,
    expiry: now + life, delivery: vesting ? 1 : 0, fixedStart: future ? now + 3600 : 0,
    cliffSeconds: vesting ? 30 * DAY : 0, durationSeconds: vesting ? 90 * DAY : 0,
  };
  return { chain, deals, base, payment, fee, terms };
}

function event(events, name) {
  const matches = events.filter(entry => entry.name === name);
  assert.equal(matches.length, 1, `Expected exactly one ${name} event`);
  return matches[0].args;
}

async function fund(w) {
  const { deals, terms, base } = w;
  const funded = event(await deals.as(seller).createDeal(terms), "DealFunded");
  assert.ok(funded.dealId > 0n);
  assert.equal(funded.seller.toLowerCase(), seller);
  assert.equal(funded.buyer.toLowerCase(), buyer);
  const deal = await deals.read.getDeal(funded.dealId);
  assert.equal(deal.status, FUNDED);
  assert.equal(deal.grantId, 0n);
  assert.equal(deal.seller.toLowerCase(), seller);
  for (const [field, value] of Object.entries(terms)) {
    const expected = typeof value === "number" ? BigInt(value) : value;
    assert.equal(typeof expected === "string" ? deal.terms[field].toLowerCase() : deal.terms[field],
      typeof expected === "string" ? expected.toLowerCase() : expected, field);
  }
  assert.equal(await base.read.balanceOf(deals.address), terms.allocation);
  assert.equal(await base.read.balanceOf(seller), 0n);
  return funded.dealId;
}

async function balances(w) {
  const wallets = [seller, buyer, other, treasury, w.deals.address];
  return Promise.all([w.base, w.payment].map(token =>
    Promise.all(wallets.map(wallet => token.read.balanceOf(wallet)))));
}

async function settle(w, id) {
  const before = await balances(w);
  const events = await w.deals.as(buyer).fill(id);
  const settled = event(events, "DealSettled");
  assert.equal(settled.dealId, id);
  assert.equal(settled.buyerFee, w.fee);
  assert.equal(settled.sellerFee, w.fee);
  const deal = await w.deals.read.getDeal(id);
  assert.equal(deal.status, SETTLED);
  assert.equal(deal.grantId, settled.grantId);
  const [base, payment] = await balances(w);
  const delta = payment.map((amount, i) => amount - before[1][i]);
  assert.deepEqual(delta, [w.terms.quote - w.fee, -(w.terms.quote + w.fee), 0n, 2n * w.fee, 0n]);
  assert.deepEqual(base.slice(0, 4), [0n, w.terms.delivery === 0 ? w.terms.allocation : 0n, 0n, 0n]);
  return { grantId: settled.grantId, events };
}

async function createGrant(w) {
  const id = await fund(w);
  const { grantId, events } = await settle(w, id);
  assert.ok(grantId > 0n);
  const created = event(events, "GrantCreated");
  assert.equal(created.grantId, grantId);
  assert.equal(created.dealId, id);
  assert.equal(created.beneficiary.toLowerCase(), buyer);
  const start = BigInt(w.terms.fixedStart || await w.chain.now());
  const grant = await w.deals.read.getGrant(grantId);
  assert.equal(grant.dealId, id);
  assert.equal(grant.token.toLowerCase(), w.base.address.toLowerCase());
  assert.equal(grant.beneficiary.toLowerCase(), buyer);
  assert.equal(grant.allocation, w.terms.allocation);
  assert.equal(grant.claimed, 0n);
  assert.equal(grant.start, start);
  assert.equal(grant.cliff, start + BigInt(w.terms.cliffSeconds));
  assert.equal(grant.end, start + BigInt(w.terms.durationSeconds));
  assert.notEqual(grant.custodian, ZERO);
  assert.equal(await w.base.read.balanceOf(grant.custodian), grant.allocation);
  return { grant, grantId, id };
}

async function warp(chain, time) {
  await chain.setNextTime(Number(time));
  await chain.mine();
  assert.equal(BigInt(await chain.now()), time);
}

async function payout(w, grantId, sender, expected) {
  const grant = await w.deals.read.getGrant(grantId);
  const before = await balances(w);
  const paid = event(await w.deals.as(sender).claim(grantId), "GrantClaimed");
  assert.equal(paid.grantId, grantId);
  assert.equal(paid.beneficiary.toLowerCase(), buyer);
  assert.equal(paid.amount, expected);
  const after = await balances(w);
  assert.equal(after[0][1] - before[0][1], expected);
  assert.equal(after[0][2], before[0][2]);
  assert.deepEqual(after[1], before[1]);
  assert.equal((await w.deals.read.getGrant(grantId)).claimed, grant.claimed + expected);
  assert.equal(await w.base.read.balanceOf(grant.custodian), grant.allocation - grant.claimed - expected);
}

await test(names[0], async () => {
  for (const quote of [QUOTE, 199n, 200n]) {
    const w = await world({ vesting: false, quote });
    const id = await fund(w);
    const { grantId, events } = await settle(w, id);
    assert.equal(grantId, 0n);
    assert.ok(!events.some(entry => entry.name === "GrantCreated"));
    assert.equal(await w.base.read.balanceOf(w.deals.address), 0n);
  }
});

await test(names[1], async () => {
  await createGrant(await world());
});

await test(names[2], async () => {
  const w = await world({ vesting: false });
  const id = await fund(w);
  await w.base.as(deployer).setBlockedSender(w.deals.address);
  const before = await balances(w);
  await assert.rejects(w.deals.as(buyer).fill(id), Reverted);
  assert.deepEqual(await balances(w), before);
  const deal = await w.deals.read.getDeal(id);
  assert.equal(deal.status, FUNDED);
  assert.equal(deal.grantId, 0n);
  await w.base.as(deployer).setBlockedSender(ZERO);
  await settle(w, id);
});

await test(names[3], async () => {
  const w = await world({ future: true });
  const { grant: { start, cliff, end, allocation }, grantId } = await createGrant(w);
  for (const [time, expected] of [
    [start - 1n, 0n], [start, 0n], [cliff - 1n, 0n], [cliff, allocation / 3n],
    [(start + end) / 2n, allocation / 2n],
    [end - 1n, allocation * (end - start - 1n) / (end - start)],
    [end, allocation], [end + 1n, allocation],
  ]) {
    await warp(w.chain, time);
    assert.equal(await w.deals.read.vested(grantId), expected, `vested at ${time - start}s`);
    assert.equal(await w.deals.read.claimable(grantId), expected);
  }
});

await test(names[4], async () => {
  for (const allocation of [1n, ALLOCATION + 1n, 1n << 240n]) {
    const w = await world({ allocation, future: true });
    const { grant: { cliff, end }, grantId } = await createGrant(w);
    await warp(w.chain, cliff);
    const first = allocation / 3n;
    if (first > 0n) await payout(w, grantId, buyer, first);
    assert.equal(await w.deals.read.claimable(grantId), 0n);
    await warp(w.chain, end);
    await payout(w, grantId, buyer, allocation - first);
    assert.equal(await w.deals.read.claimable(grantId), 0n);
    assert.equal(await w.base.read.balanceOf(buyer), allocation);
  }
});

await test(names[5], async () => {
  const w = await world({ future: true });
  const { grant: { end, allocation }, grantId, id } = await createGrant(w);
  const settled = await balances(w);
  await assert.rejects(w.deals.as(buyer).fill(id), Reverted);
  await assert.rejects(w.deals.as(seller).cancel(id), Reverted);
  assert.deepEqual(await balances(w), settled);
  await warp(w.chain, end);
  const trigger = await w.deals.as(other).claim(grantId).then(events => ({ events }), error => ({ error }));
  if (trigger.error) {
    assert.ok(trigger.error instanceof Reverted);
    assert.deepEqual(await balances(w), settled);
    await payout(w, grantId, buyer, allocation);
  } else {
    assert.equal(event(trigger.events, "GrantClaimed").beneficiary.toLowerCase(), buyer);
    assert.equal(await w.base.read.balanceOf(buyer), allocation);
    assert.equal(await w.base.read.balanceOf(other), 0n);
    assert.equal((await w.deals.read.getGrant(grantId)).claimed, allocation);
    assert.deepEqual((await balances(w))[1], settled[1]);
  }
  const paid = await balances(w);
  await w.deals.as(buyer).claim(grantId).catch(error => {
    if (!(error instanceof Reverted)) throw error;
  });
  assert.deepEqual(await balances(w), paid);
});

await test(names[6], async () => {
  const w = await world({ life: 3600 });
  for (const changed of [
    { buyer: ZERO }, { cliffSeconds: w.terms.durationSeconds },
    { durationSeconds: 0 }, { fixedStart: (await w.chain.now()) - 1 },
  ]) {
    await assert.rejects(w.deals.as(seller).createDeal({ ...w.terms, ...changed }), Reverted);
  }
  const id = await fund(w);
  const before = await balances(w);
  await assert.rejects(w.deals.as(other).fill(id), Reverted);
  await assert.rejects(w.deals.as(other).cancel(id), Reverted);
  await warp(w.chain, BigInt(w.terms.expiry));
  await assert.rejects(w.deals.as(buyer).fill(id), Reverted);
  assert.deepEqual(await balances(w), before);
  const cancelled = event(await w.deals.as(seller).cancel(id), "DealCancelled");
  assert.equal(cancelled.dealId, id);
  assert.equal((await w.deals.read.getDeal(id)).status, CANCELLED);
  await assert.rejects(w.deals.as(seller).cancel(id), Reverted);
  await assert.rejects(w.deals.as(buyer).fill(id), Reverted);
  assert.deepEqual(await balances(w), [[w.terms.allocation, 0n, 0n, 0n, 0n], before[1]]);
});

done();
