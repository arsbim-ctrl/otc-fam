import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { deploy } from "../.launchpad/checks/round-1/chain.mjs";
import { brokerWorld, signers, testWallet } from "./lib/broker-world.mjs";
import { BrokerChain, dealId, proposalPath, readProposal, signTerms, termsFrom, txData, TYPES } from "../dist/v3-protocol.js";
import { utc } from "../dist/ui.js";
import { parseUtc } from "../dist/units.js";

const out = process.env.BROKER_EVIDENCE_DIR ?? "evidence/round-3";
const day = 86_400n;
const allocation = 900_000_000_000_000_000_001n;
const report = { assertions: [], scenarios: [] };
const fixture = compile(".launchpad/checks", "round-2/FixtureToken.sol").FixtureToken;

async function setup(overrides = {}) {
  const w = await brokerWorld();
  const base = overrides.broken
    ? await deploy(w.chain, w.deployer, fixture, ["FAM", 18])
    : w.fam;
  if (overrides.broken) await base.as(w.deployer).mint(w.seller, allocation);
  const protocol = new BrokerChain(w.chain, w.configV3);
  await protocol.checkNetwork();
  const time = BigInt(await w.chain.now());
  const fixed = time + 2n * day;
  const fixedUtc = new Date(Number(fixed) * 1000).toISOString().slice(0, 19).replace("T", " ");
  const terms = termsFrom({
    seller: w.seller, buyer: w.buyer, baseToken: base.address, quoteToken: w.usdc.address,
    allocation, quote: 123_456_789n, expiry: time + day, nonce: 71n, delivery: 0n,
    fixedStart: 0n, cliffSeconds: 0n, durationSeconds: 0n, broker: w.broker, brokerBps: 2000n,
    ...overrides.terms, ...(overrides.fixed ? { fixedStart: parseUtc(fixedUtc) } : {}),
  });
  if (overrides.fixed) {
    assert.equal(terms.fixedStart, fixed, "UTC input preserves exact unix seconds");
    assert.ok(utc(terms.fixedStart).endsWith(fixedUtc.slice(11) + " UTC"), "display uses UTC in every system time zone");
  }
  const id = dealId(protocol.domain, terms);
  assert.equal((await protocol.read("hashTerms", [terms]))[0], id, "browser and contract agree on EIP-712 digest");
  const link = proposalPath(protocol.domain, terms);
  assert.deepEqual(readProposal(protocol.domain, link.slice(7)), { terms, id });
  const envelope = JSON.parse(atob(link.slice(7).replaceAll("-", "+").replaceAll("_", "/")));
  envelope[9] = String(terms.quote + 1n);
  assert.throws(() => readProposal(protocol.domain, btoa(JSON.stringify(envelope)).replace(/=+$/, "")), /terms do not match/i);
  assert.throws(() => readProposal({ ...protocol.domain, chainId: 1 }, link.slice(7)), /another chain/);

  const accounts = Object.fromEntries(["seller", "buyer", "broker", "other", "treasury"].map((role) => [role, w[role]]));
  accounts.escrow = w.brokerDeals.address;
  const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(accounts).map(async ([role, address]) => [
    role, { base: await base.read.balanceOf(address), quote: await w.usdc.read.balanceOf(address) },
  ])));
  const sig = async (role, value = terms, domain = protocol.domain) => signers[role].signTypedData(domain, TYPES, value);
  const walletSignature = async (role) => {
    const answer = testWallet(w, role);
    await answer({ method: "eth_requestAccounts" });
    const provider = { request: async (req) => {
      const { result, error } = await answer(req);
      if (error) throw Object.assign(new Error(error.message), error);
      return result;
    } };
    return signTerms(provider, w[role], protocol.domain, terms);
  };
  const send = async (role, name, args, status = "0x1") => {
    const hash = await w.chain.submit(w[role], { to: accounts.escrow, data: txData(name, ...args), gas: "0x7a1200" });
    const receipt = await w.chain.rpc("eth_getTransactionReceipt", [hash]);
    assert.equal(receipt.status, status, `${role} ${name} receipt`);
    if (status === "0x0") assert.equal(receipt.logs.length, 0, "reverted transaction emitted no logs");
    return receipt;
  };
  const fund = async () => send("seller", "fund", [terms, await walletSignature("seller")]);
  const settle = async () => send("buyer", "settle", [id, await walletSignature("buyer")]);
  const approve = async () => {
    await base.as(w.seller).approve(accounts.escrow, allocation);
    await w.usdc.as(w.buyer).approve(accounts.escrow, terms.quote + terms.quote / 200n);
  };
  return { w, base, accounts, protocol, terms, id, link, snapshot, sig, send, fund, settle, approve };
}

function delta(before, after) {
  return Object.fromEntries(Object.keys(before).map((role) =>
    [role, Object.fromEntries(Object.keys(before[role]).map((token) => [token, after[role][token] - before[role][token]]))]));
}

