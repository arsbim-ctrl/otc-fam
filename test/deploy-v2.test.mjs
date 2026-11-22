import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Interface, Wallet } from 'ethers';
import { startChain } from '../.launchpad/checks/round-1/chain.mjs';
import { v2Artifact } from './support/v2-world.mjs';
const run = promisify(execFile);

test('V2 deployment binds treasury and never prints environment secrets, including provider failures', async () => {
  const deployer = Wallet.createRandom(), treasury = '0x'+'12'.repeat(20);
  const chain = await startChain([deployer.address]);
  const server = createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);
    const answer=async r=>{
      try{return {jsonrpc:'2.0',id:r.id,result:await chain.rpc(r.method,r.params)};}
      catch(e){return {jsonrpc:'2.0',id:r.id,error:{code:e.code??-32000,message:e.message,data:e.data}};}
    };
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(Array.isArray(request)?await Promise.all(request.map(answer)):await answer(request)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const env={PATH:process.env.PATH,RPC_URL:`http://127.0.0.1:${server.address().port}/private-rpc-credential`,DEPLOYER_KEY:deployer.privateKey,TREASURY:treasury};
    const {stdout,stderr}=await run(process.execPath,['scripts/deploy-v2.mjs'],{env});
    // Keep assertion diagnostics free of secret values, even on failure.
    assert.ok(/^0x[0-9a-fA-F]{40}\s*$/.test(stdout),'stdout contains one deployed address');
    assert.ok(!`${stdout}${stderr}`.includes(deployer.privateKey.slice(2)),'key not printed');
    assert.ok(!`${stdout}${stderr}`.includes(env.RPC_URL),'RPC URL not printed');
    const abi=new Interface(v2Artifact.abi);
    const reply=await chain.rpc('eth_call',[{to:stdout.trim(),data:abi.encodeFunctionData('treasury')},'latest']);
    assert.equal(abi.decodeFunctionResult('treasury',reply)[0].toLowerCase(),treasury);
    for(const patch of [{RPC_URL:''},{TREASURY:'0x'+'0'.repeat(40)},{DEPLOYER_KEY:'invalid-sensitive-input'},{RPC_URL:'http://127.0.0.1:1/private-credential'}]){
      const error=await run(process.execPath,['scripts/deploy-v2.mjs'],{env:{...env,...patch}}).then(()=>null,e=>e);
      assert.ok(error && error.code!==0,'bad setup exits nonzero');assert.equal(error.stdout,'');
      assert.ok(!error.stderr.includes('private-credential')&&!error.stderr.includes('invalid-sensitive-input')&&!error.stderr.includes(deployer.privateKey.slice(2)),'failure output contains no secret');
    }
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
