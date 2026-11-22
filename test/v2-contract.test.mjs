import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploy } from '../.launchpad/checks/round-1/chain.mjs';
import { v2World, reverted, v2Artifact } from './support/v2-world.mjs';

const oracle = (a, s, c, e, t) => t < c ? 0n : t >= e ? a : a * (t - s) / (e - s);

test('V2 immediate: actual deltas conserve both fees over dust boundaries and random payments', async () => {
  const w = await v2World();
  let seed = 77n;
  const quotes = [199n, 200n, 123456789n];
  for (let i = 0; i < 12; i++) { seed = seed * 48271n % 2147483647n; quotes.push(seed); }
  for (const quote of quotes) {
    const a = 101n, f = quote * 50n / 10000n;
    const before = await w.snapshot(), id = await w.offerV2({ quote, allocation: a });
    const funded = await w.snapshot();
    assert.deepEqual(funded.map((v,i) => v-before[i]), [-a,0n,0n,a,0n,0n,0n,0n]);
    const events = await w.acceptV2(id), after = await w.snapshot();
    assert.deepEqual(after.map((v,i) => v-before[i]), [-a,a,0n,0n,quote-f,-quote-f,2n*f,0n]);
    const d = await w.v2.read.getDeal(id);
    assert.equal(d.status, 2n); assert.equal(d.grantId, 0n);
    assert.ok(!events.some(e => e.name === 'GrantCreated'));
    const settled = events.find(e => e.name === 'DealSettled');
    assert.equal(settled.args.buyerFee, f); assert.equal(settled.args.sellerFee, f);
    await reverted(w.v2.as(w.taker).fill(id)); await reverted(w.v2.as(w.maker).cancel(id));
    assert.deepEqual(await w.snapshot(), after);
  }
});

test('V2 funded grants: huge/one-unit allocations, boundary oracle, immutable buyer, repeated permissionless claims and final dust', async () => {
  for (const allocation of [1n, 1000000n * 10n ** 18n, 1n << 240n, (1n << 240n) + 1n]) {
    const w = await v2World();
    const start = BigInt(await w.chain.now()) + 100n, cliff = start + 30n, end = start + 90n;
    const before = await w.snapshot();
    const id = await w.offerV2({ delivery: 1, allocation, fixedStart: start, cliffSeconds: 30n, durationSeconds: 90n });
    const events = await w.acceptV2(id), d = await w.v2.read.getDeal(id);
    const grant = await w.v2.read.getGrant(d.grantId);
    assert.equal(grant.beneficiary.toLowerCase(), w.taker); assert.equal(grant.custodian.toLowerCase(), w.v2.address);
    assert.equal(grant.dealId, id); assert.equal(grant.allocation, allocation);
    assert.equal(grant.start, start); assert.equal(grant.cliff, cliff); assert.equal(grant.end, end);
    assert.ok(events.some(e => e.name === 'GrantCreated'));
    const after = await w.snapshot(), q = d.terms.quote, fee = q*50n/10000n;
    assert.deepEqual(after.map((v,i) => v-before[i]), [-allocation,0n,0n,allocation,q-fee,-q-fee,fee*2n,0n]);
    await reverted(w.v2.as(w.taker).fill(id));
    let claimed = 0n;
    for (const t of [start-1n,start,cliff-1n,cliff,start+45n,end-1n,end,end+1n]) {
      await w.chain.setNextTime(Number(t)); await w.chain.mine();
      const expected = oracle(allocation,start,cliff,end,t);
      assert.equal(await w.v2.read.vested(d.grantId), expected, `allocation ${allocation}, time ${t}`);
      assert.equal(await w.v2.read.claimable(d.grantId), expected-claimed);
      const snap = await w.snapshot();
      await w.chain.setNextTime(Number(t));
      if (expected === claimed) await reverted(w.v2.as(w.other).claim(d.grantId));
      else {
        const logs = await w.v2.as(w.other).claim(d.grantId);
        assert.equal(logs[0].args.beneficiary.toLowerCase(), w.taker);
        assert.equal(logs[0].args.amount, expected-claimed);
      }
      const paid = expected-claimed, next = await w.snapshot();
      assert.deepEqual(next.map((v,i) => v-snap[i]), [0n,paid,0n,-paid,0n,0n,0n,0n]);
      claimed = expected;
      assert.equal((await w.v2.read.getGrant(d.grantId)).claimed, claimed);
      assert.ok(claimed <= allocation);
    }
    assert.equal(claimed, allocation);
  }
});

