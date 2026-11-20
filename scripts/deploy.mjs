import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { compile } from './compile.mjs';

let provider;
const deadline = setTimeout(() => {
  console.error('Deployment timed out. A transaction may have been submitted; inspect the deployer’s activity before retrying.');
  provider?.destroy();
  process.exit(1);
}, 180_000);
try {
  const { RPC_URL, DEPLOYER_KEY } = process.env;
  if (!RPC_URL || !DEPLOYER_KEY) throw new Error('environment');
  const url = new URL(RPC_URL);
  if (!['http:', 'https:'].includes(url.protocol) || !/^0x[0-9a-fA-F]{64}$/.test(DEPLOYER_KEY)) throw new Error('environment');
  const artifact = compile();
  provider = new JsonRpcProvider(RPC_URL);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, new Wallet(DEPLOYER_KEY, provider));
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction().wait(1, 120_000);
  if (!receipt || receipt.status !== 1) throw new Error('deployment');
  const address = await contract.getAddress();
  if (await provider.getCode(address) === '0x') throw new Error('deployment');
  console.log(address);
} catch {
  // Provider errors can contain keys, signed transactions or credential-bearing URLs.
  console.error('Deployment failed. Check RPC_URL, DEPLOYER_KEY, network availability and gas funds. No configuration was saved.');
  process.exitCode = 1;
} finally { clearTimeout(deadline); provider?.destroy(); }