function expectDelta(before, after, expected = {}) {
  const actual = delta(before, after);
  for (const [role, change] of Object.entries(actual)) {
    assert.deepEqual(change, { base: 0n, quote: 0n, ...expected[role] }, role);
  }
  return actual;
}

for (const [quote, bps, buyerTotal, sellerNet, broker, treasury] of [
  [100_000_000_000n, 0n, 100_500_000_000n, 99_500_000_000n, 0n, 1_000_000_000n],
  [100_000_000_000n, 2000n, 100_500_000_000n, 99_500_000_000n, 200_000_000n, 800_000_000n],
  [123_456_789n, 0n, 124_074_072n, 122_839_506n, 0n, 1_234_566n],
  [123_456_789n, 2000n, 124_074_072n, 122_839_506n, 246_913n, 987_653n],
]) {
  const x = await setup({ terms: { quote, brokerBps: bps } });
  await x.approve();
  const initial = await x.snapshot();
  const funded = await x.fund();
  const escrowed = await x.snapshot();
  const fundingDelta = expectDelta(initial, escrowed, { seller: { base: -allocation }, escrow: { base: allocation } });
  const settled = await x.settle();
  const final = await x.snapshot();
  const settlementDelta = expectDelta(escrowed, final, {
    buyer: { base: allocation, quote: -buyerTotal }, seller: { quote: sellerNet },
    broker: { quote: broker }, treasury: { quote: treasury }, escrow: { base: -allocation },
  });
  const head = Number(await x.w.chain.rpc("eth_blockNumber"));
  for (const role of ["broker", "buyer", "seller"]) assert.deepEqual(await x.protocol.history(x.accounts[role], head), [x.id]);
  assert.deepEqual(await x.protocol.history(x.accounts.other, head), []);
  const events = await x.protocol.receipts(x.id, 0n, head);
  assert.deepEqual(events.map((e) => [e.kind, e.hash, e.confirmed]),
    [["funded", funded.transactionHash, true], ["settled", settled.transactionHash, true]]);
  const event = events[1];
  assert.deepEqual(
    [event.buyerFee, event.sellerFee, event.brokerFee, event.treasuryFee, event.grantId],
    [buyerTotal - quote, quote - sellerNet, broker, treasury, 0n],
  );
  const replay = await x.send("buyer", "settle", [x.id, await x.sig("buyer")], "0x0");
  expectDelta(final, await x.snapshot());
  report.scenarios.push({ case: "immediate", id: x.id, terms: x.terms, accounts: x.accounts,
    initial, escrowed, final, fundingDelta, settlementDelta, receipts: { funded, settled, replay }, events });
}
report.assertions.push("Four exact raw balance fixtures, signed through the browser codec, passed. Deal book queries and receipt hashes matched chain data for all roles. Replaying a successful settlement changed no balances.");

{
  const x = await setup({ broken: true });
  await x.approve();
  const before = await x.snapshot();
  const funded = await x.fund();
  await x.base.as(x.w.deployer).setBlockedSender(x.accounts.escrow);
  const escrowed = await x.snapshot();
  const failed = await x.send("buyer", "settle", [x.id, await x.sig("buyer")], "0x0");
  const failedDelta = expectDelta(escrowed, await x.snapshot());
  assert.equal((await x.protocol.deal(x.id)).status, "funded");
  await x.base.as(x.w.deployer).setBlockedSender("0x" + "0".repeat(40));
  const wrongRefund = await x.send("broker", "refund", [x.id], "0x0");
  const refunded = await x.send("seller", "refund", [x.id]);
  const roundTripDelta = expectDelta(before, await x.snapshot());
  assert.equal((await x.protocol.deal(x.id)).status, "refunded");
  report.scenarios.push({ case: "failed settlement and refund", id: x.id, terms: x.terms, accounts: x.accounts,
    failedDelta, roundTripDelta, receipts: { funded, failed, wrongRefund, refunded } });
}
report.assertions.push("Blocked base delivery rolled back all payment and fees. A broker refund failed. The seller refund restored every raw balance.");

