// BrokerDeals (version 3) beyond the round's checks, test by test under the acceptance id it proves (R3-01 to R3-05):
// the two complete flows with four independent wallets, who may fund, settle, refund and claim and with whose
// signature, the fees to the unit, settlements that fail, refunds, grants and their vaults, and calls back into the
// contract. Each test runs on a fresh chain (test/lib/v3-world.mjs) and compares what every party holds before and after.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { getCreateAddress, Interface, Signature, TypedDataEncoder, Wallet } from "ethers";
import { CHAIN_ID, contractAt, deploy, Reverted } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { ALLOCATION, artifacts, DAY, feeOn, feesOf, KIND, QUOTE, reverted, revertsWith, SIGNERS, STATUS3, TYPES, world, ZERO } from "./lib/v3-world.mjs";

const { Unfunded, Funded, Settled, Refunded } = STATUS3;
const FIELDS = TYPES.BrokerTerms;
const MAX_UINT64 = 2n ** 64n - 1n, MAX_UINT256 = 2n ** 256n - 1n;
/** An allocation that neither a third nor a half divides: rounding shows. */
const ODD = 900_000_000_000_000_000_001n;
/** The largest quote whose buyer total, the quote plus 0.5%, still fits a uint256. */
const LARGEST_QUOTE = (() => {
  let quote = (MAX_UINT256 * 200n) / 201n;
  while (quote + feeOn(quote) > MAX_UINT256) quote -= 1n;
  while (quote + 1n + feeOn(quote + 1n) <= MAX_UINT256) quote += 1n;
  return quote;
})();

const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);
const say = (terms) => JSON.stringify(terms, (_, v) => (typeof v === "bigint" ? String(v) : v));
/** Terms as a plain object, every address in lower case and every number a bigint: what a test wrote and what getDeal answers, alike. */
const plain = (terms) => Object.fromEntries(FIELDS.map(({ name, type }) => [name, type === "address" ? terms[name].toLowerCase() : BigInt(terms[name])]));
const NO_TERMS = Object.fromEntries(FIELDS.map(({ name, type }) => [name, type === "address" ? ZERO : 0n]));
/** Events as plain lists: the name, then the arguments. */
const listed = (events) => events.map((e) => [e.name, ...e.args.toArray().map(lower)]);

/** Deal `id` as it stands: its status, its grant and its terms. */
async function dealOf(w, id) {
  const { terms, status, grantId } = await w.v3.read.getDeal(id);
  return { status, grantId, terms: plain(terms) };
}

/** Grant `id` as it stands, as a plain object. */
const grantOf = async (w, id) => Object.fromEntries(Object.entries((await w.v3.read.getGrant(id)).toObject()).map(([key, value]) => [key, lower(value)]));

/** The name (seller, buyer, broker, other) of the wallet at `address`. */
const nameOf = (w, address) => Object.keys(SIGNERS).find((name) => w[name] === address.toLowerCase());
/** The seller of `t` funds it with its own signature. Nothing is minted or approved: w.stock does that. */
const fund = async (w, t) => w.v3.as(t.seller).fund(t, await w.sign(nameOf(w, t.seller), t));
/** The buyer of `t` settles it with its own signature. Nothing is minted or approved: w.ready3 does that. */
const settle = async (w, t) => w.v3.as(t.buyer).settle(w.idOf(t), await w.sign(nameOf(w, t.buyer), t));

/** `sending` reverts with `error`, and every party holds exactly what it held at `before`. */
async function refused(w, before, sending, error, what) {
  assert.equal(await revertsWith(sending), error, what);
  assert.deepEqual(await w.moved(before), {}, `${what}: nothing may move`);
}

const nonZero = (moves) => Object.fromEntries(Object.entries(moves).filter(([, delta]) => delta !== 0n));
/** The key holdings() gives to what the address `party` holds of the token at `token`: "seller.FAM". */
function keyOf(w, party, token) {
  const at = (address) => (other) => other.toLowerCase() === address.toLowerCase();
  const [name] = Object.entries(w.parties).find(([, address]) => at(party)(address));
  return `${name}.${Object.values(w.tokens).find((t) => at(token)(t.address)).symbol}`;
}
/** What the funding of `t` moves, by the keys of holdings(), and what its refund moves back. */
const funding = (w, t) => ({ [keyOf(w, t.seller, t.baseToken)]: -t.allocation, [keyOf(w, w.v3.address, t.baseToken)]: t.allocation });
const refunding = (w, t) => ({ [keyOf(w, t.seller, t.baseToken)]: t.allocation, [keyOf(w, w.v3.address, t.baseToken)]: -t.allocation });
/** What the settlement of `t` moves, by the keys of holdings(). `to` receives the allocation: the buyer, or the address of the grant's vault. */
function settlement(w, t, to = t.buyer) {
  const f = feesOf(t.quote, t.brokerBps), moves = {};
  const move = (party, token, delta) => (moves[keyOf(w, party, token)] = (moves[keyOf(w, party, token)] ?? 0n) + delta);
  move(t.buyer, t.quoteToken, -f.buyerTotal);
  move(t.seller, t.quoteToken, f.sellerNet);
  move(t.broker, t.quoteToken, f.brokerFee);
  move(w.treasury, t.quoteToken, f.treasuryFee);
  move(w.v3.address, t.baseToken, -t.allocation);
  move(to, t.baseToken, t.allocation);
  return nonZero(moves);
}

/** The events of the funding of `t`: the interface's own, which names the seller and the broker, and the one by which the buyer finds the deal. */
const fundedEvents = (w, t) => [["BrokerDealFunded", w.idOf(t), t.seller.toLowerCase(), t.broker.toLowerCase()], ["BrokerDealOffered", w.idOf(t), t.buyer.toLowerCase()]];

/** The one event of the settlement of `t` into grant `grantId` (0: delivered at once). */
function settledEvent(w, t, grantId = 0n) {
  const f = feesOf(t.quote, t.brokerBps);
  return ["BrokerDealSettled", w.idOf(t), t.buyer.toLowerCase(), f.buyerFee, f.sellerFee, f.brokerFee, f.treasuryFee, grantId];
}

/** The seller holds a hundred allocations of FAM and has approved them all: whatever `fund` refuses, it is not for want of tokens. */
async function plenty(w) {
  await w.fam.as(w.deployer).mint(w.seller, 100n * ALLOCATION);
  await w.fam.as(w.seller).approve(w.v3.address, 100n * ALLOCATION);
}

// ---------------------------------------------------------------------------------------------------------------------
// R3-01: the seller funds signed terms and the designated buyer settles them
// ---------------------------------------------------------------------------------------------------------------------

test("R3-01: the deal id is the EIP-712 digest of the terms for this contract on this chain (dealIdOf), and an id no deal has reads as status 0 and zeros", async () => {
  const w = await world();
  const { IBrokerDeals } = compile(join(ROOT, ".launchpad/checks"), "round-3/IBrokerDeals.sol");
  assert.deepEqual(FIELDS, IBrokerDeals.abi.find((f) => f.name === "fund").inputs[0].components.map(({ name, type }) => ({ name, type })),
    "the typed data both parties sign has the names, the types and the order of the round's BrokerTerms");
  assert.deepEqual(w.domain, { name: "OTC.fam Broker Deals", version: "3", chainId: CHAIN_ID, verifyingContract: w.v3.address });
  assert.equal(await w.v3.read.domainSeparator(), TypedDataEncoder.hashDomain(w.domain));

  const immediate = await w.terms3(), vesting = await w.vesting3({ fixedStart: (await w.chain.now()) + DAY });
  const widest = { ...vesting, allocation: MAX_UINT256, quote: MAX_UINT256, expiry: MAX_UINT64, nonce: MAX_UINT256, delivery: 255, fixedStart: MAX_UINT64,
    cliffSeconds: MAX_UINT64, durationSeconds: MAX_UINT64, brokerBps: 65_535 };
  for (const terms of [immediate, vesting, { ...immediate, nonce: 0n }, widest]) {
    const id = w.idOf(terms);
    assert.equal(await w.v3.read.dealIdOf(terms), id, say(terms));
    assert.notEqual(id, w.idOf(terms, { ...w.domain, chainId: 1 }), "the same terms on another chain have another id");
    assert.deepEqual(await dealOf(w, id), { status: Unfunded, grantId: 0n, terms: NO_TERMS }, "an id no deal has");
  }
  assert.deepEqual(await dealOf(w, `0x${"00".repeat(32)}`), { status: Unfunded, grantId: 0n, terms: NO_TERMS });
});

test("R3-01: immediate delivery with four independent wallets: the seller funds, the designated buyer settles; statuses 0, 1, 2, events, terms and holdings exact", async () => {
  const w = await world();
  assert.equal(new Set([w.seller, w.buyer, w.broker, w.other, w.treasury, w.v3.address.toLowerCase()]).size, 6, "the seller, the buyer, the broker, a stranger, the treasury and the contract are six addresses");
  const t = await w.terms3(), id = w.idOf(t);
  await w.stock(t);
  const start = await w.holdings();
  assert.equal((await dealOf(w, id)).status, Unfunded);

  assert.deepEqual(listed(await fund(w, t)), [["BrokerDealFunded", id, w.seller, w.broker], ["BrokerDealOffered", id, w.buyer]]);
  assert.deepEqual(await w.moved(start), { "seller.FAM": -ALLOCATION, "brokerDeals.FAM": ALLOCATION }, "funding moves the allocation into the contract, and no payment or fee");
  assert.deepEqual(await dealOf(w, id), { status: Funded, grantId: 0n, terms: plain(t) }, "getDeal answers exactly the signed terms");

  await w.ready3(t);
  const before = await w.holdings();
  assert.deepEqual(listed(await settle(w, t)), [settledEvent(w, t)]);
  assert.deepEqual(await w.moved(before), settlement(w, t));
  assert.deepEqual(await w.moved(before), { "buyer.USDC": -124_074_072n, "seller.USDC": 122_839_506n, "broker.USDC": 246_913n, "treasury.USDC": 987_653n,
    "brokerDeals.FAM": -ALLOCATION, "buyer.FAM": ALLOCATION }, "the same, with every figure written out");
  assert.deepEqual(await dealOf(w, id), { status: Settled, grantId: 0n, terms: plain(t) });
  const end = await w.holdings();
  for (const key of ["brokerDeals.FAM", "brokerDeals.USDC", "buyer.USDC", "seller.FAM", "other.FAM", "other.USDC"]) assert.equal(end[key], 0n, key);
  for (const idle of ["broker", "other", "treasury"]) assert.equal(Number(await w.chain.rpc("eth_getTransactionCount", [w[idle], "latest"])), 0, `the ${idle} sent no transaction`);
});

