import assert from "node:assert/strict";
import { test } from "node:test";
import { MaxUint256, ZeroAddress } from "ethers";
import { deploy, Reverted } from "../.launchpad/checks/round-1/chain.mjs";
import { compile, compileTokens } from "../.launchpad/checks/round-1/compile.mjs";
import { createData, EVENTS, fees, SELECTORS } from "../web/v2-chain.js";
import { actors, ALLOCATION, DAY, QUOTE, root, v2World } from "./support/v2-site.mjs";

const { deployer, seller, buyer, treasury } = actors;
const DAY_SECONDS = BigInt(DAY);

async function terms(world, changes = {}) {
  return {
    baseToken: world.base.address, quoteToken: world.quote.address, buyer, allocation: ALLOCATION, quote: QUOTE,
    expiry: BigInt(await world.chain.now()) + 2n * DAY_SECONDS, delivery: 1,
    fixedStart: 0n, cliffSeconds: DAY_SECONDS, durationSeconds: 3n * DAY_SECONDS, ...changes,
  };
}

async function fund({ deals, base, quote }, t) {
  await quote.as(buyer).approve(deals.address, fees(t.quote).buyerTotal);
  await base.as(seller).approve(deals.address, t.allocation);
  await deals.as(seller).createDeal(t);
}

async function at(chain, value) {
  await chain.setNextTime(Number(value));
  await chain.mine();
}

test("V2 calldata, receipt topics and fee dust use the frozen interface and raw units", async () => {
  const world = await v2World();
  const { interface: abi } = world.deals;
  for (const [name, selector] of Object.entries(SELECTORS)) assert.equal(abi.getFunction(name).selector, selector);
  for (const [name, topic] of Object.entries(EVENTS)) assert.equal(abi.getEvent(name).topicHash, topic);
  const t = await terms(world);
  assert.equal(createData(t), abi.encodeFunctionData("createDeal", [t]));
  assert.deepEqual(fees(199n), { quote: 199n, each: 0n, buyerTotal: 199n, sellerNet: 199n, pool: 0n });
  assert.deepEqual(fees(QUOTE), { quote: QUOTE, each: 617283n, buyerTotal: 124074072n, sellerNet: 122839506n, pool: 1234566n });
});

test("failure to fund the vesting vault or release a claim rolls back every observable balance", async () => {
  const world = await v2World();
  const { chain, deals, base, quote } = world;
  const t = await terms(world);
  await fund(world, t);
  const funds = () => Promise.all([
    base.read.balanceOf(deals.address), base.read.balanceOf(buyer), quote.read.balanceOf(buyer),
    quote.read.balanceOf(seller), quote.read.balanceOf(treasury), quote.read.balanceOf(deals.address),
    quote.read.allowance(buyer, deals.address),
  ]);
  const before = await funds();
  await base.as(deployer).setBlockedSender(deals.address);
  await assert.rejects(deals.as(buyer).fill(1n), Reverted);
  assert.deepEqual(await funds(), before);
  const open = await deals.read.getDeal(1n);
  assert.equal(open.status, 1n);
  assert.equal(open.grantId, 0n);
  assert.equal((await deals.read.getGrant(1n)).beneficiary, ZeroAddress);

  await base.as(deployer).setBlockedSender(ZeroAddress);
  await deals.as(buyer).fill(1n);
  const grant = await deals.read.getGrant(1n);
  assert.equal(await base.read.balanceOf(grant.custodian), ALLOCATION);
  assert.equal(await base.read.balanceOf(deals.address), 0n);
  assert.equal(await quote.read.balanceOf(treasury), fees(QUOTE).pool);
  await at(chain, grant.end);
  await base.as(deployer).setBlockedSender(grant.custodian);
  await assert.rejects(deals.as(buyer).claim(1n), Reverted);
  assert.equal((await deals.read.getGrant(1n)).claimed, 0n);
  assert.equal(await base.read.balanceOf(grant.custodian), ALLOCATION);
  assert.equal(await base.read.balanceOf(buyer), 0n);
  await base.as(deployer).setBlockedSender(ZeroAddress);
  await deals.as(buyer).claim(1n);
  assert.equal(await base.read.balanceOf(buyer), ALLOCATION);
  assert.equal(await base.read.balanceOf(grant.custodian), 0n);
  assert.equal(await quote.read.balanceOf(treasury), fees(QUOTE).pool);
});

