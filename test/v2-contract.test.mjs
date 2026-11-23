import assert from "node:assert/strict";
import { test } from "node:test";
import { deploy, Reverted } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { createV2Data, feeBreakdown } from "../web/eth-v2.js";
import { ALLOCATION, DAY, QUOTE, STATUS, v2World } from "./v2-fixture.mjs";

test("V2 frontend calldata matches the compiled tuple ABI and exact six-decimal fees", async () => {
  const w = await v2World();
  const terms = await w.termsV2({ fixedStart: BigInt(await w.chain.now()) + DAY * 2n });
  assert.equal(createV2Data(terms), w.v2.interface.encodeFunctionData("createDeal", [terms]));
  assert.deepEqual(feeBreakdown(QUOTE), {
    fee: 617_283n, buyerTotal: 124_074_072n, sellerNet: 122_839_506n, feePool: 1_234_566n,
  });
  assert.deepEqual(feeBreakdown(199n), { fee: 0n, buyerTotal: 199n, sellerNet: 199n, feePool: 0n });
});

test("stale and unrepresentable schedules preserve escrow and collect no fees", async () => {
  const { maker, taker, base, usdc, v2, termsV2, warp, chain, balances } = await v2World();
  const now = BigInt(await chain.now());
  await base.as(maker).approve(v2.address, ALLOCATION);
  await assert.rejects(v2.as(maker).createDeal(await termsV2({ durationSeconds: 2n ** 64n - 1n })), Reverted);
  await assert.rejects(v2.as(maker).createDeal(await termsV2({ fixedStart: now - 1n })), Reverted);
  const fixedStart = now + 600n;
  await v2.as(maker).createDeal(await termsV2({ fixedStart }));
  await usdc.as(taker).approve(v2.address, feeBreakdown(QUOTE).buyerTotal);
  const before = await balances(usdc);
  await warp(fixedStart);
  await assert.rejects(v2.as(taker).fill(1n), Reverted);
  assert.equal((await v2.read.getDeal(1n)).status, STATUS.funded);
  assert.equal((await v2.read.getDeal(1n)).grantId, 0n);
  assert.deepEqual(await balances(usdc), before);
  await v2.as(maker).cancel(1n);
  assert.equal(await base.read.balanceOf(maker), ALLOCATION);
  assert.deepEqual(await balances(usdc), before);
});

test("inexact payment rolls back a vesting grant and keeps the exact allocation refundable", async () => {
  const w = await v2World();
  const { EdgeToken } = compile(ROOT, "test/tokens/EdgeToken.sol");
  const quote = await deploy(w.chain, w.deployer, EdgeToken, ["EDGE", 6, 0]);
  const { buyerTotal, sellerNet, feePool } = feeBreakdown(QUOTE);
  await quote.as(w.deployer).mint(w.taker, buyerTotal * 2n);
  await quote.as(w.taker).approve(w.v2.address, buyerTotal);
  await w.base.as(w.maker).approve(w.v2.address, ALLOCATION);
  await w.v2.as(w.maker).createDeal(await w.termsV2({ quoteToken: quote.address }));
  const funded = await w.balances();
  const before = await w.balances(quote);
  for (const mode of [1, 2, 3]) {
    await quote.as(w.deployer).setKind(mode);
    await assert.rejects(w.v2.as(w.taker).fill(1n), Reverted);
    assert.deepEqual(await w.balances(), funded);
    assert.deepEqual(await w.balances(quote), before);
    assert.equal((await w.v2.read.getDeal(1n)).status, STATUS.funded);
    assert.equal((await w.v2.read.getGrant(1n)).allocation, 0n);
  }
  await quote.as(w.deployer).setKind(0);
  await w.v2.as(w.taker).fill(1n);
  assert.deepEqual((await w.balances(quote)).map((units, i) => units - before[i]),
    [sellerNet, -buyerTotal, feePool, 0n, 0n]);
  assert.equal((await w.v2.read.getGrant(1n)).allocation, ALLOCATION);
});

test("a callback in a claim cannot touch another grant or pay the first twice", async () => {
  const w = await v2World("ReentrantToken");
  const { buyerTotal } = feeBreakdown(QUOTE);
  await w.base.as(w.maker).approve(w.v2.address, ALLOCATION);
  await w.base.as(w.other).approve(w.v2.address, ALLOCATION);
  await w.usdc.as(w.taker).approve(w.v2.address, buyerTotal * 2n);
  await w.v2.as(w.maker).createDeal(await w.termsV2());
  await w.v2.as(w.other).createDeal(await w.termsV2());
  await w.v2.as(w.taker).fill(1n);
  await w.v2.as(w.taker).fill(2n);
  await w.warp((await w.v2.read.getGrant(2n)).end);
  const attempt = w.v2.interface.encodeFunctionData("claim", [2n]);
  await w.base.as(w.deployer).arm(w.v2.address, attempt);
  await w.v2.as(w.other).claim(1n);
  assert.equal(await w.base.read.calledBack(), false);
  assert.equal(await w.base.read.balanceOf(w.v2.address), ALLOCATION);
  assert.equal((await w.v2.read.getGrant(2n)).claimed, 0n);
  await w.base.as(w.deployer).arm(w.v2.address, attempt);
  await w.v2.as(w.other).claim(2n);
  assert.equal(await w.base.read.calledBack(), false);
  assert.equal(await w.base.read.balanceOf(w.v2.address), 0n);
  assert.equal(await w.base.read.balanceOf(w.taker), 3n * ALLOCATION);
  assert.equal(await w.base.read.balanceOf(w.other), 0n);
});
