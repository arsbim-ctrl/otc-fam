import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Chain} from '../web/eth.js';

test('receipt follows a mined acceleration and explains a replacement cancellation',async()=>{
  for(const cancelled of [false,true]) {
    const chain=new Chain('unused','0x0');
    const sent={from:'0x11',to:'0x22',input:'0xaabb',nonce:'0x3'};
    const replacement={...sent,hash:'0xnew',...(cancelled?{to:sent.from,input:'0x'}:{})};
    const receipt={transactionHash:'0xnew',status:'0x1'};
    chain.rpc=async(method,params)=>{
      if(method==='eth_getTransactionByHash')return sent;
      if(method==='eth_getTransactionReceipt')return params[0]==='0xnew'?receipt:null;
      if(method==='eth_getTransactionCount')return '0x4';
      if(method==='eth_blockNumber')return '0x10';
      if(method==='eth_getBlockByNumber')return {transactions:[replacement]};
      throw new Error(method);
    };
    if(cancelled)await assert.rejects(chain.receipt('0xold'),/replaced or cancelled.*Refresh/);
    else assert.deepEqual(await chain.receipt('0xold'),receipt);
  }
});

test('V2 history finds the deployment block, reads logs in windows and shrinks a refused range',async()=>{
  const {ChainV2}=await import('../web/eth-v2.js');
  const chain=new ChainV2('unused','0xc0'), ranges=[];
  const FUNDED='0x9294fa05cf234497458b8dc9e3cd8aaffbbc119a49d43f18739c7ebefc5ab81f', deal=`0x${'0'.repeat(63)}7`;
  chain.rpc=async(method,params)=>{
    if(method==='eth_blockNumber')return '0x2710'; // 10000
    if(method==='eth_getCode')return BigInt(params[1])>=5000n?'0x60':'0x';
    if(method==='eth_getTransactionReceipt')return {transactionHash:params[0],status:'0x1'};
    if(method==='eth_getLogs'){
      const from=BigInt(params[0].fromBlock),to=BigInt(params[0].toBlock);
      if(to-from>=1000n)throw Object.assign(new Error('block range is too large'),{code:-32000});
      ranges.push([from,to]);
      return from<=6000n&&6000n<=to?[{topics:[FUNDED,deal],blockNumber:'0x1770',logIndex:'0x0',transactionHash:'0xf',data:'0x'}]:[];
    }
    throw new Error(method);
  };
  const history=await chain.history({id:7n,grantId:0n});
  assert.equal(chain.fromBlock,5000n);
  assert.deepEqual(ranges[0],[5000n,5999n]); assert.deepEqual(ranges.at(-1),[10000n,10000n]);
  assert.ok(ranges.every(([from,to])=>from>=5000n&&to-from<1000n));
  assert.deepEqual(history.map(h=>h.kind),['Funding and escrow']);
});
