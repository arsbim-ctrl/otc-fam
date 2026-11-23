import assert from "node:assert/strict";
import { test } from "node:test";
import { deploy, Reverted, startChain } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";

const [owner, seller, buyer, treasury] = ["11", "22", "33", "44"].map((byte) => "0x" + byte.repeat(20));
const { OtcDealsV2 } = compile(ROOT, "contracts/OtcDealsV2.sol");
const { EdgeToken } = compile(ROOT, "test/tokens/EdgeToken.sol");
const { FixtureToken } = compile(ROOT, ".launchpad/checks/round-2/FixtureToken.sol");

async function world(vesting = false) {
  const chain = await startChain([owner, seller, buyer, treasury]);
  const deals = await deploy(chain, owner, OtcDealsV2, [treasury]);
  const base = await deploy(chain, owner, EdgeToken, ["BASE", 18, 0]);
  const payment = await deploy(chain, owner, FixtureToken, ["USDC", 6]);
  const allocation = 10_003n;
  const quote = 123_456_789n;
  await base.as(owner).mint(seller, allocation);
  await payment.as(owner).mint(buyer, quote + quote / 200n);
  await base.as(seller).approve(deals.address, allocation);
  await payment.as(buyer).approve(deals.address, quote + quote / 200n);
  const now = await chain.now();
  const terms = {
    baseToken: base.address, quoteToken: payment.address, buyer, allocation, quote,
    expiry: now + 3600, delivery: vesting ? 1 : 0,
    fixedStart: vesting ? now + 60 : 0, cliffSeconds: 0, durationSeconds: vesting ? 90 : 0,
  };
  return { chain, deals, base, payment, terms };
}

async function fund({ deals, terms }) {
  const [event] = await deals.as(seller).createDeal(terms);
  return event.args.dealId;
}

test("an outbound fee cannot shortchange delivery even when the escrow loses the requested amount", async () => {
  const w = await world();
  const id = await fund(w);
  await w.base.as(owner).setKind(1);
  await assert.rejects(w.deals.as(buyer).fill(id), Reverted);
  assert.equal((await w.deals.read.getDeal(id)).status, 1n);
  assert.equal(await w.payment.read.balanceOf(buyer), w.terms.quote + w.terms.quote / 200n);
  assert.equal(await w.payment.read.balanceOf(seller), 0n);
  assert.equal(await w.payment.read.balanceOf(treasury), 0n);
  assert.equal(await w.base.read.balanceOf(w.deals.address), w.terms.allocation);
  await w.base.as(owner).setKind(0);
  await w.deals.as(buyer).fill(id);
  assert.equal(await w.base.read.balanceOf(buyer), w.terms.allocation);
});

test("a failed outbound claim leaves the entire amount claimable", async () => {
  const w = await world(true);
  const id = await fund(w);
  await w.deals.as(buyer).fill(id);
  const { grantId } = await w.deals.read.getDeal(id);
  const { end } = await w.deals.read.getGrant(grantId);
  await w.chain.setNextTime(Number(end));
  await w.chain.mine();
  await w.base.as(owner).setKind(1);
  await assert.rejects(w.deals.as(buyer).claim(grantId), Reverted);
  assert.equal((await w.deals.read.getGrant(grantId)).claimed, 0n);
  assert.equal(await w.deals.read.claimable(grantId), w.terms.allocation);
  await w.base.as(owner).setKind(0);
  await w.deals.as(owner).claim(grantId);
  assert.equal(await w.deals.read.claimable(grantId), 0n);
  assert.equal(await w.base.read.balanceOf(buyer), w.terms.allocation);
});

test("a missed fixed start allows an exact seller refund before expiry", async () => {
  const w = await world(true);
  const id = await fund(w);
  await w.chain.setNextTime(w.terms.fixedStart);
  await w.chain.mine();
  await assert.rejects(w.deals.as(buyer).fill(id), Reverted);
  assert.equal(await w.payment.read.balanceOf(treasury), 0n);
  await w.deals.as(seller).cancel(id);
  assert.equal(await w.base.read.balanceOf(seller), w.terms.allocation);
  assert.equal((await w.deals.read.getDeal(id)).status, 3n);
});
