import assert from 'node:assert/strict';
import { compile } from '../.launchpad/checks/round-1/compile.mjs';
import { deploy, Reverted } from '../.launchpad/checks/round-1/chain.mjs';
import { world, STATUS, ANYONE } from '../.launchpad/checks/round-1/world.mjs';

const artifact = compile(process.cwd(), 'tests/AdversarialToken.sol').AdversarialToken;
let count = 0;
const test = async (name, fn) => { await fn(); console.log(`PASS ${++count}: ${name}`); };
const rejects = async (tx) => assert.rejects(tx, Reverted);
async function edge(w) {
  const t = await deploy(w.chain, w.deployer, artifact);
  Object.assign(t, { symbol: 'EDGE', decimals: 6 }); w.tokens.EDGE = t;
  for (const who of [w.maker, w.taker, w.other, t.address]) await t.as(w.deployer).mint(who, 10n ** 15n);
  await w.join('token', t.address);
  return t;
}
async function snapshot(w, id) {
  const deal = await w.deals.read.getDeal(id);
  const allowances = [];
  for (const t of Object.values(w.tokens)) for (const who of [w.maker, w.taker, w.other]) allowances.push(await t.read.allowance(who, w.deals.address));
  return { balances: await w.holdings(), deal: [...deal], allowances };
}
async function failUnchanged(w, id, from = w.taker) {
  const before = await snapshot(w, id);
  const hash = await w.chain.submit(from, { to: w.deals.address, data: w.deals.interface.encodeFunctionData('fill', [id]) });
  const receipt = await w.chain.rpc('eth_getTransactionReceipt', [hash]);
  assert.equal(receipt.status, '0x0'); assert.equal(receipt.logs.length, 0);
  assert.deepEqual(await snapshot(w, id), before);
}

for (const side of ['sell', 'buy']) for (const [mode, name] of [[0, 'ordinary'], [2, 'no-return'], [1, 'false'], [3, 'revert'], [4, 'no-op true'], [5, 'short return'], [6, 'non-boolean'], [7, 'recipient tax'], [8, 'sender surcharge']]) {
  await test(`${side} token: ${name}`, async () => {
    const w = await world(), t = await edge(w), amount = 500n;
    const id = await w.offer({ [`${side}Token`]: t.address, [`${side}Amount`]: amount });
    const d = await w.deals.read.getDeal(id), buy = side === 'buy' ? t : w.bravo;
    await w.approve(w.taker, buy, d.buyAmount);
    await t.as(w.deployer).setMode(mode);
    if ([0, 2].includes(mode)) {
      const before = await w.holdings(); await w.deals.as(w.taker).fill(id);
      await w.moved(before, { maker: { [side === 'sell' ? 'EDGE' : 'ALFA']: -d.sellAmount, [side === 'buy' ? 'EDGE' : 'BRAVO']: d.buyAmount }, taker: { [side === 'sell' ? 'EDGE' : 'ALFA']: d.sellAmount, [side === 'buy' ? 'EDGE' : 'BRAVO']: -d.buyAmount } }, name);
    } else {
      await failUnchanged(w, id);
      await t.as(w.deployer).setMode(0); await w.deals.as(w.taker).fill(id);
      assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Filled);
    }
  });
}

