import { Wallet } from "ethers";
import { CHAIN_ID, deploy } from "../../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../../.launchpad/checks/round-1/lib/entry.mjs";
import { wallet } from "../../.launchpad/checks/round-1/page.mjs";
import { world } from "./world.mjs";

let artifact;
const names = ["Broker", "Seller", "Buyer", "Stranger"];
// Public deterministic keys for the disposable local chain, never for a public network.
export const signers = Object.fromEntries(names.map((name, index) => [name, new Wallet(`0x${String(index + 11).padStart(64, "0")}`)]));
export const demoPeople = Object.fromEntries(names.map(name => [name, signers[name].address.toLowerCase()]));

export async function brokerWorld() {
  const w = await world();
  artifact ??= compile(ROOT, "contracts/BrokerDeals.sol").BrokerDeals;
  w.brokerDeals = await deploy(w.chain, w.deployer, artifact, [w.treasury], { label: "BrokerDeals" });
  w.brokerConfig = { contractV3: w.brokerDeals.address, fromBlockV3: Number(await w.chain.rpc("eth_blockNumber")) };
  for (const account of Object.values(demoPeople)) await w.chain.fund(account);
  await w.fam.as(w.deployer).mint(demoPeople.Seller, 10_000_000n * 10n ** 18n);
  for (const account of [demoPeople.Buyer, demoPeople.Stranger]) {
    await w.usdc.as(w.deployer).mint(account, 1_000_000n * 10n ** 6n);
  }
  return w;
}

export function demoWallet(w, name) {
  const signer = signers[name], address = demoPeople[name], standard = wallet(w, address);
  return async (request) => {
    if (request.method !== "eth_signTypedData_v4") return standard(request);
    try {
      const [from, json] = request.params;
      const { domain, types: { BrokerTerms }, primaryType, message } = JSON.parse(json);
      const { result: authorized } = await standard({ method: "eth_accounts" });
      if (!authorized.includes(address) || from.toLowerCase() !== address || primaryType !== "BrokerTerms"
          || Number(domain.chainId) !== CHAIN_ID || domain.verifyingContract.toLowerCase() !== w.brokerDeals.address.toLowerCase()) {
        return { error: { code: 4100, message: "This fixture wallet signs broker terms only for its local deployment and connected address." } };
      }
      return { result: await signer.signTypedData(domain, { BrokerTerms }, message) };
    } catch (error) {
      return { error: { code: -32602, message: error.message } };
    }
  };
}
