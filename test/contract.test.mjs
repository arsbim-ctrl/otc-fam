// What the round's checks leave out of OtcDeals: tokens that take a fee, answer false or are no token at all, deals
// of one token kept apart, and calls back into the contract while it moves tokens. Each test runs on a fresh chain
// built with the checks' own helpers (.launchpad/checks/round-1), which these tests only use.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";
import { deploy, Reverted } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { ANYONE, artifacts, STATUS, world } from "../.launchpad/checks/round-1/world.mjs";

const { EdgeToken } = compile(ROOT, "test/tokens/EdgeToken.sol");
const KIND = { Plain: 0, Fee: 1, FeeOnTop: 2, False: 3, Reset: 4 };
const contractErrors = new Interface(artifacts().entry.abi);

/** A world with an EdgeToken of `kind`, of which the maker, the taker and the third person hold a million. */
async function worldWith(kind, symbol) {
  const w = await world();
  const token = await deploy(w.chain, w.deployer, EdgeToken, [symbol, 18, KIND[kind]], { label: symbol });
  for (const who of [w.maker, w.taker, w.other]) await token.as(w.deployer).mint(who, 10n ** 24n);
  return { w, token };
}

/** The name of the OtcDeals error `sending` reverts with; fails if it goes through. */
async function revertsWith(sending) {
  try {
    await sending;
  } catch (e) {
    if (!(e instanceof Reverted)) throw e;
    const data = /return data: (0x[0-9a-f]+)/.exec(e.message)?.[1];
    return data ? contractErrors.parseError(data)?.name : e.message;
  }
  assert.fail("the call went through: it must revert");
}

test("a token that takes a fee, from the amount or on top of it, is refused on either side of a deal", async () => {
  for (const kind of ["Fee", "FeeOnTop"]) {
    const { w, token } = await worldWith(kind, "FEE");
    await token.as(w.maker).approve(w.deals.address, 2000n);
    assert.equal(await revertsWith(w.create(w.maker, await w.terms({ sellToken: token.address, sellAmount: 1000n }))), "InexactTransfer", `${kind}, sold`);
    assert.equal(await token.read.balanceOf(w.deals.address), 0n);
    assert.equal((await w.deals.read.getDeal(1)).status, STATUS.None);

    const id = await w.offer({ buyToken: token.address, buyAmount: 1000n }); // ALFA for FEE
    const before = await w.holdings(), makers = await token.read.balanceOf(w.maker);
    await token.as(w.taker).approve(w.deals.address, 2000n);
    assert.equal(await revertsWith(w.deals.as(w.taker).fill(id)), "InexactTransfer", `${kind}, bought`);
    await w.moved(before, {}, `after a fill paid in a token that takes a fee (${kind})`);
    assert.equal(await token.read.balanceOf(w.maker), makers);
    assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Open, "the deal is still open, and its maker can cancel it");
  }
});

test("a token that starts taking fees once deals hold it never pays one deal out of another deal's tokens", async () => {
  const { w, token } = await worldWith("Plain", "EDGE");
  for (const maker of [w.maker, w.other]) {
    await token.as(maker).approve(w.deals.address, 1000n);
    await w.create(maker, await w.terms({ sellToken: token.address, sellAmount: 1000n })); // deals 1 and 2: the contract holds 2000
  }
  await token.as(w.deployer).setKind(KIND.FeeOnTop); // paying 1000 out would now cost the contract 1010
  assert.equal(await revertsWith(w.deals.as(w.maker).cancel(1)), "InexactTransfer");
  assert.equal(await token.read.balanceOf(w.deals.address), 2000n, "the other deal's tokens are all still there");
  await token.as(w.deployer).setKind(KIND.Fee); // a fee its recipient pays: the contract still gives exactly 1000
  await w.deals.as(w.maker).cancel(1);
  assert.equal(await token.read.balanceOf(w.deals.address), 1000n);
  await w.deals.as(w.other).cancel(2);
  assert.equal(await token.read.balanceOf(w.deals.address), 0n);
});

test("a token that answers false moves nothing: it cannot be sold, and a fill paid with it fails and changes no balance", async () => {
  const { w, token } = await worldWith("False", "NOPE");
  await token.as(w.maker).approve(w.deals.address, 1000n);
  assert.equal(await revertsWith(w.create(w.maker, await w.terms({ sellToken: token.address, sellAmount: 1000n }))), "TransferFailed");
  const id = await w.offer({ buyToken: token.address, buyAmount: 1000n }); // ALFA for NOPE
  const before = await w.holdings();
  await token.as(w.taker).approve(w.deals.address, 1000n);
  assert.equal(await revertsWith(w.deals.as(w.taker).fill(id)), "TransferFailed");
  await w.moved(before, {}, "after a fill paid with a token that answered false");
  assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Open, "the deal is still open, and its maker can cancel it");
});

test("an address with no contract behind it is no token: refused on either side of a deal", async () => {
  const w = await world();
  await w.approve(w.maker, w.alfa, w.SELL);
  assert.equal(await revertsWith(w.create(w.maker, await w.terms({ buyToken: w.other }))), "NotAToken");
  assert.equal(await revertsWith(w.create(w.maker, await w.terms({ sellToken: w.other }))), "NotAToken");
});

test("deals of the same token stay apart: each one pays out exactly its own amount", async () => {
  const w = await world();
  const before = await w.holdings();
  const makers = await w.offer(), others = await w.offer({ sellAmount: 3n * w.SELL }, w.other);
  await w.accept(makers);
  await w.deals.as(w.other).cancel(others);
  await w.moved(before, { maker: { ALFA: -w.SELL, BRAVO: w.BUY }, taker: { ALFA: w.SELL, BRAVO: -w.BUY } },
    "after one maker's deal was filled and another maker's deal of the same token cancelled");
});

test("while a deal's tokens move, every call back into createDeal, fill or cancel is refused", async () => {
  for (const callback of ["createDeal", "fill", "cancel"]) {
    const w = await world();
    const evil = await w.token("ReentrantToken", "EVIL", 18);
    await w.join("EVIL itself", evil.address);
    const id = await w.offer({ buyToken: evil.address, buyAmount: 10n ** 18n }, evil.address);
    await w.approve(evil.address, w.alfa, w.SELL); // without the lock, EVIL's own createDeal would go through
    const args = callback === "createDeal" ? [w.alfa.address, w.SELL, w.bravo.address, w.BUY, ANYONE, BigInt((await w.chain.now()) + 3600)] : [id];
    await evil.as(w.other).arm(w.deals.address, w.deals.interface.encodeFunctionData(callback, args));
    await w.accept(id); // the taker pays in EVIL, whose transfer calls the contract back
    assert.equal(await evil.read.calledBack(), false, `the call back into ${callback} went through`);
    assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Filled);
    assert.equal((await w.deals.read.getDeal(id + 1)).status, STATUS.None, "no deal was made from inside the transfer");
  }
});
