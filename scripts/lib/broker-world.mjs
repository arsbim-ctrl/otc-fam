// Throwaway wallets and a local chain for the v3 dev server and evidence scripts.
import { Wallet } from "ethers";
import { CHAIN_ID, deploy } from "../../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../../.launchpad/checks/round-1/lib/entry.mjs";
import { wallet } from "../../.launchpad/checks/round-1/page.mjs";
import { PEOPLE, world } from "./world.mjs";

const signer = (n) => new Wallet("0x" + n.toString(16).padStart(64, "0"));
export const signers = { seller: signer(1), buyer: signer(2), broker: signer(3), other: signer(4) };
const actors = Object.fromEntries(Object.entries(signers).map(([name, key]) => [name, key.address.toLowerCase()]));
let artifact;

export async function brokerWorld() {
  const w = await world({ people: { ...PEOPLE, ...actors } });
  artifact ??= compile(ROOT, "contracts/BrokerDeals.sol").BrokerDeals;
  w.brokerDeals = await deploy(w.chain, w.deployer, artifact, [w.treasury], { label: "BrokerDeals" });
  w.configV3 = { chainId: CHAIN_ID, contractV3: w.brokerDeals.address, fromBlockV3: Number(await w.chain.rpc("eth_blockNumber")) };
  await w.fam.as(w.deployer).mint(w.seller, 10_000_000n * 10n ** 18n);
  for (const account of [w.buyer, w.other]) await w.usdc.as(w.deployer).mint(account, 1_000_000n * 10n ** 6n);
  return w;
}

export function testWallet(w, role, options = {}) {
  const account = w[role];
  const answer = wallet(w, account);
  let chainId = options.chainId ?? CHAIN_ID;
  let connected = false;
  return async (request) => {
    options.asked?.push(request.method);
    const intercepted = await options.intercept?.(request);
    if (intercepted) return intercepted;
    if (request.method === "eth_chainId") return { result: "0x" + chainId.toString(16) };
    if (request.method === "wallet_switchEthereumChain" && Number(request.params?.[0]?.chainId) === CHAIN_ID) {
      chainId = CHAIN_ID;
      return { result: null };
    }
    if (request.method === "eth_requestAccounts") connected = true;
    if (request.method === "eth_signTypedData_v4") {
      const [address, payload] = request.params ?? [];
      if (!connected || chainId !== CHAIN_ID || address?.toLowerCase() !== account) return { error: { code: 4100, message: "Wrong signing wallet or chain" } };
      const { domain, types, message } = JSON.parse(payload);
      const { EIP712Domain, ...terms } = types;
      return { result: await signers[role].signTypedData(domain, terms, message) };
    }
    return answer(request);
  };
}
