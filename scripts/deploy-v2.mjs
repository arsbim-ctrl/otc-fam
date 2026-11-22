// Environment-only deployment. Never include provider or wallet errors in output:
// their messages may contain the authenticated RPC URL or signed transaction.
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { ContractFactory, JsonRpcProvider, Wallet, isAddress, ZeroAddress } from 'ethers';
const fail = text => { console.error(text); process.exitCode = 1; };
const { RPC_URL, DEPLOYER_KEY, TREASURY } = process.env;
if (!RPC_URL || !DEPLOYER_KEY || !TREASURY) fail('Set RPC_URL, DEPLOYER_KEY and TREASURY in the environment.');
else if (!/^(0x)?[0-9a-fA-F]{64}$/.test(DEPLOYER_KEY)) fail('DEPLOYER_KEY must be 64 hex digits, optionally prefixed with 0x.');
else if (!isAddress(TREASURY) || TREASURY === ZeroAddress) fail('TREASURY must be a nonzero Ethereum address.');
else {
  let provider;
  try {
    const file = 'contracts/OtcDealsV2.sol';
    const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [file]: { content: readFileSync(file, 'utf8') } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }), { import: path => ({ contents: readFileSync(path, 'utf8') }) }));
    if (output.errors?.some(e => e.severity === 'error')) throw new Error('Compilation failed');
    const artifact = output.contracts[file].OtcDealsV2;
    // Probe using fetch first: a failed ethers network auto-detection can log URLs.
    const reply = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(15000) });
    const { result } = await reply.json();
    const network = BigInt(result);
    provider = new JsonRpcProvider(RPC_URL, network, { staticNetwork: true });
    const signer = new Wallet(DEPLOYER_KEY, provider);
    const contract = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer).deploy(TREASURY);
    await contract.waitForDeployment();
    console.log(await contract.getAddress());
  } catch {
    fail('V2 deployment failed. Check the environment values, network access, Cancun support and deployer gas balance.');
  } finally { provider?.destroy(); }
}
