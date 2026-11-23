import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { v2World } from './support/v2-world.mjs';
import { serve, withPage, wallet, until, pressUntil, seen } from '../.launchpad/checks/round-1/page.mjs';

async function configure(page,site,w,width=390) {
  await page.route('**/config.json',route=>route.fulfill({json:{chainId:31337,contract:w.deals.address,contractV2:w.v2.address,rpcUrl:`${site.url}/rpc`}}));
  await page.setViewportSize({width,height:844}); await page.reload();
}
async function status(page,value) { await until(async()=>await page.getByTestId('deal-status').getAttribute('data-status').catch(()=>null)===value,`V2 status ${value}`); }
async function noOverflow(page) { assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal scroll'); }
mkdirSync('screens',{recursive:true});

for(const width of [390,1440]) for(const delivery of [0,1]) test(`V2 seller → private link → fresh buyer → ${delivery?'vesting claim':'immediate'} at ${width}px`,async()=>{
  const w=await v2World(),site=await serve(w); let id;
  try {
    await withPage(site,'#/v2/new',wallet(w,w.maker),async page=>{
      await configure(page,site,w,width);
      await page.getByTestId('delivery').selectOption(String(delivery));
      for(const [key,value] of Object.entries({'sell-token':w.base.address,'sell-amount':'1000000','buy-token':w.quote.address,'buy-amount':'123.456789',taker:w.taker})) await page.getByTestId(key).fill(value);
      await until(async()=>(await page.getByTestId('preview').textContent()).includes('124.074072'),'exact buyer total preview');
      const preview=await page.getByTestId('preview').textContent();
      for(const text of ['0.617283','122.839506','1.234566',w.taker]) assert.ok(preview.includes(text),text);
      await noOverflow(page);
      await page.screenshot({path:`screens/v2-${delivery}-${width}-seller.png`,fullPage:true});
      await pressUntil(page,async()=>await page.getByTestId('deal-link').count()===1,'funded V2 link');
      const link=await page.getByTestId('deal-link').getAttribute('href');
      id=BigInt(/\/d\/(\d+)$/.exec(link)[1]);
      assert.equal((await w.v2.read.getDeal(id)).status,1n);
    });
    await withPage(site,`#/v2/d/${id}`,null,async page=>{
      await configure(page,site,w,width); await status(page,'funded');
      const text=await page.locator('main').textContent();
      for(const term of ['On-chain funded','124.074072','122.839506','0.617283','1.234566',w.taker,w.maker,w.other]) assert.ok(text.includes(term),term);
      assert.equal(await page.evaluate(()=>Boolean(window.ethereum)),false);
      await noOverflow(page); await page.screenshot({path:`screens/v2-${delivery}-${width}-buyer-readonly.png`,fullPage:true});
    });
    await withPage(site,`#/v2/d/${id}`,wallet(w,w.taker),async page=>{
      await configure(page,site,w,width); await status(page,'funded');
      await pressUntil(page,async()=>(await w.v2.read.getDeal(id)).status===2n,'V2 settled');
      await status(page,'settled');
      await until(async()=>await page.getByTestId('transaction-receipt').count()===1,'settlement receipt');
      await page.reload(); await status(page,'settled');
      await until(async()=>(await seen(page,'transaction-receipt'))?.startsWith('Settlement'),'settlement receipt after reload');
      if(delivery) {
        assert.ok((await page.getByTestId('deal-status').textContent()).includes('vesting continues'));
        const g=await w.v2.read.getGrant(1);
        await until(async()=>(await page.getByTestId('claim-timing').textContent()).includes('Claiming becomes possible'),'before cliff explanation');
        assert.ok((await page.locator('main').textContent()).includes('UTC'));
        await w.chain.setNextTime(Number(g.start)+29*86400); await w.chain.mine(); await page.reload();
        await until(async()=>await seen(page,'claimable')==='0 ALLOCATION','day 29 zero');
        await w.chain.setNextTime(Number(g.start)+30*86400); await w.chain.mine(); await page.reload();
        await until(async()=>(await seen(page,'claimable'))?.includes('333,333.333333333333333333'),'cliff accrual');
        await page.getByTestId('primary-action').focus();
        await page.evaluate(()=>window.originalAction=document.querySelector('[data-testid="primary-action"]'));
        await w.chain.setNextTime(Number(g.start)+45*86400); await w.chain.mine();
        await until(async()=>await seen(page,'claimable')==='500,000 ALLOCATION','midpoint polling',8000);
        assert.equal(await page.evaluate(()=>document.activeElement===window.originalAction),true,'claim focus kept during value changes');
        await noOverflow(page); await page.screenshot({path:`screens/v2-${delivery}-${width}-vesting.png`,fullPage:true});
        await w.chain.setNextTime(Number(g.start)+45*86400);
        const beforeClaimBalance = await page.getByTestId('beneficiary-balance').textContent();
        await page.getByTestId('primary-action').evaluate(el=>{el.click();el.click();});
        await until(async()=>(await w.v2.read.getGrant(1)).claimed===500000n*10n**18n,'midpoint claimed once');
        await until(async()=>await seen(page,'claimed')==='500,000 ALLOCATION','updated claimed amount');
        await until(async()=>await page.getByTestId('beneficiary-balance').textContent() !== beforeClaimBalance,'updated beneficiary balance');
        await until(async()=>await page.getByTestId('transaction-receipt').count()===2,'settlement and claim receipts');
        await page.reload(); await until(async()=>await seen(page,'claimed')==='500,000 ALLOCATION','reload grant');
        await until(async()=>(await page.getByTestId('transaction-receipt').nth(1).textContent().catch(()=>'')).includes('Claim of 500,000 ALLOCATION'),'claim receipt after reload');
        await w.chain.setNextTime(Number(g.end)); await w.chain.mine(); await page.reload();
        await until(async()=>await seen(page,'claimable')==='500,000 ALLOCATION','final amount');
        await page.getByTestId('primary-action').click();
        await until(async()=>(await w.v2.read.getGrant(1)).claimed===g.allocation,'final claim');
        await until(async()=>await seen(page,'locked')==='0 ALLOCATION','fully unlocked');
      } else assert.equal((await w.v2.read.getDeal(id)).grantId,0n);
      await noOverflow(page);
    });
  } finally {await site.close();}
});

test('V2 receipts survive reload; seller, buyer / beneficiary and visitor each see their role',async()=>{
  const w=await v2World(),id=await w.offerV2({delivery:1,durationSeconds:86400n}),site=await serve(w);
  const role=async(page,text)=>until(async()=>(await seen(page,'your-role'))?.includes(text),text);
  try {
    await withPage(site,`#/v2/d/${id}`,null,async page=>{await configure(page,site,w); await role(page,'Viewing without a wallet');});
    await withPage(site,`#/v2/d/${id}`,wallet(w,w.maker),async page=>{
      await configure(page,site,w); await page.getByTestId('primary-action').click(); await role(page,'You are the seller');
      assert.equal(await page.getByTestId('cancel-action').count(),1);
    });
    await withPage(site,`#/v2/d/${id}`,wallet(w,w.taker),async page=>{
      await configure(page,site,w);
      await pressUntil(page,async()=>(await w.v2.read.getDeal(id)).status===2n,'settled from the page');
      await role(page,'You are the designated buyer / beneficiary');
      await page.reload(); await status(page,'settled');
      await until(async()=>(await seen(page,'transaction-receipt'))?.startsWith('Settlement'),'settlement receipt after reload');
    });
    const g=await w.v2.read.getGrant(1); await w.chain.setNextTime(Number(g.end)); await w.chain.mine();
    await withPage(site,`#/v2/d/${id}`,wallet(w,w.other),async page=>{
      await configure(page,site,w); await page.getByTestId('primary-action').click();
      await role(page,'You can trigger a claim, but tokens pay only the recorded beneficiary');
      assert.equal(await page.getByTestId('cancel-action').count(),0);
      await pressUntil(page,async()=>(await w.v2.read.getGrant(1)).claimed===g.allocation,'visitor-triggered claim');
      assert.equal(await w.base.read.balanceOf(w.taker),2n*10n**24n);
      await page.reload(); await status(page,'settled');
      await until(async()=>await page.getByTestId('transaction-receipt').count()===2,'both receipts after reload');
      assert.ok((await page.getByTestId('transaction-receipt').nth(1).textContent()).includes('Claim of 1,000,000 ALLOCATION'));
    });
  } finally {await site.close();}
});

test('V2 refuses existing position before any wallet request, even with otherwise valid terms',async()=>{
  const w=await v2World(),site=await serve(w); let walletCalls=0;
  const answer=wallet(w,w.maker);
  try {await withPage(site,'#/v2/new',request=>{if(!['eth_accounts','eth_chainId'].includes(request.method))walletCalls++;return answer(request);},async page=>{
    await configure(page,site,w);
    for(const [key,value] of Object.entries({'sell-token':w.base.address,'sell-amount':'1','buy-token':w.quote.address,'buy-amount':'1',taker:w.taker}))await page.getByTestId(key).fill(value);
    await page.getByTestId('existing-position').fill('https://example.test/sablier/123');
    await until(async()=>(await seen(page,'validation'))?.includes('unsupported'),'position refusal');
    assert.equal(await page.getByTestId('primary-action').isDisabled(),true);
    await page.getByTestId('existing-position').fill(''); await page.getByTestId('delivery').selectOption('external');
    assert.ok((await seen(page,'validation')).includes('unsupported')); assert.equal(walletCalls,0);
  });}finally{await site.close();}
});

test('V2 recovers after wrong chain, wallet rejection, mined revert and stale second tab',async()=>{
  const w=await v2World(),id=await w.offerV2(),site=await serve(w);
  const answer=wallet(w,w.taker); let chainId='0x1', rejected=false, failed=false;
  const wrapped=async request=>{
    if(request.method==='eth_chainId')return {result:chainId};
    if(request.method==='wallet_switchEthereumChain'){chainId='0x7a69';return {result:null};}
    if(request.method==='eth_sendTransaction'&&!rejected){rejected=true;return {error:{code:4001,message:'User rejected'}};}
    if(request.method==='eth_sendTransaction'&&request.params[0].data.startsWith('0x3fda5389')&&!failed){failed=true;return answer({...request,params:[{...request.params[0],gas:'0x7530'}]});}
    return answer(request);
  };
  try{await withPage(site,`#/v2/d/${id}`,wrapped,async page=>{
    await configure(page,site,w);
    await pressUntil(page,async()=>(await seen(page,'notice'))?.includes('declined'),'rejection recovered');
    assert.equal((await w.v2.read.getDeal(id)).status,1n);
    await pressUntil(page,async()=>(await seen(page,'notice'))?.includes('failed on the chain'),'mined revert recovered');
    assert.equal((await w.v2.read.getDeal(id)).status,1n);
    const stale=await page.context().newPage(); await stale.goto(`${site.url}/#/v2/d/${id}`); await configure(stale,site,w);
    await status(stale,'funded');
    await page.getByTestId('primary-action').evaluate(el=>{el.click();el.click();});
    await until(async()=>(await w.v2.read.getDeal(id)).status===2n,'one settlement');
    await status(page,'settled'); await status(stale,'settled'); await stale.close();
    await page.reload(); await status(page,'settled');
  });}finally{await site.close();}
});

test('V2 disables stale actions during RPC loss and recovers after the connection returns',async()=>{
  const w=await v2World(),id=await w.offerV2(),site=await serve(w);
  try{await withPage(site,`#/v2/d/${id}`,wallet(w,w.taker),async page=>{
    await configure(page,site,w);await status(page,'funded');
    let offline=true;
    await page.route('**/rpc',route=>offline?route.fulfill({json:{jsonrpc:'2.0',id:1,error:{code:-32000,message:'Connection interrupted. Try again.'}}}):route.continue());
    await until(async()=>(await seen(page,'notice'))?.includes('Could not refresh'),'RPC loss warning',8000);
    assert.equal(await seen(page,'primary-action'),'Refresh on-chain status');
    assert.equal((await w.v2.read.getDeal(id)).status,1n);
    offline=false;await page.getByTestId('primary-action').click();
    await until(async()=>await seen(page,'primary-action')==='Connect wallet','recovered read');
    assert.equal(await seen(page,'notice'),null);
  });}finally{await site.close();}
});