for (const side of ['sell', 'buy']) for (const operation of ['fill-same', 'fill-other', 'cancel-same', 'cancel-other', 'create']) for (const propagate of [false, true]) {
  await test(`reentry ${side} → ${operation}, ${propagate ? 'propagated' : 'swallowed'}`, async () => {
    const w = await world(), t = await edge(w);
    // Token owns the target deals: cancellation callbacks are genuinely authorized absent the guard.
    const sell = side === 'sell' ? t : w.alfa, buy = side === 'buy' ? t : w.bravo;
    const bystander = await w.offer({ sellToken: sell.address, sellAmount: 400n }, w.other);
    const other = await w.offer({ sellToken: sell.address, sellAmount: 400n }, t.address);
    const id = await w.offer({ sellToken: sell.address, sellAmount: 400n, buyToken: buy.address, buyAmount: 250n }, t.address);
    await w.approve(t.address, sell, 5000n); await w.approve(t.address, w.bravo, w.BUY * 3n);
    await w.approve(t.address, buy, buy.address === w.bravo.address ? w.BUY * 3n : 5000n); await w.approve(w.taker, buy, 250n);
    const op = operation.split('-')[0], target = operation.endsWith('other') ? other : id;
    const args = op === 'create' ? [w.alfa.address, 1n, w.bravo.address, 1n, ANYONE, await w.chain.now() + 3600] : [target];
    await t.as(w.deployer).arm(w.deals.address, w.deals.interface.encodeFunctionData(op === 'create' ? 'createDeal' : op, args), propagate);
    const before = await w.holdings();
    if (propagate) await failUnchanged(w, id);
    else {
      await w.deals.as(w.taker).fill(id);
      assert.equal(await t.read.calledBack(), false);
      assert.equal((await t.read.callbackResult()).slice(0, 10), '0x3ee5aeb5'); // ReentrancyGuardReentrantCall()
      await w.moved(before, { token: { [sell.symbol]: -400n, [buy.symbol]: 250n }, taker: { [sell.symbol]: 400n, [buy.symbol]: -250n } }, 'one outer fill');
    }
    assert.equal((await w.deals.read.getDeal(other)).status, STATUS.Open);
    assert.equal((await w.deals.read.getDeal(4)).status, STATUS.None);
    await w.deals.as(w.other).cancel(bystander);
    await w.deals.as(t.address).cancel(other);
  });
}

