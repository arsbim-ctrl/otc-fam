import { readFile } from "node:fs/promises";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import solc from "solc";

async function compile() {
  const name = "contracts/OtcDeals.sol";
  const sources = {};
  for (const file of [name, "contracts/IOtcDeals.sol"]) {
    sources[file] = { content: await readFile(new URL(`../${file}`, import.meta.url), "utf8") };
  }
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { [name]: { OtcDeals: ["abi", "evm.bytecode.object"] } },
    },
  })));
  const errors = (output.errors ?? []).filter(({ severity }) => severity === "error");
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join("\n"));
  const artifact = output.contracts[name].OtcDeals;
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
}

async function deploy() {
  const { RPC_URL, DEPLOYER_KEY } = process.env;
  if (!RPC_URL || !DEPLOYER_KEY) throw new Error("Set RPC_URL and DEPLOYER_KEY in the environment.");
  if (!/^https?:\/\//i.test(RPC_URL)) throw new Error("RPC_URL must be an HTTP(S) JSON-RPC endpoint.");
  if (!/^(?:0x)?[0-9a-f]{64}$/i.test(DEPLOYER_KEY)) throw new Error("DEPLOYER_KEY must be a 32-byte hex private key.");

  const { abi, bytecode } = await compile();
  const provider = new JsonRpcProvider(RPC_URL);
  try {
    const wallet = new Wallet(`0x${DEPLOYER_KEY.replace(/^0x/i, "")}`, provider);
    const deal = await new ContractFactory(abi, bytecode, wallet).deploy();
    await deal.waitForDeployment();
    console.log(await deal.getAddress());
  } catch (error) {
    const code = typeof error.code === "string" && /^[A-Z_]+$/.test(error.code) ? ` (${error.code})` : "";
    // RPC errors can contain request URLs or other configuration values.
    throw new Error(`Deployment failed${code}. Check the network and the deployer’s gas balance.`);
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
