import assert from "node:assert/strict";
import { test } from "node:test";
import { deploy, Reverted, startChain } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";

const [seller, buyer, treasury] = ["11", "22", "33"].map(pair => "0x" + pair.repeat(20));
const { OtcDealsV2 } = compile(ROOT, "contracts/OtcDealsV2.sol");
const { EdgeToken } = compile(ROOT, "test/tokens/EdgeToken.sol");

async function fundedPair(allocation = 1000n, schedule = {}) {
  const chain = await startChain([seller, buyer]);
  const deals = await deploy(chain, seller, OtcDealsV2, [treasury]);
  const base = await deploy(chain, seller, EdgeToken, ["BASE", 0, 0]);
  const pay = await deploy(chain, seller, EdgeToken, ["PAY", 0, 0]);
  await base.as(seller).mint(seller, 2n * allocation);
  await base.as(seller).approve(deals.address, 2n * allocation);
  const terms = { baseToken: base.address, quoteToken: pay.address, buyer, allocation, quote: 200,
    delivery: 1, expiry: await chain.now() + 3600, fixedStart: 0, cliffSeconds: 0, durationSeconds: 10, ...schedule };
  await deals.as(seller).createDeal(terms);
  await deals.as(seller).createDeal(terms);
  await pay.as(seller).mint(buyer, 402);
  await pay.as(buyer).approve(deals.address, 402);
  return { chain, deals, base, pay };
}

test("refused delivery into grant custody rolls back the entire fill and can be retried", async () => {
  const { deals, base, pay } = await fundedPair();
  await base.as(seller).setKind(3); // transfer returns false
  await assert.rejects(deals.as(buyer).fill(1), Reverted);
  const [, , status, grantId] = await deals.read.getDeal(1);
  assert.equal(status, 1n);
  assert.equal(grantId, 0n);
  assert.equal((await deals.read.getGrant(1)).dealId, 0n);
  for (const account of [seller, treasury, deals.address]) assert.equal(await pay.read.balanceOf(account), 0n);
  assert.equal(await pay.read.balanceOf(buyer), 402n);
  assert.equal(await pay.read.allowance(buyer, deals.address), 402n);
  await base.as(seller).setKind(0);
  await deals.as(buyer).fill(1);
  const { custodian } = await deals.read.getGrant(1);
  assert.equal(await base.read.balanceOf(custodian), 1000n);
});

test("an escrow or grant pool with a one-unit shortfall preserves all outstanding allocations", async () => {
  const { chain, deals, base } = await fundedPair();
  await base.as(seller).burn(deals.address, 1);
  await assert.rejects(deals.as(buyer).fill(1), Reverted);
  await assert.rejects(deals.as(seller).cancel(2), Reverted);
  assert.equal(await base.read.balanceOf(deals.address), 1999n);
  await base.as(seller).mint(deals.address, 1);
  await deals.as(buyer).fill(1);
  await deals.as(buyer).fill(2);
  const { custodian, end } = await deals.read.getGrant(1);
  await chain.setNextTime(Number(end));
  await base.as(seller).burn(custodian, 1);
  await assert.rejects(deals.as(buyer).claim(1), Reverted);
  assert.equal((await deals.read.getGrant(1)).claimed, 0n);
  assert.equal(await base.read.balanceOf(custodian), 1999n);
  await base.as(seller).mint(custodian, 1);
  await deals.as(buyer).claim(1);
  assert.equal(await base.read.balanceOf(custodian), 1000n);
});

test("a token changing its transfer fee cannot short a grant claim or consume another funded deal", async () => {
  const { chain, deals, base } = await fundedPair();
  await deals.as(buyer).fill(1);
  const grant = await deals.read.getGrant(1);
  await chain.setNextTime(Number(grant.end));
  for (const kind of [1, 2]) {
    await base.as(seller).setKind(kind);
    await assert.rejects(deals.as(buyer).claim(1), Reverted);
    assert.equal((await deals.read.getGrant(1)).claimed, 0n);
    assert.equal(await base.read.balanceOf(deals.address), 1000n);
    assert.equal(await base.read.balanceOf(grant.custodian), 1000n);
    assert.equal(await base.read.balanceOf(buyer), 0n);
  }
  await base.as(seller).setKind(0);
  await deals.as(buyer).claim(1);
  await deals.as(seller).cancel(2);
  assert.equal(await base.read.balanceOf(seller), 1000n);
  assert.equal(await base.read.balanceOf(buyer), 1000n);
});

test("R2-05 boundary: a claim mined one second after the cliff includes that extra second", async () => {
  const allocation = 10n ** 24n + 1n;
  const day = 86400;
  const { chain, deals } = await fundedPair(allocation, { cliffSeconds: 30 * day, durationSeconds: 90 * day });
  await deals.as(buyer).fill(1);
  const g = await deals.read.getGrant(1);
  await chain.setNextTime(Number(g.cliff));
  await chain.mine();
  assert.equal(await deals.read.claimable(1), allocation / 3n);
  await chain.setNextTime(Number(g.cliff + 1n));
  const [claim] = await deals.as(buyer).claim(1);
  const expected = allocation * (g.cliff + 1n - g.start) / (g.end - g.start);
  assert.equal(claim.args.amount, expected);
  assert.ok(expected > allocation / 3n);
});