await test('whole-fill deltas detect a second-leg mutation of the already transferred buy token', async () => {
  const w = await world(), t = await edge(w);
  const id = await w.offer({ sellToken: t.address, sellAmount: 500n });
  await w.approve(w.taker, w.bravo, w.BUY);
  await t.as(w.deployer).arm(w.bravo.address, w.bravo.interface.encodeFunctionData('mint', [w.maker, 1n]), false);
  await failUnchanged(w, id);
});
await test('settlement cannot add to or spend unsolicited contract deposits', async () => {
  const w = await world(), t = await edge(w);
  const id = await w.offer({ sellToken: t.address, sellAmount: 500n });
  await w.approve(w.taker, w.bravo, w.BUY);
  await w.alfa.as(w.deployer).mint(w.deals.address, 77n);
  await w.bravo.as(w.deployer).mint(w.deals.address, 88n);
  await t.as(w.deployer).arm(w.bravo.address, w.bravo.interface.encodeFunctionData('mint', [w.deals.address, 1n]), false);
  await failUnchanged(w, id);
  await t.as(w.deployer).arm(w.bravo.address, w.bravo.interface.encodeFunctionData('mint', [w.deals.address, 0n]), false);
  const before = await w.holdings(); await w.deals.as(w.taker).fill(id);
  assert.deepEqual((await w.holdings()).contract, before.contract);
});
for (const privateDeal of [false, true]) await test(`maker self-fill ${privateDeal ? 'reserved to self' : 'open'} preserves net balances and spends both allowances`, async () => {
  const w = await world(), id = await w.offer({ taker: privateDeal ? w.maker : ANYONE });
  await failUnchanged(w, id, w.maker); // missing buy allowance, despite identity alias
  await w.approve(w.maker, w.bravo, w.BUY);
  const before = await w.holdings(); await w.deals.as(w.maker).fill(id);
  await w.moved(before, {}, 'self-fill');
  assert.equal(await w.alfa.read.allowance(w.maker, w.deals.address), 0n);
  assert.equal(await w.bravo.read.allowance(w.maker, w.deals.address), 0n);
  await rejects(w.deals.as(w.maker).fill(id)); await rejects(w.deals.as(w.maker).cancel(id));
});
await test('self-fill fee still reverts with no balance or allowance loss', async () => {
  const w = await world(), t = await edge(w);
  const id = await w.offer({ sellToken: t.address, sellAmount: 500n, taker: w.maker });
  await w.approve(w.maker, w.bravo, w.BUY); await t.as(w.deployer).setMode(7);
  await failUnchanged(w, id, w.maker);
});
await test('taker may be the token contract itself without address-alias accounting errors', async () => {
  const w = await world(), t = await edge(w);
  const id = await w.offer({ buyToken: t.address, buyAmount: 500n, taker: t.address });
  await w.approve(t.address, t, 500n);
  const before = await w.holdings(); await w.deals.as(t.address).fill(id);
  await w.moved(before, { maker: { ALFA: -w.SELL, EDGE: 500n }, token: { ALFA: w.SELL, EDGE: -500n } }, 'token taker');
});
await test('maker revokes approval: first-leg transfer and allowance roll back; recovery succeeds', async () => {
  const w = await world(), id = await w.offer(); await w.approve(w.taker, w.bravo, w.BUY);
  await w.approve(w.maker, w.alfa, 0n); await failUnchanged(w, id);
  await w.approve(w.maker, w.alfa, w.SELL - 1n); await failUnchanged(w, id);
  await w.approve(w.maker, w.alfa, w.SELL); await w.deals.as(w.taker).fill(id);
});
await test('spent maker funds are not replenished by cancel; cancellation makes no token calls', async () => {
  const w = await world(), t = await edge(w), id = await w.offer({ sellToken: t.address, sellAmount: 500n });
  await t.as(w.deployer).burn(w.maker, await t.read.balanceOf(w.maker));
  await w.approve(w.taker, w.bravo, w.BUY); await failUnchanged(w, id);
  await t.as(w.deployer).setMode(12); await w.deals.as(w.maker).cancel(id);
  assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Cancelled);
});
await test('shared allowance cannot fund two offers; cancelled offer never revives', async () => {
  const w = await world(), first = await w.offer(), second = await w.offer();
  await w.accept(first); await w.approve(w.taker, w.bravo, w.BUY); await failUnchanged(w, second);
  await w.deals.as(w.maker).cancel(second); await w.approve(w.maker, w.alfa, w.SELL); await rejects(w.deals.as(w.taker).fill(second));
});
await test('bad token addresses/terms do not consume ids; unknown ids remain readable', async () => {
  const w = await world(), terms = await w.terms();
  for (const t of [ANYONE, w.maker]) for (const side of ['sellToken', 'buyToken']) await rejects(w.create(w.maker, { ...terms, [side]: t }));
  for (const args of [{ sellAmount: 0n }, { buyAmount: 0n }, { buyToken: terms.sellToken }, { expiry: await w.chain.now() }]) await rejects(w.create(w.maker, { ...terms, ...args }));
  assert.equal(await w.offer(), 1); assert.equal((await w.deals.read.getDeal((1n << 256n) - 1n)).status, STATUS.None);
  for (const id of [0, 999]) { await rejects(w.deals.as(w.maker).cancel(id)); await rejects(w.deals.as(w.taker).fill(id)); }
});
await test('deterministic randomized state-machine: authority, immutable terms, terminal states and balances', async () => {
  const w = await world(); let seed = 0x9321;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 24; i++) {
    const sold = BigInt(random() % 10000 + 1), bought = BigInt(random() % 1000 + 1), reserved = (random() >>> 8) % 2;
    const id = await w.offer({ sellAmount: sold, buyAmount: bought, taker: reserved ? w.taker : ANYONE });
    const original = [...await w.deals.read.getDeal(id)].slice(0, -1);
    await rejects(w.deals.as(w.other).cancel(id));
    if (reserved) { await w.approve(w.other, w.bravo, bought); await failUnchanged(w, id, w.other); }
    const before = await w.holdings(), fill = Boolean((random() >>> 8) % 2);
    if (fill) { await w.accept(id); await w.moved(before, { maker: { ALFA: -sold, BRAVO: bought }, taker: { ALFA: sold, BRAVO: -bought } }, 'random fill'); }
    else { await w.deals.as(w.maker).cancel(id); await w.moved(before, {}, 'random cancel'); }
    assert.deepEqual([...await w.deals.read.getDeal(id)].slice(0, -1), original);
    await rejects(w.deals.as(w.taker).fill(id)); await rejects(w.deals.as(w.maker).cancel(id));
  }
});
await test('expiry -1, exact expiry and expiry +1; token-free cancellation after expiry', async () => {
  const w = await world(), expiry = await w.chain.now() + 100;
  const early = await w.offer({ expiry }), exact = await w.offer({ expiry }), late = await w.offer({ expiry });
  await w.approve(w.maker, w.alfa, w.SELL * 3n); await w.approve(w.taker, w.bravo, w.BUY * 3n);
  await w.chain.setNextTime(expiry - 1); await w.deals.as(w.taker).fill(early);
  await w.chain.setNextTime(expiry); await failUnchanged(w, exact);
  await w.chain.setNextTime(expiry + 1); await failUnchanged(w, late);
  await w.deals.as(w.maker).cancel(exact); await w.deals.as(w.maker).cancel(late);
});
console.log(`${count} adversarial contract tests passed.`);
