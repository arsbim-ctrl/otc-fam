import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interface } from 'ethers';
import { v2Artifact, v2World } from './support/v2-world.mjs';
import { ChainV2, SELECTOR_V2, createV2Data, encodeV2, fundedId, explainV2 } from '../web/eth-v2.js';
const abi = new Interface(v2Artifact.abi);
test('V2 selectors and tuple encoding agree with compiled ABI', async () => {
  for (const [name, value] of Object.entries(SELECTOR_V2)) assert.equal(value, abi.getFunction(name).selector);
  const w = await v2World(), t = await w.termsV2({ delivery: 1, durationSeconds: 90n, cliffSeconds: 30n });
  assert.equal(createV2Data(t), abi.encodeFunctionData('createDeal', [t]));
  assert.equal(encodeV2('claim', 9n), abi.encodeFunctionData('claim', [9n]));
  const contract = new ChainV2('unused', w.v2.address);
  contract.rpc = w.chain.rpc;
  const id = await w.offerV2(t); await w.acceptV2(id);
  const d = await contract.deal(id), g = await contract.grant(d.grantId);
  assert.equal(d.buyer, t.buyer); assert.equal(d.quote, t.quote); assert.equal(d.status, 'settled');
  assert.equal(g.allocation, t.allocation); assert.equal(g.dealId, id);
  assert.equal(g.beneficiary, t.buyer); assert.equal(g.custodian, w.v2.address);
  assert.equal(await contract.treasury(), w.other);
  const topic = abi.getEvent('DealFunded').topicHash;
  assert.equal(fundedId({ logs: [{ address: w.v2.address, topics: [topic, '0x'+id.toString(16).padStart(64,'0')] }] }, w.v2.address), id);
  for(const name of ['ZeroAddress','InvalidSchedule','NotFunded','NotBuyer','NotSeller','NothingToClaim']) {
    const error = abi.getError(name), data = abi.encodeErrorResult(error,error.inputs.map(()=>1n));
    assert.ok(!explainV2({data}).includes('so it was not sent'), name);
  }
});