test("expired fixed starts, invalid timings and an overflowing quote preserve escrow and payment", async () => {
  const world = await v2World();
  const { chain, deals, base, quote } = world;
  const fixedStart = BigInt(await chain.now()) + 3600n;
  const t = await terms(world, { fixedStart });
  await base.as(seller).approve(deals.address, t.allocation);
  await assert.rejects(deals.as(seller).createDeal({ ...t, quote: MaxUint256 }), Reverted);
  await assert.rejects(deals.as(seller).createDeal({ ...t, fixedStart: (1n << 64n) - 1n }), Reverted);
  await assert.rejects(deals.as(seller).createDeal({ ...t, delivery: 0 }), Reverted);
  assert.equal(await base.read.balanceOf(deals.address), 0n);
  await fund(world, t);
  await at(chain, fixedStart);
  const buyerBefore = await quote.read.balanceOf(buyer);
  await assert.rejects(deals.as(buyer).fill(1n), Reverted);
  assert.equal((await deals.read.getDeal(1n)).status, 1n);
  await deals.as(seller).cancel(1n);
  assert.equal(await base.read.balanceOf(seller), 4n * ALLOCATION);
  assert.equal(await quote.read.balanceOf(buyer), buyerBefore);
  assert.equal(await quote.read.balanceOf(treasury), 0n);
});

test("V2 refuses inexact and false-returning tokens while accepting no-return transfers", async () => {
  const world = await v2World();
  const { chain, deals, quote } = world;
  const { EdgeToken } = compile(root, "test/tokens/EdgeToken.sol");
  const inexact = await deploy(chain, deployer, EdgeToken, ["FEE", 18, 1]);
  const { NoReturnToken } = compileTokens();
  const noReturn = await deploy(chain, deployer, NoReturnToken, ["QUIET", 18]);
  for (const token of [inexact, noReturn]) {
    await token.as(deployer).mint(seller, ALLOCATION);
    await token.as(seller).approve(deals.address, ALLOCATION);
  }
  const t = await terms(world, { delivery: 0, durationSeconds: 0n, cliffSeconds: 0n });
  await assert.rejects(deals.as(seller).createDeal({ ...t, baseToken: inexact.address }), Reverted);
  assert.equal(await inexact.read.balanceOf(seller), ALLOCATION);
  assert.equal(await inexact.read.balanceOf(deals.address), 0n);
  await inexact.as(deployer).setKind(3);
  await assert.rejects(deals.as(seller).createDeal({ ...t, baseToken: inexact.address }), Reverted);
  await deals.as(seller).createDeal({ ...t, baseToken: noReturn.address });
  await quote.as(buyer).approve(deals.address, fees(t.quote).buyerTotal);
  await deals.as(buyer).fill(1n);
  assert.equal(await noReturn.read.balanceOf(buyer), ALLOCATION);
});

test("token callbacks cannot cancel settlement or repeat a claim during a transfer", async () => {
  const world = await v2World();
  const { chain, deals, quote } = world;
  const { ReentrantToken } = compileTokens();
  const token = await deploy(chain, deployer, ReentrantToken, ["CALL", 18]);
  await token.as(deployer).mint(seller, ALLOCATION);
  const t = await terms(world, { baseToken: token.address });
  await fund({ ...world, base: token }, t);
  await token.as(deployer).arm(deals.address, deals.interface.encodeFunctionData("cancel", [1n]));
  await deals.as(buyer).fill(1n);
  assert.equal(await token.read.calledBack(), false);

  const grant = await deals.read.getGrant(1n);
  await at(chain, grant.end);
  await token.as(deployer).arm(deals.address, deals.interface.encodeFunctionData("claim", [1n]));
  await deals.as(actors.other).claim(1n);
  assert.equal(await token.read.calledBack(), false);
  assert.equal(await token.read.balanceOf(buyer), ALLOCATION);
  assert.equal(await token.read.balanceOf(grant.custodian), 0n);
  assert.equal(await quote.read.balanceOf(treasury), fees(QUOTE).pool);
});