test("R3-01: vesting delivery with four independent wallets: the seller funds, the designated buyer settles into a grant and claims it; statuses, events, terms and holdings exact", async () => {
  const w = await world();
  const t = await w.vesting3(), id = w.idOf(t);
  await w.stock(t);
  const start = await w.holdings();
  assert.deepEqual(listed(await fund(w, t)), fundedEvents(w, t));
  assert.deepEqual(await w.moved(start), { "seller.FAM": -ALLOCATION, "brokerDeals.FAM": ALLOCATION });
  assert.deepEqual(await dealOf(w, id), { status: Funded, grantId: 0n, terms: plain(t) });

  await w.ready3(t);
  const before = await w.holdings(), at = (await w.chain.now()) + 100;
  await w.next(at);
  assert.deepEqual(listed(await settle(w, t)), [settledEvent(w, t, 1n)]);
  const grant = await grantOf(w, 1);
  w.watch("vault", grant.custodian);
  assert.deepEqual(await w.moved(before), settlement(w, t, grant.custodian), "the allocation goes into the grant's vault; the payment and the fees are those of an immediate deal");
  assert.deepEqual(await w.moved(before), { "buyer.USDC": -124_074_072n, "seller.USDC": 122_839_506n, "broker.USDC": 246_913n, "treasury.USDC": 987_653n,
    "brokerDeals.FAM": -ALLOCATION, "vault.FAM": ALLOCATION }, "the same, with every figure written out");
  assert.deepEqual(await dealOf(w, id), { status: Settled, grantId: 1n, terms: plain(t) });
  assert.deepEqual(grant, { token: w.fam.address.toLowerCase(), beneficiary: w.buyer, custodian: grant.custodian, allocation: ALLOCATION,
    start: BigInt(at), cliff: BigInt(at + 30 * DAY), end: BigInt(at + 90 * DAY), claimed: 0n });

  const settled = await w.holdings();
  await w.next(grant.cliff);
  assert.deepEqual(listed(await w.v3.as(w.buyer).claim(1)), [["GrantClaimed", 1n, w.buyer, ALLOCATION / 3n]]);
  await w.next(grant.end);
  assert.deepEqual(listed(await w.v3.as(w.buyer).claim(1)), [["GrantClaimed", 1n, w.buyer, ALLOCATION - ALLOCATION / 3n]]);
  assert.deepEqual(await w.moved(settled), { "vault.FAM": -ALLOCATION, "buyer.FAM": ALLOCATION }, "the claims move the grant from its vault to the buyer, and nothing else");
  for (const idle of ["broker", "other", "treasury"]) assert.equal(Number(await w.chain.rpc("eth_getTransactionCount", [w[idle], "latest"])), 0, `the ${idle} sent no transaction`);
});

test("R3-01: a funded deal its seller refunds goes through statuses 0, 1, 3 with BrokerDealRefunded, and every wallet holds what it started with", async () => {
  for (const terms of ["terms3", "vesting3"]) {
    const w = await world();
    const t = await w[terms](), id = w.idOf(t);
    await w.stock(t);
    const start = await w.holdings();
    await fund(w, t);
    assert.deepEqual(listed(await w.v3.as(w.seller).refund(id)), [["BrokerDealRefunded", id]], terms);
    assert.deepEqual(await dealOf(w, id), { status: Refunded, grantId: 0n, terms: plain(t) }, terms);
    assert.deepEqual(await w.moved(start), {}, terms);
  }
});

