// npm run deploy: compiles contracts/OtcDeals.sol as the checks do (solc 0.8.38, optimizer on with 200 runs, EVM
// cancun), deploys it to the network at RPC_URL from the key in DEPLOYER_KEY, and prints the contract's address
// on stdout (progress goes to stderr). npm run deploy:v2 does the same for contracts/OtcDealsV2.sol, whose
// treasury is the address in TREASURY. deploy:broker also records the broker deployment in web/config.json,
// and neither RPC_URL nor the key is ever printed (an RPC URL can hold an API key).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ContractFactory, FetchRequest, JsonRpcProvider, Wallet } from "ethers";

const solc = createRequire(import.meta.url)("solc");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const version = process.argv[2], v2 = version === "v2", broker = version === "broker";
const takesFees = v2 || broker, name = broker ? "BrokerDeals" : v2 ? "OtcDealsV2" : "OtcDeals";
const rpcUrl = process.env.RPC_URL?.trim(), key = process.env.DEPLOYER_KEY?.trim(), treasury = process.env.TREASURY?.trim();
if (!rpcUrl || !key || (takesFees && !treasury)) {
  fail(`Usage: RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> ${takesFees ? `TREASURY=<the address that receives the fees> npm run deploy:${version}` : "npm run deploy"}`);
}
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) fail("DEPLOYER_KEY is not a private key: it must be 64 hex digits, with or without 0x.");
if (takesFees && (!/^0x[0-9a-fA-F]{40}$/.test(treasury) || /^0x0{40}$/.test(treasury))) {
  fail("TREASURY is not an address that can receive the fees: it must be 0x and 40 hex digits, and not the zero address. It can never be changed afterwards.");
}

const { abi, bytecode } = compile(`contracts/${name}.sol`, name);
const chainId = await chainIdAt(rpcUrl);
const configPath = "web/config.json";
let config;
if (broker) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    fail("Read web/config.json before deploying BrokerDeals. Restore a valid site configuration and try again.");
  }
  if (config.chainId !== chainId) {
    fail(`web/config.json names chain ${config.chainId}, but RPC_URL answers from chain ${chainId}. Configure the site's chain before deploying.`);
  }
}
const endpoint = new FetchRequest(rpcUrl);
const getUrl = endpoint.getUrlFunc;
endpoint.getUrlFunc = async (request, signal) => {
  const response = await getUrl(request, signal);
  if (response.statusCode >= 300 && response.statusCode < 400) throw new Error("RPC_URL redirected");
  return response;
};
const deployer = new Wallet(key, new JsonRpcProvider(endpoint, chainId, { staticNetwork: true }));
console.error(`Deploying ${name} to chain ${chainId} from ${deployer.address}${takesFees ? `, with treasury ${treasury}` : ""}…`);
try {
  const contract = await new ContractFactory(abi, bytecode, deployer).deploy(...(takesFees ? [treasury] : []));
  const receipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  console.error(`Deployed in block ${receipt.blockNumber} by transaction ${receipt.hash}.`);
  if (broker) {
    try {
      const latest = JSON.parse(readFileSync(configPath, "utf8"));
      if (latest.chainId !== chainId) throw new Error("The site's chain changed during deployment");
      const next = { ...latest, contractBroker: address, fromBlockBroker: receipt.blockNumber, treasuryBroker: treasury };
      const temp = `${configPath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
      renameSync(temp, configPath);
      console.error(`Wrote the broker contract, deployment block and treasury to ${configPath}.`);
    } catch {
      fail(`BrokerDeals deployed at ${address}. Set contractBroker, fromBlockBroker (${receipt.blockNumber}) and treasuryBroker (${treasury}) in ${configPath}.`);
    }
  } else console.error(v2 ? `In web/config.json, next to the others: "contractV2": "${address}", "fromBlockV2": ${receipt.blockNumber}`
    : `In web/config.json: { "chainId": ${chainId}, "contract": "${address}", "rpcUrl": "<a public JSON-RPC URL of chain ${chainId}>" }`);
  console.log(address);
} catch (e) {
  fail(e.code === "INSUFFICIENT_FUNDS" ? `${deployer.address} has too little ether on chain ${chainId} to pay for the deployment.` : "The deployment failed. Check RPC_URL, the network and the deployer’s access, then try again.");
}

/** The chain id the node at `url` answers, or the reason it cannot be reached (without the URL itself). */
async function chainIdAt(url) {
  try {
    const response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(15_000) });
    const { result } = await response.json();
    const id = Number(result);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("invalid chain id");
    return id;
  } catch (e) {
    return fail(`The node at RPC_URL did not answer eth_chainId (${e.name === "TimeoutError" ? "no answer in 15 s" : "check the URL and the node"}).`);
  }
}

/** `contract` in `file`, compiled with the checks' settings; imports are read from the repository (./IOtcDeals.sol). */
function compile(file, contract) {
  const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { [file]: { [contract]: ["abi", "evm.bytecode.object"] } } };
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
  const { abi: compiledAbi, evm } = output.contracts[file][contract];
  return { abi: compiledAbi, bytecode: `0x${evm.bytecode.object}` };
}
