import { AppError, address, Chain, encode, same, uint, words } from "./eth.js";

export const SELECTORS = {
  createDeal: "0x54695758", fill: "0x3fda5389", cancel: "0x40e58ee5", claim: "0x379607f5",
  getDeal: "0x82fd5bac", getGrant: "0xb8cc6c93", vested: "0x968fb8ba", claimable: "0xd1d58b25", treasury: "0x61d027b3",
};
export const EVENTS = {
  DealFunded: "0x9294fa05cf234497458b8dc9e3cd8aaffbbc119a49d43f18739c7ebefc5ab81f",
  DealSettled: "0xcc81a8771776afbb9e09d2740010d6c455c87cf93b32b0d7464effae6511af64",
  DealCancelled: "0x31b0c01e8429f81903c3f8adc204767b8efa7cfca91a00f3b4bb40ce63c8a206",
  GrantCreated: "0x55ce46f2fdb7a9f0f6cc90970ee0b6b9c91a80586e15ea8c6fa8cfba9d7fe359",
  GrantClaimed: "0x617847aec64ffd2e4a19d71c3e0062f744212a6f13486fec81d004b3a5c8fb2e",
};
const EVENT_NAMES = Object.fromEntries(Object.entries(EVENTS).map(([name, topic]) => [topic, name]));

export const TEST_NETWORKS = new Set([31337, 1337, 84532, 11155111]);

export const IMMEDIATE = 0;
export const NEW_VESTING = 1;
export const UINT256_MAX = (1n << 256n) - 1n;
export const quantity = (value) => `0x${BigInt(value).toString(16)}`;
const indexed = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

export function fees(quote) {
  const each = quote / 200n;
  return { quote, each, buyerTotal: quote + each, sellerNet: quote - each, pool: 2n * each };
}

export function createData(t) {
  return encode(SELECTORS.createDeal, t.baseToken, t.quoteToken, t.buyer, t.allocation, t.quote, t.expiry,
    t.delivery, t.fixedStart, t.cliffSeconds, t.durationSeconds);
}

export const dealAction = (name, id) => encode(SELECTORS[name], id);

export function receiptEvents(receipt, contract) {
  return receipt.logs
    .filter((log) => same(log.address, contract) && EVENT_NAMES[log.topics[0]])
    .map(activityFromLog);
}

function activityFromLog(log) {
  const peers = words(log.data);
  const name = EVENT_NAMES[log.topics[0]];
  return {
    name, id: BigInt(log.topics[1]), hash: log.transactionHash, block: BigInt(log.blockNumber), index: BigInt(log.logIndex),
    ...(name === "GrantClaimed" && { amount: uint(peers[0]) }),
  };
}

export class VestingChain extends Chain {
  constructor(config, rpcUrl) {
    super(rpcUrl, config.v2Contract);
    this.chainId = config.chainId;
    this.deploymentBlock = BigInt(config.v2DeploymentBlock ?? 0);
  }

  async verifyNetwork() {
    if (Number(await this.rpc("eth_chainId", [])) !== this.chainId) {
      throw new AppError("The website’s read-only RPC points to the wrong network.");
    }
  }

  async block() {
    await this.verifyNetwork();
    const block = await this.rpc("eth_getBlockByNumber", ["latest", false]);
    return { number: block.number, time: BigInt(block.timestamp) };
  }

  async read(name, length, args, block) {
    const decoded = words(await this.call(this.contract, encode(SELECTORS[name], ...args), undefined, block));
    if (decoded.length !== length) {
      throw new AppError("The configured OTC V2 contract did not return the expected data.");
    }
    return decoded;
  }

  async terms(id, block) {
    const w = await this.read("getDeal", 13, [id], block);
    return {
      id, seller: address(w[0]), baseToken: address(w[1]), quoteToken: address(w[2]), buyer: address(w[3]),
      allocation: uint(w[4]), quote: uint(w[5]), expiry: uint(w[6]), delivery: Number(uint(w[7])),
      fixedStart: uint(w[8]), cliffSeconds: uint(w[9]), durationSeconds: uint(w[10]),
      status: ["none", "funded", "settled", "cancelled"][Number(uint(w[11]))], grantId: uint(w[12]),
    };
  }

  async grant(id, block) {
    const [g, [vested], [claimable]] = await Promise.all([
      this.read("getGrant", 9, [id], block),
      this.read("vested", 1, [id], block),
      this.read("claimable", 1, [id], block),
    ]);
    return {
      id, dealId: uint(g[0]), token: address(g[1]), beneficiary: address(g[2]), custodian: address(g[3]),
      allocation: uint(g[4]), start: uint(g[5]), cliff: uint(g[6]), end: uint(g[7]), claimed: uint(g[8]),
      vested: uint(vested), claimable: uint(claimable),
    };
  }

  async beneficiaryTreasury(block) {
    const [word] = await this.read("treasury", 1, [], block);
    return address(word);
  }

  async history(id, grantId, toBlock) {
    const dealTopics = [[EVENTS.DealFunded, EVENTS.DealSettled, EVENTS.DealCancelled], indexed(id)];
    const requests = [this.logs(dealTopics, toBlock)];
    if (grantId) requests.push(this.logs([[
      EVENTS.GrantCreated, EVENTS.GrantClaimed,
    ], indexed(grantId)], toBlock));
    return (await Promise.all(requests)).flat().map(activityFromLog)
      .sort((a, b) => a.block === b.block ? Number(b.index - a.index) : (a.block < b.block ? 1 : -1));
  }

  logs(topics, toBlock) {
    return this.rpc("eth_getLogs", [{ address: this.contract, fromBlock: quantity(this.deploymentBlock), toBlock, topics }]);
  }
}
