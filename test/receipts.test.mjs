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
