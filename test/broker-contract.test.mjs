import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface, TypedDataEncoder } from "ethers";
import { Reverted, deploy } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { DAY, world } from "../scripts/lib/world.mjs";
import { BrokerChain } from "../web/broker.js";
import { abi, digest, domainFor, pack, unpack } from "../web/broker-terms.js";

const allocation = 900_000_000_000_000_000_001n;
const fixtures = [
  [123_456_789n, 0, 124_074_072n, 122_839_506n, 0n, 1_234_566n],
  [123_456_789n, 2000, 124_074_072n, 122_839_506n, 246_913n, 987_653n],
  [100_000_000_000n, 0, 100_500_000_000n, 99_500_000_000n, 0n, 1_000_000_000n],
  [100_000_000_000n, 2000, 100_500_000_000n, 99_500_000_000n, 200_000_000n, 800_000_000n],
];
const fields = [
  ["seller", "address"], ["buyer", "address"], ["baseToken", "address"], ["quoteToken", "address"], ["allocation", "uint256"],
  ["quote", "uint256"], ["expiry", "uint64"], ["nonce", "uint256"], ["delivery", "uint8"], ["fixedStart", "uint64"],
  ["cliffSeconds", "uint64"], ["durationSeconds", "uint64"], ["broker", "address"], ["brokerBps", "uint16"],
].map(([name, type]) => ({ name, type }));

async function setup(overrides = {}, { w: supplied, base, cost = 124_074_072n, nonce = 71n } = {}) {
  const w = supplied ?? await world({ withBroker: true });
  base ??= w.fam;
  const t = await w.brokerTerms(nonce, { allocation, ...overrides, baseToken: base.address });
  const broker = w.brokerDeals, domain = w.brokerDomain;
  const id = TypedDataEncoder.hash(domain, { BrokerTerms: fields }, t);
  assert.equal(w.brokerId(t), id);
  await base.as(w.deployer).mint(w.seller, allocation);
  await base.as(w.seller).approve(broker.address, allocation);
  await w.usdc.as(w.deployer).mint(w.buyer, cost);
  await w.usdc.as(w.buyer).approve(broker.address, cost);
  const sellerSig = await w.brokerSign(w.seller, t), buyerSig = await w.brokerSign(w.buyer, t);
  const fund = () => broker.as(w.seller).fund(t, sellerSig);
  const settle = () => broker.as(w.buyer).settle(id, buyerSig);
  return { w, t, broker, domain, id, fund, settle, sellerSig, buyerSig };
}

async function refused(w, call) {
  const before = await w.holdings();
  await assert.rejects(call(), Reverted);
  assert.deepEqual(await w.holdings(), before);
}

test("BrokerDeals browser bindings match compiled functions, events and EIP-712 fields", async () => {
  const { BrokerDeals } = compile(ROOT, "contracts/BrokerDeals.sol");
  const contract = new Interface(BrokerDeals.abi);
  for (const fragment of contract.fragments.filter(({ type }) => type === "function" || type === "event")) {
    const match = fragment.type === "function" ? abi.getFunction(fragment.name) : abi.getEvent(fragment.name);
    // Grant has an unnamed tuple output in both ABIs, other outputs and all inputs retain their specified names.
    assert.equal(match.format("full"), fragment.format("full"));
  }
  const t = {
    seller: `0x${"11".repeat(20)}`, buyer: `0x${"22".repeat(20)}`, baseToken: `0x${"33".repeat(20)}`,
    quoteToken: `0x${"44".repeat(20)}`, broker: `0x${"55".repeat(20)}`, allocation,
    quote: 123_456_789n, expiry: 2n ** 64n - 1n, nonce: 2n ** 256n - 1n,
    delivery: 0n, fixedStart: 0n, durationSeconds: 0n, cliffSeconds: 0n, brokerBps: 2_000n,
  };
  const domain = domainFor(84532, `0x${"66".repeat(20)}`);
  assert.deepEqual(unpack(pack(domain, t)), { domain, terms: t });
  assert.equal(digest(domain, t), TypedDataEncoder.hash(domain, { BrokerTerms: fields }, t));
  assert.throws(() => unpack("bad path/"), /full link/);
});

for (const [quote, brokerBps, total, net, share, treasury] of fixtures) {
  test(`exact raw balances for quote ${quote} and ${brokerBps} broker bps`, async () => {
    const { w, id, broker, fund, settle } = await setup({ quote, brokerBps }, { cost: total });
    assert.equal(new Set([w.broker, w.seller, w.buyer, w.other]).size, 4);
    assert.equal((await broker.read.getDeal(id)).status, 0n);
    const before = await w.holdings();
    const [funded] = await fund();
    assert.deepEqual([funded.name, funded.args.dealId, funded.args.seller.toLowerCase(), funded.args.broker.toLowerCase()],
      ["BrokerDealFunded", id, w.seller, w.broker]);
    assert.deepEqual(await w.moved(before), { "seller.FAM": -allocation, "escrow.FAM": allocation });
    const escrowed = await w.holdings();
    const [settled] = await settle();
    assert.deepEqual(await w.moved(escrowed), {
      "buyer.USDC": -total, "seller.USDC": net, ...(share ? { "broker.USDC": share } : {}),
      "treasury.USDC": treasury, "buyer.FAM": allocation, "escrow.FAM": -allocation,
    });
    assert.deepEqual([settled.name, settled.args.dealId, settled.args.buyer.toLowerCase(), settled.args.buyerFee,
      settled.args.sellerFee, settled.args.brokerFee, settled.args.treasuryFee, settled.args.grantId],
    ["BrokerDealSettled", id, w.buyer, total - quote, quote - net, share, treasury, 0n]);
    assert.equal((await broker.read.getDeal(id)).status, 2n);
  });
}