test('V2 settlement-time start and stale fixed start; strict validation before escrow', async () => {
  const w = await v2World();
  const id = await w.offerV2({ delivery: 1, cliffSeconds: 30n, durationSeconds: 90n });
  await w.acceptV2(id);
  assert.equal((await w.v2.read.getGrant(1)).start, BigInt(await w.chain.now()));
  const t = await w.termsV2({ delivery: 1, durationSeconds: 90n });
  const before = await w.snapshot();
  for (const patch of [{ buyer: '0x'+'0'.repeat(40) }, { allocation: 0n }, { quote: 0n }, { baseToken: w.quote.address }, { baseToken: w.other }, { quoteToken: w.other }, { expiry: 0n }, { cliffSeconds: 90n }, { durationSeconds: 0n }, { fixedStart: BigInt(await w.chain.now()) }, { fixedStart: (1n << 64n) - 1n }, { delivery: 0, durationSeconds: 1n }, { quote: (1n<<256n)-1n }]) {
    await reverted(w.v2.as(w.maker).createDeal({ ...t, ...patch }));
    assert.deepEqual(await w.snapshot(), before);
  }
  const future = BigInt(await w.chain.now())+10n;
  const stale = await w.offerV2({ delivery: 1, fixedStart: future, durationSeconds: 90n });
  await w.chain.setNextTime(Number(future)); await w.chain.mine();
  await reverted(w.acceptV2(stale)); assert.equal((await w.v2.read.getDeal(stale)).status,1n);
  await w.v2.as(w.maker).cancel(stale);
  await reverted(deploy(w.chain,w.deployer,v2Artifact,['0x'+'0'.repeat(40)]));
});

test('V2 rollback: failing, fee-taking and blocked transfers leak no fees or grants; retry and refund', async () => {
  for (const mode of [0,1]) for (const kind of [1,2,3]) {
    const w = await v2World(), id = await w.offerV2({ delivery: mode, cliffSeconds: mode ? 30n : 0n, durationSeconds: mode ? 90n : 0n });
    await w.quote.as(w.taker).approve(w.v2.address, 200000000n);
    await w.quote.as(w.deployer).setKind(kind);
    const snap = await w.snapshot();
    await reverted(w.v2.as(w.taker).fill(id));
    assert.deepEqual(await w.snapshot(), snap); assert.equal((await w.v2.read.getDeal(id)).status,1n);
    assert.equal((await w.v2.read.getDeal(id)).grantId,0n); assert.equal((await w.v2.read.getGrant(1)).allocation,0n);
    await w.quote.as(w.deployer).setKind(0);
    await w.v2.as(w.taker).fill(id);
  }
  const w = await v2World(), id = await w.offerV2();
  await w.base.as(w.deployer).setKind(1);
  const snap = await w.snapshot(); await reverted(w.acceptV2(id)); assert.deepEqual(await w.snapshot(),snap);
  await w.base.as(w.deployer).setKind(0); await w.v2.as(w.maker).cancel(id);
  assert.equal((await w.v2.read.getDeal(id)).status,3n);
});

test('V2 wrong buyer, expiry, cancel authority and terminal states preserve funds', async () => {
  const w = await v2World(), expiry = BigInt(await w.chain.now())+100n, id = await w.offerV2({ expiry });
  const snap = await w.snapshot();
  await reverted(w.v2.as(w.other).fill(id)); await reverted(w.v2.as(w.taker).cancel(id));
  await w.chain.setNextTime(Number(expiry)); await w.chain.mine();
  await reverted(w.acceptV2(id)); assert.deepEqual(await w.snapshot(), snap);
  await w.v2.as(w.maker).cancel(id);
  const after = await w.snapshot(); await reverted(w.v2.as(w.taker).fill(id)); await reverted(w.v2.as(w.maker).cancel(id));
  assert.deepEqual(await w.snapshot(),after);
  assert.equal(await w.v2.read.vested(999),0n); assert.equal(await w.v2.read.claimable(999),0n);
});

