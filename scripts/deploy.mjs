import { readFileSync } from "node:fs";
import { ContractFactory, FetchRequest, JsonRpcProvider, Wallet } from "ethers";
import solc from "solc";

const entry = "contracts/OtcDeals.sol";
const sourceFiles = [entry, "contracts/IOtcDeals.sol"];

function compileDeal() {
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(sourceFiles.map((file) => [file, {
      content: readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
    }])),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { [entry]: { OtcDeals: ["abi", "evm.bytecode.object"] } },
    },
  };

  const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (compiled.errors ?? []).filter((error) => error.severity === "error");
  if (errors.length) throw new Error(errors.map((error) => error.formattedMessage.trim()).join("\n"));

  const contract = compiled.contracts?.[entry]?.OtcDeals;
  const bytecode = contract?.evm?.bytecode?.object;
  if (!bytecode) throw new Error("OtcDeals has no deployable bytecode.");
  return { abi: contract.abi, bytecode: `0x${bytecode}` };
}

async function deploy() {
  const { RPC_URL, DEPLOYER_KEY } = process.env;
  let endpoint;
  try {
    endpoint = new URL(RPC_URL);
  } catch {
    throw new Error("Set RPC_URL to the network's HTTP or HTTPS JSON-RPC endpoint.");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("RPC_URL must use HTTP or HTTPS.");
  }

  let wallet;
  try {
    if (!/^(?:0x)?[0-9a-f]{64}$/i.test(DEPLOYER_KEY ?? "")) throw new Error();
    wallet = new Wallet(DEPLOYER_KEY.replace(/^0x/i, "0x"));
  } catch {
    throw new Error("Set DEPLOYER_KEY to a valid 32-byte hex private key.");
  }

  const { abi, bytecode } = compileDeal();
  const request = new FetchRequest(endpoint.href);
  request.timeout = 30_000;
  const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
  let transaction;

  try {
    const contract = await new ContractFactory(abi, bytecode, wallet.connect(provider)).deploy();
    transaction = contract.deploymentTransaction();
    const receipt = await transaction.wait(1, 180_000);
    if (receipt?.status !== 1 || receipt.contractAddress !== await contract.getAddress()) {
      throw new Error("Deployment was not confirmed.");
    }
    console.log(receipt.contractAddress);
  } catch (error) {
    // Provider errors can include the RPC credentials or raw transaction data.
    const reason = {
      INSUFFICIENT_FUNDS: "The deployer does not have enough native currency to pay for deployment.",
      TIMEOUT: "The deployment did not confirm before the timeout.",
      TRANSACTION_REPLACED: "The deployment transaction was replaced.",
      NETWORK_ERROR: "Could not connect to the deployment network.",
      CALL_EXCEPTION: "The deployment was rejected by the network.",
    }[error.code] ?? "Deployment failed. Check the RPC endpoint, network and deployer balance.";
    throw new Error(transaction ? `${reason} Check transaction ${transaction.hash} before retrying.` : reason);
  } finally {
    provider.destroy();
  }
}

try {
  await deploy();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
