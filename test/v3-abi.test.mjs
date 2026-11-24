import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface, TypedDataEncoder, id, Wallet } from "ethers";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { BROKER_FIELDS, fundData, linkPayload, normalizeTerms, readPayload, settleData, typedTerms, V3_SELECT, V3_TOPIC } from "../web/v3.js";

test("V3 link, wallet payload and calldata agree with the contract ABI and ethers", async () => {
  const abi = new Interface(compile(ROOT, "contracts/BrokerDeals.sol").BrokerDeals.abi);
  for (const [method, selector] of Object.entries(V3_SELECT)) assert.equal(selector, abi.getFunction(method).selector, method);
  for (const [event, topic] of Object.entries(V3_TOPIC)) assert.equal(topic, abi.getEvent(event).topicHash, event);
  assert.deepEqual(BROKER_FIELDS, abi.getFunction("fund").inputs[0].components.map(({ name, type }) => ({ name, type })));
  const [seller, buyer, baseToken, quoteToken, broker, verifyingContract] = Array.from({ length: 6 }, (_, i) => new Wallet(id(String(i))));
  const domain = { name: "OTC.fam Broker Deals", version: "3", chainId: 31337, verifyingContract: verifyingContract.address.toLowerCase() };
  const terms = normalizeTerms({
    seller: seller.address, buyer: buyer.address, baseToken: baseToken.address, quoteToken: quoteToken.address, broker: broker.address,
    allocation: "900000000000000000001", quote: "123456789", expiry: "1800000000",
    nonce: "340282366920938463463374607431768211455", delivery: "1", fixedStart: "0",
    cliffSeconds: "2592000", durationSeconds: "7776000", brokerBps: "2000",
  });
  assert.throws(() => normalizeTerms({ ...terms, broker: terms.seller }), /different wallet address/);
  const link = linkPayload(domain, terms);
  assert.deepEqual(readPayload(link, domain), terms);
  assert.throws(() => readPayload(link, { ...domain, chainId: 1 }), /different chain or broker contract/);
  assert.throws(() => readPayload(link, { ...domain, verifyingContract: seller.address }), /different chain or broker contract/);
  assert.throws(() => readPayload("⟨tampered⟩", domain), /invalid/);
  const signing = typedTerms(domain, terms);
  const types = { BrokerTerms: signing.types.BrokerTerms };
  const digest = TypedDataEncoder.hash(domain, types, signing.message);
  const signature = await seller.signTypedData(domain, types, signing.message);
  assert.equal(signing.primaryType, "BrokerTerms");
  assert.equal(signing.message.allocation, "900000000000000000001");
  assert.equal(fundData(terms, signature), abi.encodeFunctionData("fund", [terms, signature]));
  assert.equal(settleData(digest, signature), abi.encodeFunctionData("settle", [digest, signature]));
});
