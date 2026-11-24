import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN_ID, deploy, Reverted } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { brokerWorld, demoPeople, signers } from "../scripts/lib/broker-world.mjs";
import { abi, dealIdOf, domainOf, pack, unpack } from "../web/v3.js";

const { Seller, Buyer, Broker, Stranger } = demoPeople;
const termsType = {
  BrokerTerms: abi.getFunction("fund").inputs[0].components.map(({ name, type }) => ({ name, type })),
};
const sign = (name, domain, terms) => signers[name].signTypedData(domain, termsType, terms);
async function fixture(changes = {}) {
  const w = await brokerWorld();
  const c = w.brokerDeals;
  const now = BigInt(await w.chain.now());
  const terms = {
    seller: Seller, buyer: Buyer, broker: Broker,
    baseToken: w.fam.address, quoteToken: w.usdc.address,
    allocation: 7n * 10n ** 18n, quote: 123_456_789n, expiry: now + 1800n, nonce: 21n,
    delivery: 0n, fixedStart: 0n, cliffSeconds: 0n, durationSeconds: 0n, brokerBps: 2_000n,
    ...changes,
  };
  return { w, c, now, terms, domain: domainOf(CHAIN_ID, c.address) };
}

test("the browser link, wallet payload and deployment hash the same immutable V3 terms", async () => {
  const { c, terms, domain } = await fixture();
  const key = pack(domain, terms), id = dealIdOf(domain, terms), decoded = unpack(key);
  assert.equal(decoded.id, id);
  assert.equal(await c.read.hashTerms(terms), id);
  assert.equal(pack(decoded.domain, decoded.terms), key);
  assert.throws(() => unpack(key + "="));
  assert.throws(() => unpack(key.slice(1)));
  for (const { name, type } of termsType.BrokerTerms) {
    const changed = { ...terms, [name]: type === "address" ? Stranger : terms[name] + 1n };
    assert.notEqual(dealIdOf(domain, changed), id, name);
    assert.equal(await c.read.hashTerms(changed), dealIdOf(domain, changed), name);
  }
});

test("a seller nonce stays burned after refund, and buyer signatures for another chain or deployment cannot settle", async () => {
  const { w, c, terms, domain } = await fixture();
  const id = dealIdOf(domain, terms);
  await w.fam.as(Seller).approve(c.address, terms.allocation);
  await w.usdc.as(Buyer).approve(c.address, terms.quote * 2n);
  const sellerSig = await sign("Seller", domain, terms);
  await c.as(Seller).fund(terms, sellerSig);
  const payers = [Seller, Buyer, Broker, w.treasury, c.address];
  const balances = () => Promise.all(payers.map(owner => w.usdc.read.balanceOf(owner)));
  const before = await balances();
  for (const scope of [{ ...domain, chainId: CHAIN_ID + 1 }, { ...domain, verifyingContract: w.deals.address }]) {
    await assert.rejects(c.as(Buyer).settle(id, await sign("Buyer", scope, terms)), Reverted);
  }
  await c.as(Seller).refund(id);
  await w.fam.as(Seller).approve(c.address, terms.allocation);
  const altered = { ...terms, quote: terms.quote + 1n };
  assert.equal(await c.read.nonces(Seller, terms.nonce), true);
  await assert.rejects(c.as(Seller).fund(altered, await sign("Seller", domain, altered)), Reverted);
  assert.equal(await w.fam.read.balanceOf(c.address), 0n);
  assert.deepEqual(await balances(), before);
});

test("fixed-start grants accrue from their agreed UTC second and an unfilled past start permits only refund", async () => {
  const { w, c, terms, now, domain } = await fixture();
  const fixed = { ...terms, delivery: 1n, fixedStart: now + 300n, cliffSeconds: 100n, durationSeconds: 300n };
  const late = { ...fixed, nonce: fixed.nonce + 1n };
  await w.fam.as(Seller).approve(c.address, 2n * terms.allocation);
  await w.usdc.as(Buyer).approve(c.address, 3n * terms.quote);
  for (const terms of [fixed, late]) await c.as(Seller).fund(terms, await sign("Seller", domain, terms));
  const id = dealIdOf(domain, fixed), lateId = dealIdOf(domain, late);
  await c.as(Buyer).settle(id, await sign("Buyer", domain, fixed));
  const { grantId } = await c.read.getDeal(id);
  const grant = await c.read.getGrant(grantId);
  assert.deepEqual([grant.start, grant.cliff, grant.end],
    [fixed.fixedStart, fixed.fixedStart + 100n, fixed.fixedStart + 300n]);
  await w.at(grant.start + 1n);
  assert.equal(await c.read.claimable(grantId), 0n);
  await assert.rejects(c.as(Buyer).settle(lateId, await sign("Buyer", domain, late)), Reverted);
  await c.as(Seller).refund(lateId);
  await w.at(grant.cliff);
  await assert.rejects(c.as(Stranger).claim(grantId), Reverted);
  await c.as(Buyer).claim(grantId);
  assert.equal(await w.fam.read.balanceOf(Buyer), fixed.allocation / 3n);
  assert.equal(await w.fam.read.balanceOf(grant.custodian), fixed.allocation - fixed.allocation / 3n);
});

test("contract-wallet seller authorization is bound to the digest and must be submitted by that wallet", async () => {
  const { w, c, terms, domain } = await fixture();
  const { SignatureWallet } = compile(ROOT, "test/tokens/SignatureWallet.sol");
  const signer = await deploy(w.chain, Seller, SignatureWallet);
  const signed = { ...terms, seller: signer.address };
  const id = dealIdOf(domain, signed), proof = "0x1234";
  const fund = (value) => c.interface.encodeFunctionData("fund", [signed, value]);
  await w.fam.as(w.deployer).mint(signer.address, signed.allocation);
  await signer.as(Seller).execute(w.fam.address, w.fam.interface.encodeFunctionData("approve", [c.address, signed.allocation]));
  await signer.as(Seller).authorize(id, proof);
  await assert.rejects(signer.as(Seller).execute(c.address, fund("0x4321")), Reverted);
  await assert.rejects(c.as(Seller).fund(signed, proof), Reverted);
  await signer.as(Seller).execute(c.address, fund(proof));
  assert.equal(await w.fam.read.balanceOf(c.address), terms.allocation);
  assert.equal((await c.read.getDeal(id)).status, 1n);
});