test('V2 outbound treasury failure rolls back grant creation and all payment deltas; blocked claim is retryable',async()=>{
  const {compile}=await import('../.launchpad/checks/round-1/compile.mjs');
  const fixture=compile(process.cwd(),'test/tokens/VaultToken.sol').VaultToken;
  const w=await v2World(), token=await deploy(w.chain,w.deployer,fixture);
  await token.as(w.deployer).mint(w.taker,1000000000n);
  const t=await w.termsV2({quoteToken:token.address,delivery:1,durationSeconds:90n,cliffSeconds:30n});
  await w.base.as(w.maker).approve(w.v2.address,t.allocation);
  await w.v2.as(w.maker).createDeal(t);
  await token.as(w.taker).approve(w.v2.address,200000000n);
  const holdings=()=>Promise.all([w.maker,w.taker,w.other,w.v2.address].map(a=>token.read.balanceOf(a)));
  const before=await holdings();
  await token.as(w.deployer).blockRecipient(w.other);
  await reverted(w.v2.as(w.taker).fill(1));
  assert.deepEqual(await holdings(),before); assert.equal((await w.v2.read.getDeal(1)).status,1n);
  assert.equal((await w.v2.read.getGrant(1)).allocation,0n);
  await token.as(w.deployer).blockRecipient('0x'+'0'.repeat(40));
  await w.v2.as(w.taker).fill(1);
  assert.equal((await w.v2.read.getGrant(1)).allocation,t.allocation);

  const base=await deploy(w.chain,w.deployer,fixture);
  await base.as(w.deployer).mint(w.maker,101n); await base.as(w.maker).approve(w.v2.address,101n);
  await w.v2.as(w.maker).createDeal(await w.termsV2({baseToken:base.address,allocation:101n,delivery:1,durationSeconds:90n,cliffSeconds:30n}));
  await w.acceptV2(2);
  const g=await w.v2.read.getGrant(2);
  await w.chain.setNextTime(Number(g.end));await w.chain.mine();
  await base.as(w.deployer).blockRecipient(w.taker);
  await reverted(w.v2.as(w.other).claim(2));
  assert.equal((await w.v2.read.getGrant(2)).claimed,0n);assert.equal(await base.read.balanceOf(w.v2.address),101n);
  await base.as(w.deployer).blockRecipient('0x'+'0'.repeat(40));await w.v2.as(w.other).claim(2);
  assert.equal(await base.read.balanceOf(w.taker),101n);
});

test('V2 lock refuses callbacks into create, fill, cancel and claim during escrow, settlement, refunds and claims',async()=>{
  const {compile}=await import('../.launchpad/checks/round-1/compile.mjs');
  const fixture=compile(process.cwd(),'test/tokens/VaultToken.sol').VaultToken;
  for(const outer of ['create','fill','cancel','claim']) for(const callback of ['createDeal','fill','cancel','claim']){
    const w=await v2World(),base=await deploy(w.chain,w.deployer,fixture);
    await base.as(w.deployer).mint(w.maker,1000n);await base.as(w.maker).approve(w.v2.address,1000n);
    const t=await w.termsV2({baseToken:base.address,allocation:100n,delivery:outer==='claim'?1:0,durationSeconds:outer==='claim'?90n:0n});
    if(outer!=='create')await w.v2.as(w.maker).createDeal(t);
    if(outer==='claim') {await w.acceptV2(1);const g=await w.v2.read.getGrant(1);await w.chain.setNextTime(Number(g.end));await w.chain.mine();}
    const data=w.v2.interface.encodeFunctionData(callback,callback==='createDeal'?[t]:[1]);
    await base.as(w.deployer).arm(w.v2.address,data);
    if(outer==='create')await w.v2.as(w.maker).createDeal(t);
    if(outer==='fill')await w.acceptV2(1);
    if(outer==='cancel')await w.v2.as(w.maker).cancel(1);
    if(outer==='claim')await w.v2.as(w.other).claim(1);
    assert.equal(await base.read.calledBack(),false,`${outer} → ${callback}`);
    assert.equal(await base.read.armed(),false,'callback was attempted');
    assert.equal(await base.read.balanceOf(w.v2.address),outer==='create'?100n:0n);
  }
});

