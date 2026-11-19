import { readFileSync } from "node:fs";
import { ContractFactory, FetchRequest, JsonRpcProvider, Wallet } from "ethers";
import solc from "solc";

function compile() {
  const source = "contracts/OtcDeals.sol";
  const files = [source, "contracts/IOtcDeals.sol"];
  const sources = Object.fromEntries(files.map((file) => [
    file, { content: readFileSync(new URL(`../${file}`, import.meta.url), "utf8") },
  ]));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  })));
  const errors = (output.errors ?? []).filter(({ severity }) => severity === "error");
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join("\n"));
  return output.contracts[source].OtcDeals;
}

async function main() {
  const { RPC_URL, DEPLOYER_KEY } = process.env;
  if (!RPC_URL || !DEPLOYER_KEY) throw new Error("Set RPC_URL and DEPLOYER_KEY in the environment.");
  if (!/^(?:0x)?[\da-f]{64}$/i.test(DEPLOYER_KEY)) throw new Error("DEPLOYER_KEY must be a 32-byte hex key.");

  let request;
  try {
    const url = new URL(RPC_URL);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    request = new FetchRequest(url.href);
    request.timeout = 30_000;
  } catch {
    throw new Error("RPC_URL must be an HTTP or HTTPS URL.");
  }

  const { abi, evm } = compile();
  let provider;
  let transaction;
  try {
    const probe = request.clone();
    probe.body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    probe.setHeader("Content-Type", "application/json");
    const response = await probe.send();
    response.assertOk();
    const chainId = BigInt(response.bodyJson.result);
    if (chainId <= 0n) throw new Error("Invalid chain ID.");
    provider = new JsonRpcProvider(request, chainId, { batchMaxCount: 1, staticNetwork: true });
    const signer = new Wallet(DEPLOYER_KEY, provider);
    const factory = new ContractFactory(abi, `0x${evm.bytecode.object}`, signer);
    const contract = await factory.deploy();
    transaction = contract.deploymentTransaction();
    const receipt = await transaction.wait(1, 180_000);
    if (!receipt?.contractAddress) throw new Error("No contract address in the deployment receipt.");
    console.log(receipt.contractAddress);
  } catch (error) {
    const code = typeof error.code === "string" ? ` (${error.code})` : "";
    const submitted = transaction ? ` Check transaction ${transaction.hash} before retrying.` : "";
    throw new Error(`Deployment failed${code}.${submitted}`);
  } finally {
    provider?.destroy();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
