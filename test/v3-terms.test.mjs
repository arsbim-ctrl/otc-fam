import assert from "node:assert/strict";
import { test } from "node:test";
import { TypedDataEncoder } from "ethers";
import { CHAIN_ID, deploy, startChain } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";

test("V3 deal IDs agree with EIP-712 for every field in the published interface", async () => {
  const addr = (n) => "0x" + n.toString(16).padStart(40, "0");
  const chain = await startChain([addr(100)]);
  const { BrokerDeals } = compile(ROOT, "contracts/BrokerDeals.sol");
  const { IBrokerDeals } = compile(ROOT, ".launchpad/checks/round-3/IBrokerDeals.sol");
  const fields = IBrokerDeals.abi.find((item) => item.name === "fund").inputs[0].components;
  const types = { BrokerTerms: fields.map(({ name, type }) => ({ name, type })) };
  const contract = await deploy(chain, addr(100), BrokerDeals, [addr(101)]);
  const domain = { name: "OTC.fam Broker Deals", version: "3", chainId: CHAIN_ID, verifyingContract: contract.address };
  const terms = {
    seller: addr(1), buyer: addr(2), broker: addr(3), baseToken: addr(4), quoteToken: addr(5),
    allocation: 1000000n * 10n ** 18n, quote: 123456789n, expiry: 2000000000n, nonce: 7n,
    delivery: 1n, fixedStart: 1999999900n, cliffSeconds: 30n, durationSeconds: 90n, brokerBps: 2000n,
  };
  const original = await contract.read.dealId(terms);
  assert.equal(original, TypedDataEncoder.hash(domain, types, terms));
  for (const { name, type } of fields) {
    const value = type === "address" ? addr(99) : name === "delivery" ? 0n : terms[name] + 1n;
    const modified = { ...terms, [name]: value };
    const actual = await contract.read.dealId(modified);
    assert.notEqual(actual, original, name);
    assert.equal(actual, TypedDataEncoder.hash(domain, types, modified), name);
  }
});
