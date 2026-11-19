import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Wallet, Interface } from 'ethers';
import { startChain } from '../.launchpad/checks/round-1/chain.mjs';
import { compile } from '../scripts/compile.mjs';

// Generated only in memory, funded only on this ephemeral local chain. Never an agent key.
const wallet = Wallet.createRandom();
const chain = await startChain([wallet.address]);
let rejectWrites = false;
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const part of req) body += part;
    const answer = async q => {
      try {
        if (rejectWrites && q.method === 'eth_sendRawTransaction') throw new Error('simulated network failure');
        return { jsonrpc: '2.0', id: q.id, result: await chain.rpc(q.method, q.params) };
      } catch { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'Local test RPC refused the request' } }; }
    };
    const data = JSON.parse(body), response = Array.isArray(data) ? await Promise.all(data.map(answer)) : await answer(data);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const rpc = `http://127.0.0.1:${server.address().port}`;
const run = env => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/deploy.mjs'], { env: { PATH: process.env.PATH, HOME: '/tmp', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Deployment test timed out')); }, 45_000);
  child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
});
let count = 0;
try {
  const deployed = await run({ RPC_URL: rpc, DEPLOYER_KEY: wallet.privateKey });
  assert.equal(deployed.code, 0, deployed.err); assert.match(deployed.out.trim(), /^0x[0-9a-fA-F]{40}$/);
  const address = deployed.out.trim(); assert.notEqual(await chain.rpc('eth_getCode', [address, 'latest']), '0x');
  const iface = new Interface(compile().abi);
  const result = await chain.rpc('eth_call', [{ to: address, data: iface.encodeFunctionData('getDeal', [999]) }, 'latest']);
  assert.equal(iface.decodeFunctionResult('getDeal', result)[0].status, 0n);
  assert(!deployed.out.includes(wallet.privateKey) && !deployed.err.includes(wallet.privateKey));
  console.log(`PASS ${++count}: deploys constructor-free implementation and reads its fixed ABI`);
  for (const [name, env] of [
    ['missing environment', {}],
    ['malformed private key', { RPC_URL: rpc, DEPLOYER_KEY: 'secret-malformed-key' }],
    ['malformed RPC URL', { RPC_URL: 'secret-malformed-url', DEPLOYER_KEY: wallet.privateKey }],
    ['unfunded ephemeral wallet', { RPC_URL: rpc, DEPLOYER_KEY: Wallet.createRandom().privateKey }],
  ]) {
    const r = await run(env); assert.equal(r.code, 1); assert.equal(r.out, ''); assert.match(r.err, /Deployment failed/);
    for (const v of Object.values(env)) assert(!r.err.includes(v), `leaked environment in ${name}`);
    console.log(`PASS ${++count}: ${name} fails without leaking environment values`);
  }
  rejectWrites = true;
  const refused = await run({ RPC_URL: rpc, DEPLOYER_KEY: wallet.privateKey });
  assert.equal(refused.code, 1); assert.equal(refused.out, ''); assert(!refused.err.includes(wallet.privateKey));
  console.log(`PASS ${++count}: failed RPC submission does not report an address`);
  console.log(`${count} deployment tests passed.`);
} finally { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