test('V2 no-return ERC-20 works for both sides; failed escrow and claim transfers remain exact',async()=>{
  const w=await v2World(),quiet=await w.token('NoReturnToken','QUIET',6);
  for(const quoteSide of [false,true]) {
    const t=await w.termsV2(quoteSide?{quoteToken:quiet.address,quote:123456789n}:{baseToken:quiet.address,allocation:1000000n});
    const base=quoteSide?w.base:quiet,quote=quoteSide?quiet:w.quote;
    await base.as(w.maker).approve(w.v2.address,t.allocation);
    const events=await w.v2.as(w.maker).createDeal(t),id=events.find(e=>e.name==='DealFunded').args[0];
    await quote.as(w.taker).approve(w.v2.address,t.quote+t.quote/200n);
    await w.v2.as(w.taker).fill(id); assert.equal((await w.v2.read.getDeal(id)).status,2n);
  }
  const t=await w.termsV2();
  await w.base.as(w.maker).approve(w.v2.address,t.allocation);
  for(const kind of [1,2,3]){
    await w.base.as(w.deployer).setKind(kind);const snap=await w.snapshot();
    await reverted(w.v2.as(w.maker).createDeal(t)); assert.deepEqual(await w.snapshot(),snap);
  }
  await w.base.as(w.deployer).setKind(0);
  const id=await w.offerV2({delivery:1,durationSeconds:90n});await w.acceptV2(id);
  const d=await w.v2.read.getDeal(id),g=await w.v2.read.getGrant(d.grantId);
  await w.chain.setNextTime(Number(g.end));await w.chain.mine();
  for(const kind of [1,2,3]){
    await w.base.as(w.deployer).setKind(kind);const snap=await w.snapshot();
    await reverted(w.v2.as(w.other).claim(d.grantId));assert.deepEqual(await w.snapshot(),snap);
    assert.equal((await w.v2.read.getGrant(d.grantId)).claimed,0n);
  }
  await w.base.as(w.deployer).setKind(0);await w.v2.as(w.other).claim(d.grantId);
  assert.equal((await w.v2.read.getGrant(d.grantId)).claimed,g.allocation);
});

test('V2 shared vault keeps funded deals and multiple grants solvent through claims and refunds',async()=>{
  const w=await v2World(),initial=await w.snapshot();
  const first=await w.offerV2({allocation:101n,delivery:1,durationSeconds:90n});
  const second=await w.offerV2({allocation:199n,delivery:1,durationSeconds:90n});
  const refundable=await w.offerV2({allocation:301n});
  await w.acceptV2(first);await w.acceptV2(second);
  assert.equal((await w.v2.read.getDeal(first)).grantId,1n);assert.equal((await w.v2.read.getDeal(second)).grantId,2n);
  await w.v2.as(w.maker).cancel(refundable);
  assert.equal(await w.base.read.balanceOf(w.v2.address),300n);
  const g=await w.v2.read.getGrant(2);await w.chain.setNextTime(Number(g.end));await w.chain.mine();
  await w.v2.as(w.other).claim(1);assert.equal(await w.base.read.balanceOf(w.v2.address),199n);
  await w.v2.as(w.other).claim(2);assert.equal(await w.base.read.balanceOf(w.v2.address),0n);
  const final=await w.snapshot();assert.equal(final[1]-initial[1],300n);assert.equal(initial[0]-final[0],300n);
});