{
  const x = await setup();
  await x.approve();
  const before = await x.snapshot();
  const altered = { ...x.terms, quote: x.terms.quote + 1n };
  const receipts = {};
  receipts.wrongActor = await x.send("broker", "fund", [x.terms, await x.sig("seller")], "0x0");
  receipts.altered = await x.send("seller", "fund", [altered, await x.sig("seller")], "0x0");
  const domain = x.protocol.domain;
  receipts.wrongChain = await x.send("seller", "fund", [x.terms, await x.sig("seller", x.terms, { ...domain, chainId: 1 })], "0x0");
  receipts.wrongContract = await x.send("seller", "fund", [x.terms, await x.sig("seller", x.terms, { ...domain, verifyingContract: x.w.legacy.address })], "0x0");
  const beforeFundingDelta = expectDelta(before, await x.snapshot());
  receipts.funded = await x.fund();
  const escrowed = await x.snapshot();
  receipts.replayedNonce = await x.send("seller", "fund", [altered, await x.sig("seller", altered)], "0x0");
  receipts.unrelatedBuyer = await x.send("other", "settle", [x.id, await x.sig("buyer")], "0x0");
  receipts.alteredBuyerTerms = await x.send("buyer", "settle", [x.id, await x.sig("buyer", altered)], "0x0");
  receipts.buyerWrongChain = await x.send("buyer", "settle", [x.id, await x.sig("buyer", x.terms, { ...domain, chainId: 1 })], "0x0");
  receipts.buyerWrongContract = await x.send("buyer", "settle", [x.id, await x.sig("buyer", x.terms, { ...domain, verifyingContract: x.w.legacy.address })], "0x0");
  await x.w.at(x.terms.expiry);
  receipts.expired = await x.send("buyer", "settle", [x.id, await x.sig("buyer")], "0x0");
  const afterFundingDelta = expectDelta(escrowed, await x.snapshot());
  receipts.refunded = await x.send("seller", "refund", [x.id]);
  expectDelta(before, await x.snapshot());
  report.scenarios.push({ case: "authorization", id: x.id, terms: x.terms, accounts: x.accounts,
    beforeFundingDelta, afterFundingDelta, receipts });
}
report.assertions.push("Wrong actor, altered terms, wrong chain, wrong verifying contract, nonce reuse and expiry yielded reverted receipts with zero token movement.");

for (const fixed of [false, true]) {
  const x = await setup({ fixed, terms: { delivery: 1n, cliffSeconds: 30n * day, durationSeconds: 90n * day } });
  await x.approve();
  const funded = await x.fund();
  const escrowed = await x.snapshot();
  const settled = await x.settle();
  const deal = await x.protocol.deal(x.id);
  const g = await x.protocol.grant(deal.grantId, "latest");
  x.accounts.vault = g.custodian;
  escrowed.vault = { base: 0n, quote: 0n };
  const settlementDelta = expectDelta(escrowed, await x.snapshot(), {
    buyer: { quote: -124_074_072n }, seller: { quote: 122_839_506n }, broker: { quote: 246_913n },
    treasury: { quote: 987_653n }, escrow: { base: -allocation }, vault: { base: allocation },
  });
  assert.equal(g.beneficiary.toLowerCase(), x.w.buyer);
  assert.equal(g.start, fixed ? x.terms.fixedStart : BigInt(await x.w.chain.now()));
  assert.deepEqual([g.claimable, g.held, g.end - g.start, g.cliff - g.start], [0n, allocation, 90n * day, 30n * day]);
  const immediate = await x.snapshot();
  const tooEarly = await x.send("buyer", "claim", [g.id], "0x0");
  expectDelta(immediate, await x.snapshot());
  await x.w.at(g.cliff);
  const wrongBeneficiary = await x.send("other", "claim", [g.id], "0x0");
  expectDelta(immediate, await x.snapshot());
  const cliff = await x.send("buyer", "claim", [g.id]);
  const partial = await x.snapshot();
  const first = allocation / 3n;
  const cliffDelta = expectDelta(immediate, partial, { buyer: { base: first }, vault: { base: -first } });
  await x.w.at(g.end);
  const end = await x.send("buyer", "claim", [g.id]);
  const endDelta = expectDelta(partial, await x.snapshot(), { buyer: { base: allocation - first }, vault: { base: -(allocation - first) } });
  const grant = await x.protocol.grant(g.id, "latest");
  assert.deepEqual([grant.claimed, grant.held], [allocation, 0n]);
  const head = Number(await x.w.chain.rpc("eth_blockNumber"));
  const events = await x.protocol.receipts(x.id, g.id, head);
  assert.deepEqual(events.map((e) => e.hash), [funded, settled, cliff, end].map((receipt) => receipt.transactionHash));
  assert.deepEqual(events.filter((e) => e.kind === "claimed").map((e) => e.amount), [first, allocation - first]);
  report.scenarios.push({ case: fixed ? "vesting with a fixed start" : "vesting from settlement", id: x.id, terms: x.terms,
    accounts: x.accounts, grantAtSettlement: g, grantAfterClaims: grant, settlementDelta, cliffDelta, endDelta, events,
    receipts: { funded, settled, tooEarly, wrongBeneficiary, cliff, end } });
}
report.assertions.push("Both vesting start modes created backed vaults. Fixed start matched the UTC form input and displayed UTC. Early and unrelated claims reverted. Cliff and final claims paid the exact base allocation and zero quote fees.");

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "contract-proof.json"), JSON.stringify(report, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n");
for (const assertion of report.assertions) console.log(assertion);
console.log(`${report.scenarios.length} scenarios · ${out}/contract-proof.json`);
