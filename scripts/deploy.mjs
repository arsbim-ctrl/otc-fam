// npm run deploy: compiles contracts/OtcDeals.sol as the checks do (solc 0.8.38, optimizer on with 200 runs, EVM
// cancun), deploys it to the network at RPC_URL from the key in DEPLOYER_KEY, and prints the contract's address
// on stdout (progress goes to stderr). Both values come from the environment only: nothing is written to a file,
// and neither is ever printed (an RPC URL can hold an API key).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

const solc = createRequire(import.meta.url)("solc");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const rpcUrl = process.env.RPC_URL?.trim(), key = process.env.DEPLOYER_KEY?.trim();
if (!rpcUrl || !key) fail("Usage: RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> npm run deploy");
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) fail("DEPLOYER_KEY is not a private key: it must be 64 hex digits, with or without 0x.");

const { abi, bytecode } = compile("contracts/OtcDeals.sol", "OtcDeals");
const chainId = await chainIdAt(rpcUrl);
const deployer = new Wallet(key, new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true }));
console.error(`Deploying OtcDeals to chain ${chainId} from ${deployer.address}…`);
try {
  const contract = await new ContractFactory(abi, bytecode, deployer).deploy();
  const receipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  console.error(`Deployed in block ${receipt.blockNumber} by transaction ${receipt.hash}.`);
  console.error(`In web/config.json: { "chainId": ${chainId}, "contract": "${address}", "rpcUrl": "<a public JSON-RPC URL of chain ${chainId}>" }`);
  console.log(address);
} catch (e) {
  fail(e.code === "INSUFFICIENT_FUNDS" ? `${deployer.address} has too little ether on chain ${chainId} to pay for the deployment.` : `The deployment failed: ${e.shortMessage ?? e.message}`);
}

/** The chain id the node at `url` answers, or the reason it cannot be reached (without the URL itself). */
async function chainIdAt(url) {
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(15_000) });
    const { result, error } = await response.json();
    if (!result) throw new Error(error?.message ?? `HTTP ${response.status}`);
    return Number(BigInt(result));
  } catch (e) {
    return fail(`The node at RPC_URL did not answer eth_chainId (${e.name === "TimeoutError" ? "no answer in 15 s" : e.message}).`);
  }
}

/** `name` in `file`, compiled with the checks' settings; imports are read from the repository (./IOtcDeals.sol). */
function compile(file, name) {
  const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { [file]: { [name]: ["abi", "evm.bytecode.object"] } } };
  const input = { language: "Solidity", sources: { [file]: { content: readFileSync(file, "utf8") } }, settings };
  const read = (path) => {
    try {
      return { contents: readFileSync(path, "utf8") };
    } catch {
      return { error: `${path} not found` };
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: read }));
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) fail(errors.map((e) => e.formattedMessage).join("\n"));
  const { abi, evm } = output.contracts[file][name];
  return { abi, bytecode: `0x${evm.bytecode.object}` };
}