test("authorization failures preserve every holding, including after expiry and nonce reuse", async () => {
  const { w, t, id, broker, domain, fund, settle, sellerSig, buyerSig } = await setup();
  const bad = (call) => refused(w, call);
  const seller = broker.as(w.seller), buyer = broker.as(w.buyer);
  await bad(settle);
  await bad(() => broker.as(w.broker).fund(t, sellerSig));
  await bad(() => seller.fund({ ...t, quote: t.quote + 1n }, sellerSig));
  for (const scope of [{ ...domain, chainId: domain.chainId + 1 }, { ...domain, verifyingContract: w.other }]) {
    await bad(async () => seller.fund(t, await w.brokerSign(w.seller, t, scope)));
  }
  await fund();
  await bad(() => seller.fund(t, sellerSig));
  const changed = { ...t, brokerBps: 0 };
  await bad(async () => seller.fund(changed, await w.brokerSign(w.seller, changed)));
  await bad(() => broker.as(w.other).settle(id, buyerSig));
  await bad(async () => buyer.settle(id, await w.brokerSign(w.buyer, changed)));
  await bad(async () => buyer.settle(id, await w.brokerSign(w.other, t)));
  for (const scope of [{ ...domain, chainId: domain.chainId + 1 }, { ...domain, verifyingContract: w.other }]) {
    await bad(async () => buyer.settle(id, await w.brokerSign(w.buyer, t, scope)));
  }
  await bad(() => broker.as(w.broker).refund(id));
  await bad(() => buyer.refund(id));
  await w.at(t.expiry);
  await bad(settle);
  const late = { ...t, nonce: 72 };
  await bad(async () => seller.fund(late, await w.brokerSign(w.seller, late)));
  assert.equal((await broker.read.getDeal(id)).status, 1n);
});

test("a delivery that fails after the payment reverts all fees, and refund restores the original balances", async () => {
  const w = await world({ withBroker: true });
  const { EdgeToken } = compile(ROOT, "test/tokens/EdgeToken.sol");
  const deployed = await deploy(w.chain, w.deployer, EdgeToken, ["EDGE", 18, 0]);
  const base = w.tokens.EDGE = { ...deployed, symbol: "EDGE", decimals: 18 };
  const { fund, settle, broker, id } = await setup({}, { w, base });
  const original = await w.holdings();
  await fund();
  await base.as(w.deployer).setKind(5); // transferFrom was exact, transfer to the buyer keeps a fee
  await refused(w, settle);
  assert.equal((await broker.read.getDeal(id)).status, 1n);
  await base.as(w.deployer).setKind(0);
  const [refund] = await broker.as(w.seller).refund(id);
  assert.deepEqual([refund.name, refund.args.dealId], ["BrokerDealRefunded", id]);
  assert.equal((await broker.read.getDeal(id)).status, 3n);
  assert.deepEqual(await w.holdings(), original);
  await refused(w, settle);
});

for (const fixed of [false, true]) {
  test(`fully backed vesting and exact fee-free claims, starting ${fixed ? "at a fixed UTC time" : "at settlement"}`, async () => {
    const w = await world({ withBroker: true });
    const fixedStart = fixed ? await w.chain.now() + 2 * DAY : 0;
    const { id, broker, fund, settle } = await setup({ delivery: 1, fixedStart, cliffSeconds: 30 * DAY, durationSeconds: 90 * DAY }, { w });
    await fund();
    const before = await w.holdings(), [receipt] = await settle();
    const { grantId } = receipt.args, grant = await broker.read.getGrant(grantId);
    w.watch("brokerVault", grant.custodian);
    assert.deepEqual(await w.moved(before), { "buyer.USDC": -124_074_072n, "seller.USDC": 122_839_506n,
      "broker.USDC": 246_913n, "treasury.USDC": 987_653n, "escrow.FAM": -allocation, "brokerVault.FAM": allocation });
    assert.equal(grant.beneficiary.toLowerCase(), w.buyer);
    assert.equal(grant.start, BigInt(fixedStart || await w.chain.now()));
    assert.equal(grant.cliff, grant.start + 30n * BigInt(DAY));
    assert.equal(grant.end, grant.start + 90n * BigInt(DAY));
    assert.equal((await broker.read.getDeal(id)).grantId, grantId);
    await refused(w, () => broker.as(w.buyer).claim(grantId));
    await refused(w, () => broker.as(w.other).claim(grantId));
    for (const [time, delta, claimed] of [[grant.cliff, 300_000_000_000_000_000_000n, 300_000_000_000_000_000_000n],
      [grant.end, 600_000_000_000_000_000_001n, allocation]]) {
      const held = await w.holdings();
      await w.next(time);
      await broker.as(w.buyer).claim(grantId);
      assert.deepEqual(await w.moved(held), { "buyer.FAM": delta, "brokerVault.FAM": -delta });
      assert.equal((await broker.read.getGrant(grantId)).claimed, claimed);
    }
    await refused(w, () => broker.as(w.buyer).claim(grantId));
  });
}

test("broker receipt queries stop at the configured deployment block and refuse an unset block", async () => {
  const ranges = [];
  const chain = { rpc(method, [filter]) {
    assert.equal(method, "eth_getLogs");
    ranges.push([Number(filter.fromBlock), Number(filter.toBlock)]);
    return [];
  } };
  const config = { chainId: 84532, contractBroker: `0x${"11".repeat(20)}` };
  await assert.rejects(new BrokerChain(chain, config).logs([], 5400), /Set fromBlockBroker/);
  assert.deepEqual(ranges, []);
  await new BrokerChain(chain, { ...config, fromBlockBroker: 1420 }).logs([], 5400);
  assert.deepEqual(ranges, [[3401, 5400], [1420, 3400]]);
});
