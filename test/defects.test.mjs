import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explain } from '../web/eth.js';
import { world } from '../.launchpad/checks/round-1/world.mjs';
import { serve, withPage, wallet, until, pressUntil, seen } from '../.launchpad/checks/round-1/page.mjs';

test('gas errors become a plain sentence without swallowing unrelated RPC messages', () => {
  for (const error of [{code:-32000,message:'insufficient funds for gas * price + value'}, {code:'INSUFFICIENT_FUNDS'}, {info:{error:{message:'insufficient funds for gas'}}}]) assert.equal(explain(error),'This wallet has too little ETH to pay the network fee. Add some, then try again.');
  assert.equal(explain({code:-32000,message:'The network cannot be reached.'}),'The network cannot be reached. Check your connection and try again.');
  assert.equal(explain({code:-32000,message:'execution reverted: custom node detail'}),'execution reverted: custom node detail');
  assert.equal(explain(new TypeError('Failed to fetch')),'The network cannot be reached. Check your connection and try again.');
  assert.equal(explain({code:'TIMEOUT',message:'request timeout'}),'The network took too long to answer. Refresh to check the on-chain status, then try again.');
  assert.equal(explain({code:'ACTION_REJECTED'}),'You declined in your wallet. Nothing was sent.');
});

test('legacy polling updates relative expiry in place and keeps the keyboard action node focused', async () => {
  const w=await world(), id=await w.offer({expiry: Math.max(await w.chain.now(),Math.floor(Date.now()/1000))+3600});
  const site=await serve(w);
  try { await withPage(site,`#/d/${id}`,wallet(w,w.taker),async page=>{
    await until(async()=>await page.getByTestId('primary-action').count(),'primary action');
    // Advance the browser clock across the relative-text rounding boundary.
    await page.getByTestId('primary-action').focus();
    const before=await page.getByTestId('expires').textContent();
    await page.evaluate(()=>{window.originalAction=document.querySelector('[data-testid="primary-action"]'); const now=Date.now; Date.now=()=>now()+120000;});
    await until(async()=>await page.getByTestId('expires').textContent()!==before,'relative expiry changes during polling',8000);
    assert.equal(await page.evaluate(()=>document.activeElement===window.originalAction && window.originalAction===document.querySelector('[data-testid="primary-action"]')),true);
  }); } finally {await site.close();}
});

test('legacy expiry refuses sub-minute and exponent input, keeps one-minute and 8760-hour range', async () => {
  const w=await world(),site=await serve(w);
  try { await withPage(site,'#/new',wallet(w,w.maker),async page=>{
    for(const [key,value] of Object.entries({'sell-token':w.alfa.address,'sell-amount':'1','buy-token':w.bravo.address,'buy-amount':'1',taker:w.taker})) await page.getByTestId(key).fill(value);
    await until(async()=>await seen(page,'primary-action')==='Connect wallet','connect button');
    await page.getByTestId('primary-action').click();
    await until(async()=>(await seen(page,'primary-action'))?.startsWith('Approve'),'connected and valid');
    for(const text of ['0.0001','0.0166666','1e2']) {
      await page.getByTestId('expiry-hours').fill(text);
      await until(async()=>await seen(page,'primary-action')==='Check the hours','invalid hours');
      assert.equal(await page.getByTestId('primary-action').isDisabled(),true);
    }
    for(const text of ['8760','0.0166667']) {
      await page.getByTestId('expiry-hours').fill(text);
      await until(async()=>(await seen(page,'primary-action'))?.startsWith('Approve'),'valid hours');
    }
    await pressUntil(page,async()=>await page.getByTestId('deal-link').count()===1,'funded one minute deal');
    const d=await w.deals.read.getDeal(1);
    assert.ok(Number(d.expiry)-await w.chain.now()>=60);
  }); } finally {await site.close();}
});

test('legacy fill from a wallet with tokens and no gas displays recovery text', async () => {
  const w=await world(), id=await w.offer();
  await w.bravo.as(w.taker).approve(w.deals.address,w.BUY);
  await w.chain.rpc('hardhat_setBalance',[w.taker,'0x0']);
  const site=await serve(w);
  try {await withPage(site,`#/d/${id}`,wallet(w,w.taker),async page=>{
    await pressUntil(page,async()=>(await seen(page,'notice'))?.includes('too little ETH'),'gas message');
    assert.equal((await w.deals.read.getDeal(id)).status,1n);
  });} finally {await site.close();}
});
