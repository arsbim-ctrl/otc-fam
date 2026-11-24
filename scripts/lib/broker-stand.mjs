import { Wallet } from "ethers";
import { deploy } from "../../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../../.launchpad/checks/round-1/lib/entry.mjs";
import { wallet as localWallet } from "../../.launchpad/checks/round-1/page.mjs";

// Public, deterministic keys for the in-process test chain only.
const signers = Object.fromEntries(["Seller", "Buyer", "Broker", "Stranger"].map((role, i) =>
  [role, new Wallet(`0x${String(i + 1).padStart(64, "0")}`)]));
export const brokerPeople = Object.fromEntries(Object.entries(signers).map(([role, signer]) => [role, signer.address.toLowerCase()]));

let artifact;
export async function deployBrokerStand(w) {
  artifact ??= compile(ROOT, "contracts/BrokerDeals.sol").BrokerDeals;
  for (const who of Object.values(brokerPeople)) await w.chain.fund(who);
  return deploy(w.chain, w.deployer, artifact, [w.treasury], { label: "BrokerDeals" });
}

export function brokerWallet(w, role) {
  const signer = signers[role];
  const account = brokerPeople[role];
  const answer = localWallet(w, account);
  return async (request) => {
    if (request.method !== "eth_signTypedData_v4") return answer(request);
    try {
      const [from, payload] = request.params;
      if ((await answer({ method: "eth_accounts" })).result[0] !== account || from.toLowerCase() !== account) {
        return { error: { code: 4100, message: "Connect the selected local wallet first." } };
      }
      const { domain, types: { BrokerTerms }, message } = JSON.parse(payload);
      return { result: await signer.signTypedData(domain, { BrokerTerms }, message) };
    } catch (error) {
      return { error: { code: -32602, message: error.message } };
    }
  };
}
