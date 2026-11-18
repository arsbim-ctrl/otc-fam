// npm run deploy: deploys contracts/OtcDeals.sol to the network at RPC_URL with the key in DEPLOYER_KEY,
// and prints the contract's address. Both come from the environment and are never written to a file.
// The contract is compiled exactly as the checks compile it (solc 0.8.38, optimizer 200 runs, cancun).
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { compileEntry } from "../.launchpad/checks/round-1/compile.mjs";

for (const name of ["RPC_URL", "DEPLOYER_KEY"]) {
  if (!process.env[name]) {
    console.error(`${name} is not set: RPC_URL=<the network's JSON-RPC URL> DEPLOYER_KEY=<the deployer's private key> npm run deploy`);
    process.exit(1);
  }
}
const { abi, bytecode } = compileEntry();
const deployer = new Wallet(process.env.DEPLOYER_KEY, new JsonRpcProvider(process.env.RPC_URL));
const contract = await new ContractFactory(abi, bytecode, deployer).deploy();
await contract.waitForDeployment();
console.log(await contract.getAddress());
