import { address, Chain, encode, same, uint, word, words, ZERO_ADDRESS } from "./eth.js";

const GET_DEAL = "0x82fd5bac"; // getDeal(uint256)
const TREASURY = "0x61d027b3"; // treasury()
const GET_GRANT = "0xb8cc6c93"; // getGrant(uint256)
const VESTED = "0x968fb8ba"; // vested(uint256)
const ACTIVITY_BLOCKS = "0xedd33702"; // recentActivityBlocks(uint256)
const CREATE = "0x54695758"; // createDeal((address,address,address,uint256,uint256,uint64,uint8,uint64,uint64))
const CLAIM = "0x379607f5"; // claim(uint256)
const STATUS = ["none", "funded", "settled", "cancelled"];

export const DELIVERY = { immediate: 0, vesting: 1 };
const TOPICS = {
  "0x9294fa05cf234497458b8dc9e3cd8aaffbbc119a49d43f18739c7ebefc5ab81f": "Funded", // DealFunded(uint256,address,address)
  "0xcc81a8771776afbb9e09d2740010d6c455c87cf93b32b0d7464effae6511af64": "Settled", // DealSettled(uint256,uint256,uint256,uint256)
  "0x31b0c01e8429f81903c3f8adc204767b8efa7cfca91a00f3b4bb40ce63c8a206": "Refunded", // DealCancelled(uint256)
  "0x55ce46f2fdb7a9f0f6cc90970ee0b6b9c91a80586e15ea8c6fa8cfba9d7fe359": "Grant created", // GrantCreated(uint256,uint256,address)
  "0x617847aec64ffd2e4a19d71c3e0062f744212a6f13486fec81d004b3a5c8fb2e": "Claimed", // GrantClaimed(uint256,address,uint256)
};

export const hexQuantity = (n) => `0x${BigInt(n).toString(16)}`;

export function feeBreakdown(quote) {
  const fee = quote / 200n;
  return { fee, buyerTotal: quote + fee, sellerNet: quote - fee, feePool: fee * 2n };
}

export const createV2Data = ({ baseToken, quoteToken, buyer, allocation, quote, expiry, delivery, fixedStart, cliffSeconds, durationSeconds }) =>
  encode(CREATE, baseToken, quoteToken, buyer, allocation, quote, expiry, delivery, fixedStart, cliffSeconds, durationSeconds);
export const claimData = (id) => encode(CLAIM, id);

export function dealEvent(log) {
  const kind = TOPICS[log.topics[0]];
  if (!kind || log.removed) return null;
  return {
    kind, hash: log.transactionHash, index: log.logIndex, block: log.blockNumber,
    amount: kind === "Claimed" ? uint(words(log.data)[0]) : null,
  };
}

export function fundedId(receipt, contract) {
  const log = receipt.logs.find((entry) => same(entry.address, contract) && dealEvent(entry)?.kind === "Funded");
  if (!log) throw new Error("The transaction was confirmed, but its receipt has no funded deal.");
  return BigInt(log.topics[1]);
}

export class V2Chain extends Chain {
  constructor(config) {
    super(new URL(config.rpcUrl, location.href).href, config.contract);
    this.chainId = config.chainId;
  }

  async snapshot() {
    const [chainId, latest] = await Promise.all([
      this.rpc("eth_chainId", []),
      this.rpc("eth_getBlockByNumber", ["latest", false]),
    ]);
    if (Number(chainId) !== this.chainId) throw new Error("The read-only RPC is on the wrong network for this deal.");
    if (!latest?.number || !latest?.timestamp) throw new Error("Could not read the latest block.");
    return { block: latest.number, time: BigInt(latest.timestamp) };
  }

  async treasury(block) {
    const [w] = words(await this.call(this.contract, TREASURY, undefined, block));
    if (!w || address(w) === ZERO_ADDRESS) throw new Error("No V2 treasury was found at the configured contract.");
    return address(w);
  }

  async deal(id, block) {
    const w = words(await this.call(this.contract, encode(GET_DEAL, id), undefined, block));
    if (w.length !== 13) throw new Error("No V2 deal contract answered at the configured address.");
    return {
      seller: address(w[0]), baseToken: address(w[1]), quoteToken: address(w[2]), buyer: address(w[3]),
      allocation: uint(w[4]), quote: uint(w[5]), expiry: uint(w[6]), delivery: Number(uint(w[7])),
      fixedStart: uint(w[8]), cliffSeconds: uint(w[9]), durationSeconds: uint(w[10]),
      status: STATUS[Number(uint(w[11]))], grantId: uint(w[12]),
    };
  }

  async grant(id, block) {
    const [raw, vested] = await Promise.all([
      this.call(this.contract, encode(GET_GRANT, id), undefined, block),
      this.call(this.contract, encode(VESTED, id), undefined, block),
    ]);
    const w = words(raw);
    if (w.length !== 9 || !words(vested).length) throw new Error("The grant could not be read.");
    return {
      dealId: uint(w[0]), token: address(w[1]), beneficiary: address(w[2]), custodian: address(w[3]),
      allocation: uint(w[4]), start: uint(w[5]), cliff: uint(w[6]), end: uint(w[7]), claimed: uint(w[8]),
      vested: uint(words(vested)[0]),
    };
  }

  // V2 uses the source deal ID as its grant ID, so every lifecycle event has the same first topic.
  async activity(id, throughBlock) {
    const [offset, length, ...blocks] = words(await this.call(this.contract, encode(ACTIVITY_BLOCKS, id), undefined, throughBlock));
    if (!offset || uint(offset) !== 32n || uint(length) !== BigInt(blocks.length) || blocks.length > 12) {
      throw new Error("The deal's activity blocks could not be read.");
    }
    const history = await Promise.all(blocks.map((height) => {
      const block = hexQuantity(uint(height));
      return this.rpc("eth_getLogs", [{
        address: this.contract, topics: [Object.keys(TOPICS), `0x${word(id)}`], fromBlock: block, toBlock: block,
      }]);
    }));
    return history.flat().map(dealEvent).filter(Boolean).sort((a, b) =>
      Number(BigInt(a.block) - BigInt(b.block)) || Number(BigInt(a.index) - BigInt(b.index)));
  }
}