test("R3-01: tokens that answer nothing (as USDT does) work as the allocation and as the payment, delivered at once, vested or refunded", async () => {
  for (const terms of ["terms3", "vesting3"]) {
    const w = await world();
    const quiet = await w.token("QUIET", 18, "NoReturnToken"), usdt = await w.token("USDT", 6, "NoReturnToken");
    const t = await w[terms]({ baseToken: quiet.address, quoteToken: usdt.address }), back = await w[terms]({ baseToken: quiet.address, quoteToken: usdt.address, allocation: 7n });
    await w.fund3(t);
    await w.fund3(back);
    await w.ready3(t);
    const before = await w.holdings();
    const [{ args: { grantId } }] = await settle(w, t), grant = await grantOf(w, grantId);
    if (grantId) w.watch("vault", grant.custodian);
    assert.deepEqual(await w.moved(before), settlement(w, t, grantId ? grant.custodian : t.buyer), terms);
    if (grantId) {
      await w.next(grant.end);
      await w.v3.as(w.buyer).claim(grantId);
    }
    await w.v3.as(w.seller).refund(w.idOf(back));
    assert.deepEqual(await w.moved(before), { ...settlement(w, t), "seller.QUIET": 7n, "brokerDeals.QUIET": -ALLOCATION - 7n },
      `${terms}: in the end the buyer holds the allocation, the seller the payment and the refunded deal's tokens, and the contract nothing`);
    assert.equal((await w.holdings())["brokerDeals.QUIET"], 0n);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// R3-02: the exact terms, the domain, the actor, the nonce and the expiry constrain authorization
// ---------------------------------------------------------------------------------------------------------------------

test("R3-02: only the seller funds, and only with its own signature: a broker, a buyer or a stranger who holds the seller's valid signature funds nothing", async () => {
  const w = await world();
  const t = await w.terms3(), id = w.idOf(t);
  await w.stock(t);
  const signature = {};
  for (const name of Object.keys(SIGNERS)) signature[name] = await w.sign(name, t);
  const before = await w.holdings();
  for (const who of ["broker", "buyer", "other"]) {
    await refused(w, before, w.v3.as(w[who]).fund(t, signature.seller), "NotSeller", `the ${who} sends the seller's valid signature`);
    await refused(w, before, w.v3.as(w[who]).fund(t, signature[who]), "NotSeller", `the ${who} sends its own signature`);
    await refused(w, before, w.v3.as(w.seller).fund(t, signature[who]), "BadSignature", `the seller sends the ${who}'s signature`);
  }
  assert.deepEqual(await reverted(w.v3.as(w.broker).fund(t, signature.seller)), { name: "NotSeller", args: [SIGNERS.seller.address] }, "the error names the seller of the terms");
  assert.deepEqual(await reverted(w.v3.as(w.seller).fund(t, signature.buyer)), { name: "BadSignature", args: [SIGNERS.seller.address] }, "the error names whose signature is missing");
  assert.deepEqual(await dealOf(w, id), { status: Unfunded, grantId: 0n, terms: NO_TERMS });
  assert.equal(await w.v3.read.nonceUsed(w.seller, t.nonce), false, "a refused fund spends no nonce");

  await w.v3.as(w.seller).fund(t, signature.seller);
  assert.deepEqual(await w.moved(before), { "seller.FAM": -ALLOCATION, "brokerDeals.FAM": ALLOCATION }, "the seller's own transaction with the seller's own signature");
});

test("R3-02: only the designated buyer settles, and only with its own signature of these terms: a seller, a broker or a stranger who holds the buyer's valid signature settles nothing", async () => {
  const w = await world();
  const t = await w.terms3(), id = await w.fund3(t), cheaper = { ...t, quote: t.quote - 1n };
  // Every wallet holds the payment and has approved it: authority is all the others lack.
  for (const who of ["seller", "broker", "other", "buyer"]) await w.ready3({ ...t, buyer: w[who] });
  const signature = {};
  for (const name of Object.keys(SIGNERS)) signature[name] = await w.sign(name, t);
  const before = await w.holdings();
  for (const who of ["seller", "broker", "other"]) {
    await refused(w, before, w.v3.as(w[who]).settle(id, signature.buyer), "NotBuyer", `the ${who} sends the buyer's valid signature`);
    await refused(w, before, w.v3.as(w[who]).settle(id, signature[who]), "NotBuyer", `the ${who} sends its own signature`);
    await refused(w, before, w.v3.as(w.buyer).settle(id, signature[who]), "BadSignature", `the buyer sends the ${who}'s signature`);
  }
  await refused(w, before, w.v3.as(w.buyer).settle(id, await w.sign("buyer", cheaper)), "BadSignature", "the buyer's signature of a lower price");
  await refused(w, before, w.v3.as(w.buyer).settle(w.idOf(cheaper), await w.sign("buyer", cheaper)), "NotFunded", "terms the seller never funded");
  assert.deepEqual(await reverted(w.v3.as(w.broker).settle(id, signature.buyer)), { name: "NotBuyer", args: [SIGNERS.buyer.address] }, "the error names the buyer of the deal");
  assert.equal((await dealOf(w, id)).status, Funded);

  await w.v3.as(w.buyer).settle(id, signature.buyer);
  assert.deepEqual(await w.moved(before), settlement(w, t), "the buyer's own transaction with the buyer's own signature");
  const settled = await w.holdings();
  await refused(w, settled, w.v3.as(w.buyer).settle(id, signature.buyer), "NotFunded", "a deal settles once");
});

test("R3-02: neither party's signature covers terms that differ in any one of the 14 fields: fund and settle refuse them and move nothing", async () => {
  for (const { name: field } of FIELDS) {
    const w = await world();
    const alt = await w.token("ALT", 18), dai = await w.token("DAI", 6);
    // Vesting terms with a fixed start: every field has another value that leaves a deal the contract would take.
    const signed = await w.vesting3({ fixedStart: (await w.chain.now()) + 2 * DAY });
    const other = { seller: w.other, buyer: w.other, baseToken: alt.address, quoteToken: dai.address, allocation: signed.allocation - 1n, quote: signed.quote + 1n,
      expiry: signed.expiry + 1, nonce: signed.nonce + 1n, delivery: 0, fixedStart: signed.fixedStart + 1, cliffSeconds: signed.cliffSeconds + 1,
      durationSeconds: signed.durationSeconds + 1, broker: w.treasury, brokerBps: signed.brokerBps + 1 };
    assert.deepEqual(Object.keys(other), FIELDS.map((f) => f.name), "one change for each field of BrokerTerms");
    const sent = { ...signed, [field]: other[field] }, id = w.idOf(sent);
    const sellerSignature = await w.sign("seller", signed), buyerSignature = await w.sign("buyer", signed);
    assert.equal(await w.v3.read.dealIdOf(sent), id);
    assert.notEqual(id, w.idOf(signed), `${field} is part of the digest`);

    // Whoever is the seller and the buyer of the terms sent holds the tokens and has approved them.
    await w.stock(sent);
    await w.ready3(sent);
    const before = await w.holdings();
    // Immediate delivery with a schedule is no deal at all: the terms are refused before any signature is read.
    const error = field === "delivery" ? "ScheduleOnImmediate" : "BadSignature";
    await refused(w, before, w.v3.as(sent.seller).fund(sent, sellerSignature), error, `${field}: fund with the seller's signature of the terms before the change`);
    if (field === "seller") await refused(w, before, w.v3.as(w.seller).fund(sent, sellerSignature), "NotSeller", "the signer is not the seller of the terms sent");
    for (const terms of [signed, sent]) assert.equal((await dealOf(w, w.idOf(terms))).status, Unfunded, field);
    assert.equal(await w.v3.read.nonceUsed(sent.seller, sent.nonce), false, `${field}: no nonce is spent`);
    if (field === "delivery") {
      await refused(w, before, fund(w, sent), error, "nobody funds such terms, signed or not");
      continue;
    }

    // The terms sent are a deal of their own once their seller signs them; the buyer's signature of the other terms does not settle it.
    assert.deepEqual(listed(await fund(w, sent)), fundedEvents(w, sent), `${field}: the events name the seller, the broker and the buyer of the terms sent`);
    assert.deepEqual(await w.moved(before), funding(w, sent), `${field}: with their seller's own signature the terms sent are funded`);
    const funded = await w.holdings();
    await refused(w, funded, w.v3.as(sent.buyer).settle(id, buyerSignature), "BadSignature", `${field}: settle with the buyer's signature of the terms before the change`);
    if (field === "buyer") await refused(w, funded, w.v3.as(w.buyer).settle(id, buyerSignature), "NotBuyer", "the signer is not the buyer of the deal");
    assert.equal((await dealOf(w, id)).status, Funded, field);
    assert.deepEqual(listed(await settle(w, sent)), [settledEvent(w, sent, 1n)], field);
    assert.deepEqual(await dealOf(w, id), { status: Settled, grantId: 1n, terms: plain(sent) }, `${field}: with their own two signatures the terms sent do settle`);
    const { custodian } = await grantOf(w, 1);
    w.watch("vault", custodian);
    assert.deepEqual(await w.moved(funded), settlement(w, sent, custodian), `${field}: and they move what they say`);
  }
});

test("R3-02: a value that does not fit its field's type is not read as terms: the call reverts and nothing moves", async () => {
  const w = await world();
  const t = await w.terms3();
  await w.stock(t);
  const data = w.v3.interface.encodeFunctionData("fund", [t, await w.sign("seller", t)]);
  const before = await w.holdings();
  // The call's data: the selector, then one 32-byte word for each field of the terms.
  for (const [field, bits] of [["seller", 160n], ["expiry", 64n], ["delivery", 8n], ["brokerBps", 16n]]) {
    const at = 2 + 8 + 64 * FIELDS.findIndex((f) => f.name === field);
    const word = BigInt(`0x${data.slice(at, at + 64)}`) | (1n << bits); // the signed value, with one bit set above its type
    const receipt = await w.chain.rpc("eth_getTransactionReceipt", [await w.chain.submit(w.seller, { to: w.v3.address, data: `${data.slice(0, at)}${word.toString(16).padStart(64, "0")}${data.slice(at + 64)}` })]);
    assert.equal(receipt.status, "0x0", field);
    assert.deepEqual(await w.moved(before), {}, field);
  }
  assert.equal((await dealOf(w, w.idOf(t))).status, Unfunded);
  await w.chain.send(w.seller, { to: w.v3.address, data });
  assert.deepEqual(await w.moved(before), funding(w, t), "the same data without the stray bit funds the deal");
  assert.deepEqual(await dealOf(w, w.idOf(t)), { status: Funded, grantId: 0n, terms: plain(t) });
});

test("R3-02: a signature made for another chain id, another verifying contract, another name or another version neither funds nor settles", async () => {
  const w = await world();
  const twin = await deploy(w.chain, w.deployer, artifacts().BrokerDeals, [w.treasury], { label: "BrokerDeals (twin)" });
  w.watch("twin", twin.address);
  const elsewhere = {
    "another chain id": { ...w.domain, chainId: CHAIN_ID + 1 },
    "mainnet": { ...w.domain, chainId: 1 },
    "a verifying contract that is a wallet": { ...w.domain, verifyingContract: w.other },
    "a second BrokerDeals on this chain": { ...w.domain, verifyingContract: twin.address },
    "another name": { ...w.domain, name: "OTC.fam Deals" },
    "version 2": { ...w.domain, version: "2" },
  };
  const t = await w.terms3(), id = w.idOf(t);
  await w.stock(t);
  const before = await w.holdings();
  for (const [what, scope] of Object.entries(elsewhere)) {
    assert.notEqual(w.idOf(t, scope), id, what);
    await refused(w, before, w.v3.as(w.seller).fund(t, await w.sign("seller", t, scope)), "BadSignature", `fund with the seller's signature for ${what}`);
  }
  assert.equal((await dealOf(w, id)).status, Unfunded);

  await fund(w, t);
  assert.deepEqual(await w.moved(before), funding(w, t), "the seller's signature for this contract on this chain");
  await w.ready3(t);
  const funded = await w.holdings();
  for (const [what, scope] of Object.entries(elsewhere)) {
    const signature = await w.sign("buyer", t, scope);
    await refused(w, funded, w.v3.as(w.buyer).settle(id, signature), "BadSignature", `settle with the buyer's signature for ${what}`);
    await refused(w, funded, w.v3.as(w.buyer).settle(w.idOf(t, scope), signature), "NotFunded", `the id the deal would have for ${what} is no deal here`);
  }
  assert.equal((await dealOf(w, id)).status, Funded);

  // The other way round: on the twin, this contract's deal does not exist and this contract's signatures say nothing.
  const there = { ...w.domain, verifyingContract: twin.address };
  await w.fam.as(w.deployer).mint(w.seller, t.allocation);
  await w.fam.as(w.seller).approve(twin.address, t.allocation);
  const stocked = await w.holdings();
  await refused(w, stocked, twin.as(w.seller).fund(t, await w.sign("seller", t)), "BadSignature", "the twin, with the seller's signature for the first contract");
  await refused(w, stocked, twin.as(w.buyer).settle(id, await w.sign("buyer", t)), "NotFunded", "the twin, asked to settle the first contract's deal");
  await twin.as(w.seller).fund(t, await w.sign("seller", t, there));
  assert.deepEqual(await w.moved(stocked), { "seller.FAM": -ALLOCATION, "twin.FAM": ALLOCATION });
  assert.equal(await twin.read.dealIdOf(t), w.idOf(t, there), "the same terms are another deal there, under another id");

  const twice = await w.holdings();
  await settle(w, t);
  assert.deepEqual(await w.moved(twice), settlement(w, t), "the buyer's signature for this contract on this chain settles this contract's deal, and leaves the twin's alone");
});

test("R3-02: a deal settles until the last second before its expiry and never from the expiry on, and it is funded only while its expiry is in the future", async () => {
  const w = await world();
  const expiry = (await w.chain.now()) + DAY;
  const inTime = await w.terms3({ expiry }), late = await w.terms3({ expiry }), fundedInTime = await w.terms3({ expiry }), fundedLate = await w.terms3({ expiry });
  await w.fund3(inTime);
  await w.fund3(late);
  // Everything else is in order before the clock moves: two more allocations approved, and both payments.
  for (const t of [fundedInTime, fundedLate]) await w.stock(t);
  await w.fam.as(w.seller).approve(w.v3.address, 2n * ALLOCATION);
  for (const t of [inTime, late]) await w.ready3(t);
  await w.usdc.as(w.buyer).approve(w.v3.address, 2n * (QUOTE + feeOn(QUOTE)));

  const ready = await w.holdings();
  await w.next(expiry - 1);
  await fund(w, fundedInTime);
  assert.deepEqual(await w.moved(ready), funding(w, fundedInTime), "funded in the last second before the expiry");
  await w.next(expiry - 1);
  const start = await w.holdings();
  await settle(w, inTime);
  assert.equal(await w.chain.now(), expiry - 1, "the block of the settlement is one second before the expiry");
  assert.deepEqual(await w.moved(start), settlement(w, inTime));
  assert.deepEqual([(await dealOf(w, w.idOf(fundedInTime))).status, (await dealOf(w, w.idOf(inTime))).status], [Funded, Settled]);

  const before = await w.holdings();
  await w.next(expiry);
  await refused(w, before, settle(w, late), "DealExpired", "settle at exactly the expiry");
  assert.equal(await w.chain.now(), expiry, "the block of the refused settlement is at the expiry");
  await w.next(expiry);
  await refused(w, before, fund(w, fundedLate), "ExpiryNotInFuture", "fund at exactly the expiry");
  await w.at(expiry + DAY);
  await refused(w, before, settle(w, late), "DealExpired", "settle a day after the expiry");
  await refused(w, before, fund(w, fundedLate), "ExpiryNotInFuture", "fund a day after the expiry");
  await refused(w, before, w.v3.as(w.other).settle(w.idOf(late), await w.sign("buyer", late)), "DealExpired", "a stranger, after the expiry");
  assert.deepEqual([(await dealOf(w, w.idOf(late))).status, (await dealOf(w, w.idOf(fundedLate))).status], [Funded, Unfunded]);
  assert.equal(await w.v3.read.nonceUsed(w.seller, fundedLate.nonce), false);
});

test("R3-02: a seller uses a nonce once: not for other terms, not for the same terms again, not after a refund and not after a settlement", async () => {
  const w = await world();
  await plenty(w);
  const refusedAgain = async (t, when) => {
    const before = await w.holdings();
    for (const terms of [t, { ...t, quote: t.quote + 1n }, { ...t, buyer: w.other }]) {
      await refused(w, before, fund(w, terms), "NonceUsed", `${when}: ${terms === t ? "the same terms again" : "other terms with the same nonce"}`);
      if (terms !== t) assert.equal((await dealOf(w, w.idOf(terms))).status, Unfunded);
    }
  };

  const t = await w.terms3(), id = w.idOf(t);
  assert.equal(await w.v3.read.nonceUsed(w.seller, t.nonce), false);
  await fund(w, t);
  assert.equal(await w.v3.read.nonceUsed(w.seller, t.nonce), true);
  await refusedAgain(t, "while the deal is funded");
  assert.deepEqual(await reverted(fund(w, t)), { name: "NonceUsed", args: [SIGNERS.seller.address, t.nonce] });
  await w.v3.as(w.seller).refund(id);
  await refusedAgain(t, "after the refund");
  assert.equal((await dealOf(w, id)).status, Refunded, "a refunded deal is not funded again");

  const u = await w.terms3();
  await fund(w, u);
  await w.settle3(u);
  await refusedAgain(u, "after the settlement");
  assert.equal((await dealOf(w, w.idOf(u))).status, Settled);

  // A nonce belongs to one seller, a refused fund spends none, and nonces need no order.
  assert.equal(await w.v3.read.nonceUsed(w.other, t.nonce), false);
  const theirs = await w.terms3({ seller: w.other, nonce: t.nonce, allocation: 5n });
  await w.stock(theirs);
  await fund(w, theirs);
  assert.equal((await dealOf(w, w.idOf(theirs))).status, Funded, "another seller, the same nonce");
  const next = await w.terms3();
  assert.equal(await revertsWith(w.v3.as(w.seller).fund(next, await w.sign("buyer", next))), "BadSignature");
  assert.equal(await w.v3.read.nonceUsed(w.seller, next.nonce), false);
  for (const terms of [next, await w.terms3({ nonce: MAX_UINT256 }), await w.terms3({ nonce: 0n })]) {
    await fund(w, terms);
    assert.equal((await dealOf(w, w.idOf(terms))).status, Funded, `nonce ${terms.nonce}`);
  }
});

/** A signature's three parts, and a signature of three parts. */
const parts = (signature) => ({ r: signature.slice(2, 66), s: signature.slice(66, 130), v: parseInt(signature.slice(130), 16) });
const joined = (r, s, v) => `0x${r}${s}${v.toString(16).padStart(2, "0")}`;
/** The order of the curve secp256k1. */
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** The other signature the same key gives the same message: s in the upper half of the order, and the other v. */
function highS(signature) {
  const { r, s, v } = parts(signature);
  return joined(r, (ORDER - BigInt(`0x${s}`)).toString(16).padStart(64, "0"), v === 27 ? 28 : 27);
}
/** Who the chain's own ecrecover says signed `digest`. */
async function recovered(w, digest, signature) {
  const { r, s, v } = parts(signature);
  const answer = await w.chain.rpc("eth_call", [{ to: `0x${"1".padStart(40, "0")}`, data: `${digest}${v.toString(16).padStart(64, "0")}${r}${s}` }, "latest"]);
  return `0x${answer.slice(-40)}`;
}
/** Ways to write a signature that are not the signature itself. */
function otherForms(signature) {
  const { r, s, v } = parts(signature);
  return {
    "an empty signature": "0x",
    "64 bytes, r and s without v": `0x${r}${s}`,
    "64 bytes, the compact form of EIP-2098": Signature.from(signature).compactSerialized,
    "66 bytes": `${signature}00`,
    "the high-s twin": highS(signature),
    "the other v": joined(r, s, v === 27 ? 28 : 27),
    "a v of 2": joined(r, s, 2),
    "a v of 29": joined(r, s, 29),
    "65 zero bytes": `0x${"00".repeat(65)}`,
  };
}

test("R3-02: a signature is 65 bytes with s in the lower half: empty, 64-byte and 66-byte ones and the high-s twin are refused, and a v of 0 or 1 is read as 27 or 28", async () => {
  const w = await world();
  const t = await w.terms3(), id = w.idOf(t);
  await w.stock(t);
  await w.ready3(t);
  const before = await w.holdings();

  const sellerSignature = await w.sign("seller", t), sellerForms = otherForms(sellerSignature);
  assert.deepEqual([64, 64, 66, 65].map((bytes) => 2 + 2 * bytes), ["64 bytes, r and s without v", "64 bytes, the compact form of EIP-2098", "66 bytes", "the high-s twin"].map((form) => sellerForms[form].length));
  assert.equal(await recovered(w, id, sellerSignature), w.seller);
  assert.equal(await recovered(w, id, sellerForms["the high-s twin"]), w.seller, "the twin is the seller's signature too, for the chain's ecrecover: the contract is what refuses it");
  for (const [form, signature] of Object.entries(sellerForms)) await refused(w, before, w.v3.as(w.seller).fund(t, signature), "BadSignature", `fund with ${form}`);
  assert.equal((await dealOf(w, id)).status, Unfunded);
  const { r, s, v } = parts(sellerSignature);
  await w.v3.as(w.seller).fund(t, joined(r, s, v - 27));
  assert.deepEqual(await w.moved(before), funding(w, t), `fund with v written as ${v - 27}`);
  assert.equal((await dealOf(w, id)).status, Funded);

  const funded = await w.holdings();
  const buyerSignature = await w.sign("buyer", t), buyerForms = otherForms(buyerSignature);
  assert.equal(await recovered(w, id, buyerForms["the high-s twin"]), w.buyer);
  for (const [form, signature] of Object.entries(buyerForms)) await refused(w, funded, w.v3.as(w.buyer).settle(id, signature), "BadSignature", `settle with ${form}`);
  assert.equal((await dealOf(w, id)).status, Funded);
  const mine = parts(buyerSignature);
  await w.v3.as(w.buyer).settle(id, joined(mine.r, mine.s, mine.v - 27));
  assert.deepEqual(await w.moved(funded), settlement(w, t), `settle with v written as ${mine.v - 27}`);
});

test("R3-02: fund refuses terms that name no deal the contract could settle (amounts, tokens, parties, broker, expiry), although the seller signed them, and takes nothing", async () => {
  const w = await world();
  const now = await w.chain.now();
  await plenty(w);
  const t = await w.terms3();
  const before = await w.holdings();
  for (const [change, error] of [
    [{ allocation: 0n }, "ZeroAmount"],
    [{ quote: 0n }, "ZeroAmount"],
    [{ quote: LARGEST_QUOTE + 1n }, "QuoteTooLarge"],
    [{ quote: MAX_UINT256 }, "QuoteTooLarge"],
    [{ quoteToken: w.fam.address }, "SameToken"],
    [{ baseToken: w.usdc.address }, "SameToken"],
    [{ baseToken: w.other }, "NotAToken"], // a wallet
    [{ quoteToken: w.other }, "NotAToken"],
    [{ baseToken: ZERO }, "NotAToken"],
    [{ quoteToken: ZERO }, "NotAToken"],
    [{ buyer: ZERO }, "NoBuyer"],
    [{ buyer: w.seller }, "BuyerIsSeller"],
    [{ broker: ZERO }, "BadBroker"],
    [{ broker: w.seller }, "BadBroker"],
    [{ broker: w.buyer }, "BadBroker"],
    [{ broker: w.v3.address }, "BadBroker"],
    [{ brokerBps: 10_001 }, "BrokerShareTooLarge"],
    [{ brokerBps: 65_535 }, "BrokerShareTooLarge"],
    [{ expiry: now }, "ExpiryNotInFuture"],
    [{ expiry: 0 }, "ExpiryNotInFuture"],
  ]) {
    const terms = { ...t, ...change };
    await refused(w, before, fund(w, terms), error, say(change));
    assert.equal((await dealOf(w, w.idOf(terms))).status, Unfunded, say(change));
  }
  // A contract that is no token passes for one until it is asked for a balance. As the base token it fails the funding.
  await assert.rejects(fund(w, { ...t, baseToken: w.legacy.address }), Reverted, "a base token that is the round 1 deal contract");
  assert.deepEqual(await w.moved(before), {});
  assert.equal(await w.v3.read.nonceUsed(w.seller, t.nonce), false, "no refused terms spent the nonce");
  // As the payment token it is only asked at the settlement: such a deal is funded, never settled, and refunded whole.
  const unpayable = await w.terms3({ quoteToken: w.legacy.address, allocation: 5n });
  assert.equal((await dealOf(w, await fundAndBack(w, unpayable))).status, Refunded);

  // The same terms, valid: each is funded, and so are the values at the edges that still fit.
  const accepted = [t, await w.terms3({ quote: LARGEST_QUOTE }), await w.terms3({ quote: 1n, allocation: 1n }), await w.terms3({ brokerBps: 0 }), await w.terms3({ brokerBps: 10_000 }),
    await w.terms3({ broker: w.treasury }), await w.terms3({ expiry: MAX_UINT64 })];
  for (const terms of accepted) {
    await fund(w, terms);
    assert.deepEqual(await dealOf(w, w.idOf(terms)), { status: Funded, grantId: 0n, terms: plain(terms) }, say(terms));
  }
  assert.deepEqual(await w.moved(before), { "seller.FAM": -(6n * ALLOCATION + 1n), "brokerDeals.FAM": 6n * ALLOCATION + 1n });
});

/** Funds `terms`, proves that its buyer cannot settle it, and refunds it; returns the deal's id. */
async function fundAndBack(w, terms) {
  const id = w.idOf(terms);
  await fund(w, terms);
  const before = await w.holdings();
  await assert.rejects(settle(w, terms), Reverted);
  assert.deepEqual(await w.moved(before), {});
  await w.v3.as(w.seller).refund(id);
  assert.deepEqual(await w.moved(before), refunding(w, terms));
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
// R3-03: the quotes and broker shares conserve exact raw balances
// ---------------------------------------------------------------------------------------------------------------------

/** USDC units as a person reads them: 100_500_000_000n is "100,500". */
const amount = (units) => `${(units / 10n ** 6n).toLocaleString("en-US")}${units % 10n ** 6n ? `.${String(units % 10n ** 6n).padStart(6, "0").replace(/0+$/, "")}` : ""}`;
/** The brief's two quotes at its two broker shares, every figure written out: the quote, the share, what the buyer pays, the seller receives, the broker and the treasury. */
const PUBLISHED = [
  [100_000_000_000n, 0, 100_500_000_000n, 99_500_000_000n, 0n, 1_000_000_000n],
  [100_000_000_000n, 2_000, 100_500_000_000n, 99_500_000_000n, 200_000_000n, 800_000_000n],
  [123_456_789n, 0, 124_074_072n, 122_839_506n, 0n, 1_234_566n],
  [123_456_789n, 2_000, 124_074_072n, 122_839_506n, 246_913n, 987_653n],
];

for (const [quote, brokerBps, buyerPays, sellerGets, brokerGets, treasuryGets] of PUBLISHED) {
  test(`R3-03: ${amount(quote)} USDC at a broker share of ${brokerBps} bps: the buyer pays ${amount(buyerPays)}, the seller receives ${amount(sellerGets)}, the broker ${amount(brokerGets)} and the treasury ${amount(treasuryGets)}, to the unit`, async () => {
    assert.equal(buyerPays, sellerGets + brokerGets + treasuryGets, "what the buyer pays is exactly what the three others receive");
    for (const terms of ["terms3", "vesting3"]) {
      const w = await world();
      const t = await w[terms]({ quote, brokerBps }), id = await w.fund3(t), fee = buyerPays - quote;
      await w.ready3(t);
      const before = await w.holdings();
      assert.equal(before["buyer.USDC"], buyerPays, "the buyer holds the quote and the buyer fee, and not a unit more");
      const [settled] = await settle(w, t);
      const to = settled.args.grantId ? "vault" : "buyer";
      if (settled.args.grantId) w.watch("vault", (await grantOf(w, settled.args.grantId)).custodian);

      assert.deepEqual(listed([settled]), [["BrokerDealSettled", id, w.buyer, fee, fee, brokerGets, treasuryGets, settled.args.grantId]], terms);
      assert.deepEqual([...await w.v3.read.feesOf(quote, brokerBps)], [fee, fee, brokerGets, treasuryGets], "feesOf answers what the event says");
      assert.deepEqual(await w.moved(before), nonZero({ "buyer.USDC": -buyerPays, "seller.USDC": sellerGets, "broker.USDC": brokerGets, "treasury.USDC": treasuryGets,
        "brokerDeals.FAM": -ALLOCATION, [`${to}.FAM`]: ALLOCATION }), terms);
      const end = await w.holdings();
      assert.deepEqual([end["buyer.USDC"], end["brokerDeals.USDC"], end["other.USDC"]], [0n, 0n, 0n], "nothing stays with the buyer or the contract, and nothing reaches a stranger");
    }
  });
}

test("R3-03: fee rounding at the edges: quotes of 1, 199 and 200 units, broker shares of 1 bps and of everything; a fee of zero is not transferred at all", async () => {
  const w = await world();
  const usd = await w.token("USD", 6, "PlainToken"); // the checks' plain token logs every transfer, a transfer of zero too
  for (const [quote, brokerBps, fee, brokerFee, treasuryFee] of [
    [1n, 2_000, 0n, 0n, 0n],
    [199n, 2_000, 0n, 0n, 0n],
    [199n, 10_000, 0n, 0n, 0n],
    [200n, 0, 1n, 0n, 2n],
    [200n, 1, 1n, 0n, 2n],
    [200n, 4_999, 1n, 0n, 2n],
    [200n, 5_000, 1n, 1n, 1n],
    [200n, 9_999, 1n, 1n, 1n],
    [200n, 10_000, 1n, 2n, 0n],
    [399n, 2_000, 1n, 0n, 2n],
    [QUOTE, 1, 617_283n, 123n, 1_234_443n],
    [QUOTE, 9_999, 617_283n, 1_234_442n, 124n],
    [QUOTE, 10_000, 617_283n, 1_234_566n, 0n],
    [100_000_000_000n, 1, 500_000_000n, 100_000n, 999_900_000n],
    [100_000_000_000n, 10_000, 500_000_000n, 1_000_000_000n, 0n],
  ]) {
    const t = await w.terms3({ quoteToken: usd.address, quote, brokerBps }), id = await w.fund3(t), what = `quote ${quote}, broker share ${brokerBps} bps`;
    await w.ready3(t);
    const before = await w.holdings();
    const receipt = await w.chain.send(w.buyer, { to: w.v3.address, data: w.v3.interface.encodeFunctionData("settle", [id, await w.sign("buyer", t)]) });
    const logsOf = (contract) => listed(receipt.logs.filter((l) => l.address.toLowerCase() === contract.address.toLowerCase()).map((l) => contract.interface.parseLog(l)));

    assert.deepEqual(logsOf(w.v3), [["BrokerDealSettled", id, w.buyer, fee, fee, brokerFee, treasuryFee, 0n]], what);
    assert.deepEqual([...await w.v3.read.feesOf(quote, brokerBps)], [fee, fee, brokerFee, treasuryFee], what);
    assert.deepEqual(feesOf(quote, brokerBps), { buyerFee: fee, sellerFee: fee, brokerFee, treasuryFee, buyerTotal: quote + fee, sellerNet: quote - fee }, what);
    assert.deepEqual(await w.moved(before), settlement(w, t), what);
    const here = w.v3.address.toLowerCase();
    assert.deepEqual(logsOf(usd), [["Transfer", w.buyer, here, quote + fee], ["Transfer", here, w.seller, quote - fee],
      ...(brokerFee ? [["Transfer", here, w.broker, brokerFee]] : []), ...(treasuryFee ? [["Transfer", here, w.treasury, treasuryFee]] : [])], `${what}: the payment token's transfers`);
  }

  // The largest quote the contract takes settles to the unit as well.
  const big = await w.token("BIG", 6, "PlainToken");
  const t = await w.terms3({ quoteToken: big.address, quote: LARGEST_QUOTE, brokerBps: 3_333 });
  await w.fund3(t);
  await w.ready3(t);
  const before = await w.holdings();
  assert.deepEqual(listed(await settle(w, t)), [settledEvent(w, t)]);
  assert.deepEqual(await w.moved(before), settlement(w, t));
  assert.ok(MAX_UINT256 - before["buyer.BIG"] <= 1n, "the buyer paid a total within a unit of the largest number a token can hold");
});

test("R3-03: feesOf rounds each side's fee down on its own and the broker's share of both down, the treasury takes the rest, and a share above 10,000 bps is refused", async () => {
  const w = await world();
  let seed = 20261125n;
  const random = (below) => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n) % below;
  const quotes = [1n, 199n, 200n, 201n, 399n, 400n, QUOTE, 100_000_000_000n, 10n ** 30n + 7n, LARGEST_QUOTE, MAX_UINT256];
  for (let i = 0; i < 30; i++) quotes.push(random(2n ** 64n) ** (1n + random(4n)) + 1n);
  for (const quote of quotes) {
    for (const brokerBps of [0, 1, 2_000, 9_999, 10_000, Number(random(10_001n))]) {
      const [buyerFee, sellerFee, brokerFee, treasuryFee] = await w.v3.read.feesOf(quote, brokerBps), what = `quote ${quote}, broker share ${brokerBps} bps`;
      assert.deepEqual([buyerFee, sellerFee], [(quote * 50n) / 10_000n, (quote * 50n) / 10_000n], what);
      assert.equal(brokerFee, ((buyerFee + sellerFee) * BigInt(brokerBps)) / 10_000n, what);
      assert.equal(treasuryFee, buyerFee + sellerFee - brokerFee, what);
    }
  }
  for (const brokerBps of [10_001, 65_535]) assert.equal(await revertsWith(w.v3.read.feesOf(QUOTE, brokerBps)), "BrokerShareTooLarge");
  await plenty(w);
  const t = await w.terms3({ brokerBps: 10_001 }), before = await w.holdings();
  await refused(w, before, fund(w, t), "BrokerShareTooLarge", "terms with a broker share of 10,001 bps");
});

test("R3-03: a rejected settlement and a refund pay zero to everyone, at each published quote and broker share", async () => {
  for (const [quote, brokerBps, buyerPays] of PUBLISHED) {
    const w = await world();
    const t = await w.terms3({ quote, brokerBps }), id = w.idOf(t);
    await w.stock(t);
    await w.ready3(t);
    const start = await w.holdings();
    await fund(w, t);
    const funded = await w.holdings();
    await w.usdc.as(w.buyer).approve(w.v3.address, buyerPays - 1n);
    await refused(w, funded, settle(w, t), "TransferFailed", `${amount(quote)} USDC: an approval one unit short of the quote and the buyer fee`);
    await w.usdc.as(w.buyer).approve(w.v3.address, buyerPays);
    await refused(w, funded, w.v3.as(w.broker).settle(id, await w.sign("buyer", t)), "NotBuyer", "the broker, to collect its share");
    await w.next(t.expiry);
    await refused(w, funded, settle(w, t), "DealExpired", "a settlement at the expiry");
    await w.v3.as(w.seller).refund(id);
    assert.deepEqual(await w.moved(start), {}, "after a funding, three rejected settlements and a refund, every wallet holds what it started with");
    assert.deepEqual([start["broker.USDC"], start["treasury.USDC"]], [0n, 0n]);
  }
});

test("R3-03: the contract keeps nothing of a payment: a token that one deal sells and another deal pays with stays whole for the deal it is held for", async () => {
  const w = await world();
  // Two deals, each the other way round: FAM for USDC, and USDC for FAM.
  const first = await w.terms3(), paid = await w.terms3({ baseToken: w.usdc.address, quoteToken: w.fam.address, allocation: 5_000_000n, quote: 777n * 10n ** 18n + 199n });
  await w.fund3(first);
  await w.fund3(paid);
  await w.ready3(paid);
  const before = await w.holdings();
  await settle(w, paid);
  assert.deepEqual(await w.moved(before), settlement(w, paid), "the payment in FAM passes through the contract to the unit");
  assert.equal((await w.holdings())["brokerDeals.FAM"], ALLOCATION, "the first deal's allocation is all there");

  await w.ready3(first);
  const then = await w.holdings();
  await settle(w, first);
  assert.deepEqual(await w.moved(then), settlement(w, first));
  const end = await w.holdings();
  assert.deepEqual([end["brokerDeals.FAM"], end["brokerDeals.USDC"]], [0n, 0n], "after both settlements the contract holds nothing: no dust of any fee stays in it");
});

test("R3-03: the treasury and the 0.5% fee are fixed at deployment, the treasury is never the zero address or the contract itself, and nothing but fund, settle, refund and claim changes anything", async () => {
  const w = await world();
  const { BrokerDeals, GrantVault } = artifacts();
  assert.equal(await revertsWith(deploy(w.chain, w.deployer, BrokerDeals, [ZERO])), "BadTreasury");
  // The address the next contract of the deployer will have, given to that contract as its treasury (a call, not a transaction: it keeps the nonce).
  const itself = getCreateAddress({ from: w.deployer, nonce: Number(await w.chain.rpc("eth_getTransactionCount", [w.deployer, "latest"])) });
  const creation = BrokerDeals.bytecode + new Interface(BrokerDeals.abi).encodeDeploy([itself]).slice(2);
  assert.equal(await revertsWith(w.chain.rpc("eth_call", [{ from: w.deployer, data: creation }, "latest"])), "BadTreasury");
  assert.equal((await w.v3.read.treasury()).toLowerCase(), w.treasury);
  assert.equal(await w.v3.read.FEE_BPS(), 50n);
  const changing = (abi) => abi.filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).map((f) => f.name).sort();
  assert.deepEqual(changing(BrokerDeals.abi), ["claim", "fund", "refund", "settle"]);
  assert.deepEqual(changing(GrantVault.abi), ["pay"]);
  for (const { abi } of [BrokerDeals, GrantVault]) {
    assert.ok(!abi.some((f) => f.type === "fallback" || f.type === "receive" || f.stateMutability === "payable"), "nothing is payable, and there is no fallback");
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// R3-04: a failed settlement and a refund transfer no fees
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Ways a token fails a settlement: what it does, the side of the deal it is on, its kind once it misbehaves (an
 * EdgeToken's kind, or "Blocked": round 2's FixtureToken refuses every transfer out of the deal contract), the error
 * of `settle`, and what a refund does meanwhile: it returns the allocation whole, or short of the token's own fee,
 * or it waits with that error until the token behaves again.
 */
const FAILURES = [
  ["answers false", "payment", "False", "TransferFailed", "whole"],
  ["takes a fee from the amount", "payment", "Fee", "InexactTransfer", "whole"],
  ["takes a fee on top of the amount", "payment", "FeeOnTop", "InexactTransfer", "whole"],
  ["takes a fee on transfer only", "payment", "TransferFee", "InexactTransfer", "whole"],
  ["blocks the sender", "payment", "Blocked", "TransferFailed", "whole"],
  ["answers false", "base", "False", "TransferFailed", "TransferFailed"],
  ["takes a fee from the amount", "base", "Fee", "InexactTransfer", "short"],
  ["takes a fee on top of the amount", "base", "FeeOnTop", "InexactTransfer", "InexactTransfer"],
  ["takes a fee on transfer only", "base", "TransferFee", "InexactTransfer", "short"],
  ["blocks the sender", "base", "Blocked", "TransferFailed", "TransferFailed"],
];
/** Makes `token` misbehave as `kind` says, as the owner of an upgradeable token can, or behave again. */
const misbehave = (w, token, kind) => (kind === "Blocked" ? token.as(w.deployer).setBlockedSender(w.v3.address) : token.as(w.deployer).setKind(KIND[kind]));
const behave = (w, token, kind) => (kind === "Blocked" ? token.as(w.deployer).setBlockedSender(ZERO) : token.as(w.deployer).setKind(KIND.Plain));

for (const [what, side, kind, error, refund] of FAILURES) {
  test(`R3-04: a settlement whose ${side} token ${what} reverts whole: no payment, no fee, no broker payout, no grant; the deal is still funded, its seller can refund it, and it settles later`, async () => {
    for (const terms of ["terms3", "vesting3"]) {
      const w = await world(), vesting = terms === "vesting3";
      const base = await w.token("BASE", 18, side === "base" && kind === "Blocked" ? "FixtureToken" : "Plain");
      const pay = await w.token("PAY", 6, side === "payment" && kind === "Blocked" ? "FixtureToken" : "Plain");
      // Two deals in the same tokens: one will be refunded, the other settled once the token behaves. Each is the bystander of the other.
      const back = await w[terms]({ baseToken: base.address, quoteToken: pay.address }), later = await w[terms]({ baseToken: base.address, quoteToken: pay.address });
      const backId = await w.fund3(back), laterId = await w.fund3(later);
      await w.ready3(back); // one deal's payment, approved: both cost the same, and no attempt below spends it
      await pay.as(w.deployer).mint(w.buyer, back.quote); // and more in hand, so that a fee on top can be charged
      const token = side === "base" ? base : pay;
      await misbehave(w, token, kind);

      const before = await w.holdings(), made = await w.chain.rpc("eth_getTransactionCount", [w.v3.address, "latest"]);
      for (const t of [back, later]) await refused(w, before, settle(w, t), error, `${terms}, the ${side} token ${what}`);
      for (const t of [back, later]) assert.deepEqual(await dealOf(w, w.idOf(t)), { status: Funded, grantId: 0n, terms: plain(t) }, "the deal is still funded");
      assert.equal((await grantOf(w, 1)).custodian, ZERO, "no grant is left behind");
      assert.equal(await w.chain.rpc("eth_getTransactionCount", [w.v3.address, "latest"]), made, "no vault was deployed");

      const whole = { "brokerDeals.BASE": -ALLOCATION, "seller.BASE": ALLOCATION };
      if (refund === "whole" || refund === "short") {
        assert.deepEqual(listed(await w.v3.as(w.seller).refund(backId)), [["BrokerDealRefunded", backId]]);
        assert.deepEqual(await w.moved(before), refund === "whole" ? whole : { ...whole, "seller.BASE": ALLOCATION - ALLOCATION / 100n },
          "the contract gives up exactly the allocation, the other deal's tokens stay, and nobody is paid a fee");
        await behave(w, token, kind);
      } else {
        await refused(w, before, w.v3.as(w.seller).refund(backId), refund, "the refund waits for the token too");
        assert.equal((await dealOf(w, backId)).status, Funded);
        await behave(w, token, kind);
        await w.v3.as(w.seller).refund(backId);
        assert.deepEqual(await w.moved(before), whole);
      }
      assert.equal((await dealOf(w, backId)).status, Refunded);

      const mended = await w.holdings();
      assert.deepEqual(listed(await settle(w, later)), [settledEvent(w, later, vesting ? 1n : 0n)], "the first grant id is still free");
      const { custodian } = await grantOf(w, 1);
      if (vesting) w.watch("vault", custodian);
      assert.deepEqual(await w.moved(mended), settlement(w, later, vesting ? custodian : later.buyer), "the deal that failed settles once the token behaves");
      assert.equal((await dealOf(w, laterId)).status, Settled);
    }
  });
}

test("R3-04: a base token that answers false or takes a fee is refused when the deal is funded: nothing moves, there is no deal, and the nonce is not spent", async () => {
  for (const [kind, error] of [["False", "TransferFailed"], ["Fee", "InexactTransfer"], ["FeeOnTop", "InexactTransfer"]]) {
    const w = await world();
    const base = await w.token("BASE", 18, kind);
    const t = await w.terms3({ baseToken: base.address }), id = w.idOf(t);
    await w.stock(t);
    await base.as(w.deployer).mint(w.seller, ALLOCATION); // more in hand, so that a fee on top can be charged
    const before = await w.holdings();
    await refused(w, before, fund(w, t), error, `a base token of kind ${kind}`);
    assert.equal((await dealOf(w, id)).status, Unfunded);
    assert.equal(await w.v3.read.nonceUsed(w.seller, t.nonce), false);
    await base.as(w.deployer).setKind(KIND.Plain);
    await fund(w, t);
    assert.deepEqual(await w.moved(before), { "seller.BASE": -ALLOCATION, "brokerDeals.BASE": ALLOCATION }, "the same terms and signature fund the deal once the token behaves");
  }

  // The seller's own shortfall fails the funding whole too.
  const w = await world();
  const t = await w.terms3();
  await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
  await w.fam.as(w.seller).approve(w.v3.address, ALLOCATION - 1n);
  const before = await w.holdings();
  await refused(w, before, fund(w, t), "TransferFailed", "an approval one unit short of the allocation");
  assert.equal(await w.v3.read.nonceUsed(w.seller, t.nonce), false);
});

test("R3-04: the broker and the treasury are paid by a settlement and by nothing else: not by a funding, a refused settlement, an expiry, a refund or a vesting claim", async () => {
  const w = await world();
  const paid = async () => Object.fromEntries(Object.entries(await w.holdings()).filter(([key]) => /^(broker|treasury)\./.test(key)));
  const NOTHING = { "broker.FAM": 0n, "broker.USDC": 0n, "treasury.FAM": 0n, "treasury.USDC": 0n };
  const expiring = await w.terms3({ expiry: (await w.chain.now()) + 1000 }), withdrawn = await w.terms3(), vested = await w.vesting3({ cliffSeconds: 0 });
  for (const t of [expiring, withdrawn, vested]) await w.fund3(t);
  assert.deepEqual(await paid(), NOTHING, "after three fundings");
  await w.ready3(expiring);
  assert.equal(await revertsWith(w.v3.as(w.broker).settle(w.idOf(expiring), await w.sign("buyer", expiring))), "NotBuyer");
  assert.equal(await revertsWith(w.v3.as(w.buyer).settle(w.idOf(expiring), await w.sign("broker", expiring))), "BadSignature");
  assert.deepEqual(await paid(), NOTHING, "after two refused settlements");
  await w.v3.as(w.seller).refund(w.idOf(withdrawn));
  assert.deepEqual(await paid(), NOTHING, "after a refund");
  await w.next(expiring.expiry);
  assert.equal(await revertsWith(settle(w, expiring)), "DealExpired");
  await w.v3.as(w.seller).refund(w.idOf(expiring));
  assert.deepEqual(await paid(), NOTHING, "after an expiry and the refund of the expired deal");

  const [settled] = await w.settle3(vested);
  const { brokerFee, treasuryFee } = feesOf(vested.quote, vested.brokerBps), ONCE = { ...NOTHING, "broker.USDC": brokerFee, "treasury.USDC": treasuryFee };
  assert.deepEqual([brokerFee, treasuryFee], [246_913n, 987_653n]);
  assert.deepEqual(await paid(), ONCE, "after the one settlement");
  const { start, end } = await grantOf(w, settled.args.grantId);
  for (const time of [start + 1n, start + BigInt(45 * DAY), end]) {
    await w.next(time);
    await w.v3.as(w.buyer).claim(settled.args.grantId);
    assert.deepEqual(await paid(), ONCE, "after a claim");
  }
  assert.equal(await w.fam.read.balanceOf(w.buyer), ALLOCATION);
});

test("R3-04: refund is the seller's alone, at any time while the deal is funded, its expiry passed or not, never after a settlement and never twice; it returns exactly the allocation", async () => {
  const w = await world();
  const early = await w.terms3(), late = await w.terms3({ allocation: 7n }), done = await w.terms3({ allocation: 11n }), kept = await w.terms3({ allocation: 13n });
  for (const t of [early, late, done, kept]) await w.fund3(t);
  await w.settle3(done);
  await w.ready3(early); // a buyer who is ready, whose payment must not move
  const [earlyId, lateId, doneId] = [early, late, done].map((t) => w.idOf(t));
  const before = await w.holdings();
  for (const who of ["buyer", "broker", "other", "treasury", "deployer"]) await refused(w, before, w.v3.as(w[who]).refund(earlyId), "NotSeller", `refund sent by the ${who}`);
  await refused(w, before, w.v3.as(w.seller).refund(doneId), "NotFunded", "the refund of a settled deal");
  await refused(w, before, w.v3.as(w.seller).refund(w.idOf(await w.terms3())), "NotFunded", "the refund of terms nobody funded");

  assert.deepEqual(listed(await w.v3.as(w.seller).refund(earlyId)), [["BrokerDealRefunded", earlyId]]);
  assert.deepEqual(await w.moved(before), { "seller.FAM": ALLOCATION, "brokerDeals.FAM": -ALLOCATION }, "exactly the allocation, to the seller, and no fee to anyone");
  assert.deepEqual(await dealOf(w, earlyId), { status: Refunded, grantId: 0n, terms: plain(early) });
  const refunded = await w.holdings();
  await refused(w, refunded, w.v3.as(w.seller).refund(earlyId), "NotFunded", "a second refund");
  await refused(w, refunded, settle(w, early), "NotFunded", "the settlement of a refunded deal, by a buyer who is ready");

  await w.at(late.expiry + DAY);
  await refused(w, refunded, settle(w, late), "DealExpired", "the settlement of an expired deal");
  await refused(w, refunded, w.v3.as(w.buyer).refund(lateId), "NotSeller", "the buyer, after the expiry");
  await w.v3.as(w.seller).refund(lateId);
  assert.deepEqual(await w.moved(refunded), { "seller.FAM": 7n, "brokerDeals.FAM": -7n }, "an expired deal is refunded as any funded deal is");
  assert.equal((await w.holdings())["brokerDeals.FAM"], 13n, "the deal nobody touched still has its whole allocation in the contract");
});

test("R3-04: a base token that keeps a fee on transfer does not lock the seller's tokens: the refund gives up exactly the allocation, and no other deal's tokens", async () => {
  const w = await world();
  const short = await w.token("SHORT", 18, "TransferFee"); // comes in whole by transferFrom, leaves 1% short by transfer
  const t = await w.terms3({ baseToken: short.address }), kept = await w.terms3({ baseToken: short.address, allocation: 1_000n });
  const id = await w.fund3(t);
  await w.fund3(kept);
  const before = await w.holdings();
  assert.deepEqual(listed(await w.v3.as(w.seller).refund(id)), [["BrokerDealRefunded", id]]);
  assert.deepEqual(await w.moved(before), { "brokerDeals.SHORT": -ALLOCATION, "seller.SHORT": ALLOCATION - ALLOCATION / 100n },
    "the refund is not refused for what the token keeps: the contract gives up the allocation and not a unit more");
  assert.equal((await w.holdings())["brokerDeals.SHORT"], 1_000n, "the other deal's tokens are all still held for it");
  assert.equal((await dealOf(w, id)).status, Refunded);
});

/**
 * The checks' ReentrantToken at an address that has a key. A contract cannot sign, so a hostile token could never be
 * the seller or the buyer of a broker deal: whatever it called back would fail for that alone, lock or no lock. An
 * account can have both a key and code (EIP-7702), so the token's code is put at a wallet's address here. What EVIL
 * calls back is then a call its own signature allows, and the lock is all that is left to refuse it.
 */
async function hostileToken(w) {
  const wallet = new Wallet(`0x${"e7".repeat(32)}`), address = wallet.address.toLowerCase();
  const deployed = await w.token("EVIL", 6, "ReentrantToken");
  await w.chain.rpc("hardhat_setCode", [address, await w.chain.rpc("eth_getCode", [deployed.address, "latest"])]);
  await w.chain.fund(address);
  w.tokens.EVIL = Object.assign(contractAt(w.chain, artifacts().ReentrantToken.abi, address, { label: "EVIL" }), { symbol: "EVIL", decimals: 6 });
  w.watch("evil", address);
  return Object.assign(w.tokens.EVIL, { sign: (terms) => wallet.signTypedData(w.domain, TYPES, terms) });
}

/** Each of the four calls with EVIL as the token it moves: what is set up, the call itself, and what it alone moves. */
const RUNNING = {
  async fund(w, evil) {
    const t = await w.terms3({ baseToken: evil });
    await w.stock(t);
    return { call: () => fund(w, t), moves: { "seller.EVIL": -ALLOCATION, "brokerDeals.EVIL": ALLOCATION } };
  },
  async settle(w, evil) {
    const t = await w.terms3({ quoteToken: evil });
    await w.fund3(t);
    await w.ready3(t);
    return { call: () => settle(w, t), moves: settlement(w, t) };
  },
  async refund(w, evil) {
    const id = await w.fund3(await w.terms3({ baseToken: evil }));
    return { call: () => w.v3.as(w.seller).refund(id), moves: { "brokerDeals.EVIL": -ALLOCATION, "seller.EVIL": ALLOCATION } };
  },
  async claim(w, evil) {
    const t = await w.vesting3({ baseToken: evil, cliffSeconds: 0, durationSeconds: 3600 });
    await w.fund3(t);
    const [{ args: { grantId } }] = await w.settle3(t);
    w.watch("vault", (await grantOf(w, grantId)).custodian);
    return { call: () => w.v3.as(w.buyer).claim(grantId), moves: { "vault.EVIL": -ALLOCATION, "buyer.EVIL": ALLOCATION } };
  },
};

test("R3-04: while a token moves, its call back into fund, settle, refund or claim is refused, whichever of the four is running, and only the running call's tokens move", async () => {
  for (const running of Object.keys(RUNNING)) {
    for (const callback of Object.keys(RUNNING)) {
      const w = await world(), what = `a call back into ${callback} during ${running}`;
      const evil = await hostileToken(w), E = evil.address;
      // Four calls EVIL is entitled to as a party of deals of its own, in plain tokens: a refund, a claim, a settlement and a funding.
      const toRefund = await w.terms3({ seller: E, allocation: 5n }), toClaim = await w.vesting3({ buyer: E, allocation: 7n, cliffSeconds: 0, durationSeconds: 3600 });
      const toSettle = await w.terms3({ buyer: E, allocation: 9n }), toFund = await w.terms3({ seller: E, allocation: 3n });
      await w.stock(toRefund);
      await w.v3.as(E).fund(toRefund, await evil.sign(toRefund));
      await w.fund3(toClaim);
      await w.ready3(toClaim);
      await w.v3.as(E).settle(w.idOf(toClaim), await evil.sign(toClaim)); // grant 1
      await w.fund3(toSettle);
      await w.ready3(toSettle);
      await w.stock(toFund);
      const { custodian } = await grantOf(w, 1);
      w.watch("evilVault", custodian);
      const calls = { fund: [toFund, await evil.sign(toFund)], settle: [w.idOf(toSettle), await evil.sign(toSettle)], refund: [w.idOf(toRefund)], claim: [1n] };
      const data = w.v3.interface.encodeFunctionData(callback, calls[callback]);
      /** What each of the four would move, were it to go through. */
      const own = { fund: funding(w, toFund), settle: settlement(w, toSettle), refund: refunding(w, toRefund), claim: { "evilVault.FAM": -7n, "evil.FAM": 7n } };

      const { call, moves } = await RUNNING[running](w, E);
      await w.at((await w.chain.now()) + 3600); // both grants have vested whole
      await evil.as(w.other).arm(w.v3.address, data);
      const before = await w.holdings();
      await call();
      assert.equal(await evil.read.armed(), false, `${what}: EVIL did call back from inside its transfer`);
      assert.equal(await evil.read.calledBack(), false, `${what} went through`);
      assert.deepEqual(await w.moved(before), moves, `${what}: only the running call's tokens moved`);
      assert.deepEqual([(await dealOf(w, w.idOf(toRefund))).status, (await dealOf(w, w.idOf(toSettle))).status, (await dealOf(w, w.idOf(toFund))).status, (await grantOf(w, 1)).claimed],
        [Funded, Funded, Unfunded, 0n], `${what}: EVIL's own deals and grant are as they were`);

      // The same call as a transaction of EVIL's own goes through: its signature and its tokens were in order, and the lock alone refused it.
      const after = await w.holdings();
      await w.chain.send(E, { to: w.v3.address, data }, `${callback}, sent by EVIL itself,`);
      assert.deepEqual(await w.moved(after), own[callback], `${callback}, sent by EVIL itself, moves what it says`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// R3-05: vesting receipts match the backed grant, and the beneficiary claims
// ---------------------------------------------------------------------------------------------------------------------

test("R3-05: a vesting settlement funds a new vault with the whole allocation; grants are numbered 1, 2, ... and each has a vault of its own that only the deal contract can make pay", async () => {
  const w = await world();
  const first = await w.vesting3(), atOnce = await w.terms3({ allocation: 5n }), second = await w.vesting3({ allocation: 7n, cliffSeconds: 0, durationSeconds: 1000 });
  for (const t of [first, atOnce, second]) await w.fund3(t);
  await w.ready3(first);
  const before = await w.holdings(), at = (await w.chain.now()) + 100;
  await w.next(at);
  assert.deepEqual(listed(await settle(w, first)), [settledEvent(w, first, 1n)]);
  const grant = await grantOf(w, 1);
  w.watch("vault", grant.custodian);
  assert.deepEqual(grant, { token: w.fam.address.toLowerCase(), beneficiary: w.buyer, custodian: grant.custodian, allocation: ALLOCATION,
    start: BigInt(at), cliff: BigInt(at + 30 * DAY), end: BigInt(at + 90 * DAY), claimed: 0n });
  assert.deepEqual(await w.moved(before), settlement(w, first, grant.custodian));
  const held = await w.holdings();
  assert.deepEqual([held["vault.FAM"], held["brokerDeals.FAM"]], [ALLOCATION, 5n + 7n], "the vault holds the whole grant, and the deal contract none of it: only the two other deals' allocations");
  const vault = await w.vault3(1);
  assert.deepEqual([await vault.read.deals(), await vault.read.token(), await vault.read.beneficiary()].map(lower), [w.v3.address, w.fam.address, w.buyer].map(lower),
    "the vault names its deal contract, its token and its beneficiary");

  assert.deepEqual(listed(await w.settle3(atOnce)), [settledEvent(w, atOnce, 0n)], "an immediate deal takes no grant id");
  assert.deepEqual(listed(await w.settle3(second)), [settledEvent(w, second, 2n)], "the next grant is 2");
  const other = await grantOf(w, 2);
  w.watch("vault2", other.custodian);
  assert.notEqual(other.custodian, grant.custodian);
  assert.deepEqual([(await dealOf(w, w.idOf(first))).grantId, (await dealOf(w, w.idOf(atOnce))).grantId, (await dealOf(w, w.idOf(second))).grantId], [1n, 0n, 2n]);
  const end = await w.holdings();
  assert.deepEqual([end["vault.FAM"], end["vault2.FAM"], end["brokerDeals.FAM"]], [ALLOCATION, 7n, 0n]);
  for (const none of [0, 3]) assert.deepEqual(await grantOf(w, none), { token: ZERO, beneficiary: ZERO, custodian: ZERO, allocation: 0n, start: 0n, cliff: 0n, end: 0n, claimed: 0n }, `grant ${none}, which nobody has`);

  await w.at(grant.end);
  for (const who of ["buyer", "seller", "broker", "other", "treasury"]) await refused(w, end, vault.as(w[who]).pay(1n), "NotDeals", `the ${who} asks the vault to pay`);
});

test("R3-05: the schedule follows block time and rounds down: nothing before the cliff, the accrued share at the cliff, half in the middle, everything from the end on; a fixed future start is kept", async () => {
  for (const fixed of [false, true]) {
    const w = await world();
    const now = await w.chain.now();
    const t = await w.vesting3({ allocation: ODD, fixedStart: fixed ? now + 3 * DAY : 0, expiry: now + 2 * DAY });
    await w.fund3(t);
    await w.ready3(t);
    await w.next(now + DAY);
    const [{ args: { grantId } }] = await settle(w, t);
    const { start, cliff, end } = await grantOf(w, grantId), day = BigInt(DAY), span = end - start;
    assert.equal(start, BigInt(fixed ? now + 3 * DAY : now + DAY), fixed ? "a fixed start is kept" : "the grant starts at its settlement");
    assert.deepEqual([cliff - start, span], [30n * day, 90n * day]);
    for (const [time, expected, what] of [
      ...(fixed ? [[start - 1n, 0n, "a second before the fixed start"], [start, 0n, "the fixed start"]] : []),
      [start + 1n, 0n, "a second after the start"],
      [cliff - 1n, 0n, "a second before the cliff"],
      [cliff, 300_000_000_000_000_000_000n, "the cliff: a third, rounded down, accrued over 30 of 90 days"],
      [cliff + 1n, (ODD * (30n * day + 1n)) / span, "a second after the cliff"],
      [start + 45n * day, 450_000_000_000_000_000_000n, "day 45: a half, rounded down"],
      [end - 1n, (ODD * (span - 1n)) / span, "a second before the end"],
      [end, ODD, "the end"],
      [end + 365n * day, ODD, "a year after the end"],
    ]) {
      await w.at(time);
      assert.equal(await w.v3.read.vested(grantId), expected, what);
      assert.equal(await w.v3.read.claimable(grantId), expected, `${what}, claimable`);
    }
  }
});

test("R3-05: a grant never starts before it is funded: a deal settles up to the very second of its fixed start, and once that has passed it can only be refunded", async () => {
  const w = await world();
  const now = await w.chain.now(), start = now + 1000;
  const onTime = await w.vesting3({ fixedStart: start, expiry: now + 2000 }), late = await w.vesting3({ fixedStart: start, expiry: now + 2000, allocation: 7n });
  const free = await w.vesting3({ expiry: now + 2000, allocation: 9n });
  for (const t of [onTime, late, free]) await w.fund3(t);
  for (const t of [onTime, late, free]) await w.ready3(t);
  await w.usdc.as(w.buyer).approve(w.v3.address, 3n * (QUOTE + feeOn(QUOTE)));

  await w.next(start);
  assert.deepEqual(listed(await settle(w, onTime)), [settledEvent(w, onTime, 1n)], "in the very second of the fixed start");
  assert.equal((await grantOf(w, 1)).start, BigInt(start));
  const before = await w.holdings();
  await w.next(start + 1);
  await refused(w, before, settle(w, late), "StartPassed", "a second after the fixed start");
  assert.deepEqual(await dealOf(w, w.idOf(late)), { status: Funded, grantId: 0n, terms: plain(late) });
  assert.equal((await grantOf(w, 2)).custodian, ZERO, "no grant is left behind");
  for (const who of ["buyer", "broker", "other"]) await refused(w, before, w.v3.as(w[who]).refund(w.idOf(late)), "NotSeller", `the ${who} cannot take the allocation`);

  assert.deepEqual(listed(await settle(w, free)), [settledEvent(w, free, 2n)], "a deal without a fixed start still settles, as grant 2: the refused settlement took no id");
  const then = await w.holdings();
  assert.deepEqual(listed(await w.v3.as(w.seller).refund(w.idOf(late))), [["BrokerDealRefunded", w.idOf(late)]]);
  assert.deepEqual(await w.moved(then), { "seller.FAM": 7n, "brokerDeals.FAM": -7n });
});

test("R3-05: fund refuses a schedule that could not vest as written, and a delivery it does not know, although the seller signed them", async () => {
  const w = await world();
  const now = await w.chain.now();
  await plenty(w);
  const immediate = await w.terms3(), vesting = await w.vesting3(), duration = BigInt(vesting.durationSeconds);
  const before = await w.holdings();
  for (const [terms, error] of [
    [{ ...immediate, delivery: 2 }, "BadDelivery"],
    [{ ...vesting, delivery: 2 }, "BadDelivery"],
    [{ ...vesting, delivery: 255 }, "BadDelivery"],
    [{ ...immediate, fixedStart: now + DAY }, "ScheduleOnImmediate"],
    [{ ...immediate, cliffSeconds: 1 }, "ScheduleOnImmediate"],
    [{ ...immediate, durationSeconds: 90 * DAY }, "ScheduleOnImmediate"],
    [{ ...vesting, cliffSeconds: 0, durationSeconds: 0 }, "BadSchedule"],
    [{ ...vesting, cliffSeconds: vesting.durationSeconds }, "BadSchedule"],
    [{ ...vesting, cliffSeconds: vesting.durationSeconds + 1 }, "BadSchedule"],
    [{ ...vesting, fixedStart: 1 }, "StartNotInFuture"],
    [{ ...vesting, fixedStart: now - 1 }, "StartNotInFuture"],
    [{ ...vesting, fixedStart: now }, "StartNotInFuture"],
    [{ ...vesting, fixedStart: MAX_UINT64 - duration + 1n }, "ScheduleTooLong"],
    [{ ...vesting, expiry: MAX_UINT64 - duration + 1n }, "ScheduleTooLong"],
  ]) {
    await refused(w, before, fund(w, terms), error, say(terms));
    assert.equal((await dealOf(w, w.idOf(terms))).status, Unfunded, say(terms));
  }
  // A fixed start is in the future of the funding block itself: that block's own second is too late, the next one is not.
  const at = now + 100, sameSecond = await w.vesting3({ fixedStart: at }), nextSecond = await w.vesting3({ fixedStart: at + 1 });
  await w.next(at);
  await refused(w, before, fund(w, sameSecond), "StartNotInFuture", "a fixed start in the funding block's own second");
  await w.next(at);
  await fund(w, nextSecond);
  assert.equal(await w.chain.now(), at);

  const accepted = [immediate, vesting, nextSecond, await w.vesting3({ cliffSeconds: 0 }), await w.vesting3({ cliffSeconds: 0, durationSeconds: 1 }), await w.vesting3({ cliffSeconds: 90 * DAY - 1 }),
    await w.vesting3({ fixedStart: MAX_UINT64 - duration }), await w.vesting3({ expiry: MAX_UINT64 - duration })];
  for (const terms of accepted) {
    if (terms !== nextSecond) await fund(w, terms);
    assert.deepEqual(await dealOf(w, w.idOf(terms)), { status: Funded, grantId: 0n, terms: plain(terms) }, say(terms));
  }
  assert.deepEqual(await w.moved(before), { "seller.FAM": -8n * ALLOCATION, "brokerDeals.FAM": 8n * ALLOCATION });
});

test("R3-05: only the beneficiary claims, only what has vested, each grant from its own vault, and a claim pays no fee and no broker", async () => {
  const w = await world();
  const mine = await w.vesting3(), theirs = await w.vesting3({ buyer: w.other, allocation: 600n });
  for (const t of [mine, theirs]) {
    await w.fund3(t);
    await w.ready3(t);
  }
  const at = (await w.chain.now()) + 100;
  for (const t of [mine, theirs]) {
    await w.next(at);
    await settle(w, t);
  }
  const [first, second] = [await grantOf(w, 1), await grantOf(w, 2)];
  w.watch("vault1", first.custodian);
  w.watch("vault2", second.custodian);
  assert.deepEqual([first.beneficiary, second.beneficiary, first.end, second.end], [w.buyer, w.other, BigInt(at + 90 * DAY), BigInt(at + 90 * DAY)]);
  const before = await w.holdings();
  assert.deepEqual([before["vault1.FAM"], before["vault2.FAM"], before["brokerDeals.FAM"]], [ALLOCATION, 600n, 0n], "each vault holds its whole grant, and the deal contract none of either");

  await refused(w, before, w.v3.as(w.buyer).claim(1), "NothingToClaim", "the beneficiary, before the cliff");
  await w.at(first.cliff);
  for (const who of ["seller", "broker", "other", "treasury", "deployer"]) await refused(w, before, w.v3.as(w[who]).claim(1), "NotBeneficiary", `the ${who} claims the buyer's grant`);
  await refused(w, before, w.v3.as(w.buyer).claim(2), "NotBeneficiary", "the buyer claims another beneficiary's grant");
  for (const none of [0, 3, 99]) await refused(w, before, w.v3.as(w.buyer).claim(none), "NotBeneficiary", `grant ${none}, which nobody has`);

  await w.next(at + 45 * DAY);
  assert.deepEqual(listed(await w.v3.as(w.buyer).claim(1)), [["GrantClaimed", 1n, w.buyer, ALLOCATION / 2n]]);
  assert.deepEqual(await w.moved(before), { "vault1.FAM": -(ALLOCATION / 2n), "buyer.FAM": ALLOCATION / 2n }, "half, from the grant's own vault to its beneficiary: no fee, no broker payout, nothing in USDC");
  const half = await w.holdings();
  await w.next(at + 45 * DAY);
  await refused(w, half, w.v3.as(w.buyer).claim(1), "NothingToClaim", "a second claim in the same second");
  assert.deepEqual([(await grantOf(w, 1)).claimed, await w.v3.read.claimable(1), (await grantOf(w, 2)).claimed], [ALLOCATION / 2n, 0n, 0n]);

  await w.next(first.end);
  assert.deepEqual(listed(await w.v3.as(w.other).claim(2)), [["GrantClaimed", 2n, w.other, 600n]]);
  await w.v3.as(w.buyer).claim(1);
  assert.deepEqual(await w.moved(before), { "vault1.FAM": -ALLOCATION, "buyer.FAM": ALLOCATION, "vault2.FAM": -600n, "other.FAM": 600n });
  const end = await w.holdings();
  for (const [who, id] of [["buyer", 1], ["other", 2]]) await refused(w, end, w.v3.as(w[who]).claim(id), "NothingToClaim", `grant ${id}, claimed whole`);
  assert.deepEqual([(await grantOf(w, 1)).claimed, (await grantOf(w, 2)).claimed], [ALLOCATION, 600n]);
});

test("R3-05: the claims of a grant add up to exactly its allocation, whatever rounding kept back on the way, from 1 unit to 2^255", async () => {
  for (const allocation of [1n, 3n, ODD, 2n ** 255n]) {
    const w = await world();
    const t = await w.vesting3({ allocation, cliffSeconds: 7 * DAY, durationSeconds: 100 * DAY - 1 });
    await w.fund3(t);
    const [{ args: { grantId } }] = await w.settle3(t);
    const { start, cliff, end, custodian } = await grantOf(w, grantId), day = BigInt(DAY);
    w.watch("vault", custodian);
    const before = await w.holdings();
    const vestedAt = (time) => (time < cliff ? 0n : time >= end ? allocation : (allocation * (time - start)) / (end - start));
    let paid = 0n;
    for (const time of [cliff - 1n, cliff, cliff + 1n, start + 33n * day, start + 33n * day, start + 50n * day - 1n, end - 1n, end, end + day]) {
      await w.next(time);
      const due = vestedAt(time) - paid, claiming = w.v3.as(w.buyer).claim(grantId);
      if (due === 0n) {
        assert.equal(await revertsWith(claiming), "NothingToClaim", `allocation ${allocation}, second ${time - start}`);
        continue;
      }
      assert.deepEqual(listed(await claiming), [["GrantClaimed", grantId, w.buyer, due]], `allocation ${allocation}, second ${time - start}`);
      paid += due;
      assert.deepEqual(await w.moved(before), nonZero({ "vault.FAM": -paid, "buyer.FAM": paid }), "the vault holds exactly what is not claimed yet, and the buyer the rest");
    }
    assert.deepEqual([paid, (await grantOf(w, grantId)).claimed], [allocation, allocation]);
    assert.deepEqual(await w.moved(before), { "vault.FAM": -allocation, "buyer.FAM": allocation });
  }
});

test("R3-05: a token that starts keeping a fee once a grant holds it cannot lock the grant, and no grant or deal ever pays for another", async () => {
  const w = await world();
  const t = await w.vesting3(), funded = await w.terms3({ allocation: 500n }), kept = await w.terms3({ allocation: 1_000n });
  for (const terms of [t, funded, kept]) await w.fund3(terms);
  await w.settle3(t);
  const { custodian, cliff, end } = await grantOf(w, 1);
  w.watch("vault", custodian);

  await w.fam.as(w.deployer).setKind(KIND.FeeOnTop); // paying out now costs the holder 1% more than the amount
  await w.at(cliff);
  const before = await w.holdings();
  await refused(w, before, w.v3.as(w.buyer).claim(1), "InexactTransfer", "a claim that would cost the vault more than it pays");
  await refused(w, before, w.v3.as(w.seller).refund(w.idOf(funded)), "InexactTransfer", "a refund that would cost the contract another deal's tokens");

  await w.fam.as(w.deployer).setKind(KIND.Fee); // a fee its recipient pays
  await w.next(end);
  await w.v3.as(w.buyer).claim(1);
  await w.v3.as(w.seller).refund(w.idOf(funded));
  assert.deepEqual(await w.moved(before), { "vault.FAM": -ALLOCATION, "buyer.FAM": ALLOCATION - ALLOCATION / 100n, "brokerDeals.FAM": -500n, "seller.FAM": 495n });
  assert.equal((await grantOf(w, 1)).claimed, ALLOCATION, "claimed counts what left the vault");
  assert.equal((await w.holdings())["brokerDeals.FAM"], 1_000n, "the third deal's tokens are all still there");
});

test("R3-05: tokens sent ahead to the address a vault is about to have neither block the settlement nor change the grant", async () => {
  const w = await world();
  const t = await w.vesting3({ cliffSeconds: 0 });
  await w.fund3(t);
  await w.ready3(t);
  const next = getCreateAddress({ from: w.v3.address, nonce: Number(await w.chain.rpc("eth_getTransactionCount", [w.v3.address, "latest"])) }).toLowerCase();
  w.watch("vault", next);
  await w.fam.as(w.deployer).mint(next, 5n);
  const before = await w.holdings();
  assert.deepEqual(listed(await settle(w, t)), [settledEvent(w, t, 1n)]);
  const grant = await grantOf(w, 1);
  assert.deepEqual([grant.custodian, grant.allocation], [next, ALLOCATION]);
  assert.deepEqual(await w.moved(before), settlement(w, t, next));
  await w.next(grant.end);
  await w.v3.as(w.buyer).claim(1);
  const end = await w.holdings();
  assert.deepEqual([end["buyer.FAM"], end["vault.FAM"]], [ALLOCATION, 5n], "the grant pays its allocation and no more; what was sent ahead stays in the vault");
});
