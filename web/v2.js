// The v2 deal contract (contracts/OtcDealsV2.sol), as the page uses it: what it reads of a deal and its grant, the
// transactions it sends, the events it lists as receipts, and the fee and vesting arithmetic, written as the contract
// writes it (whole numbers only, rounded down) so that the page shows before a press exactly what the chain will do.
import { address, createdId, encode, say, uint, word, words } from "./eth.js";

// keccak256 of each signature (test/v2-abi.test.mjs checks them against the compiled contract).
const SELECTOR = {
  getDeal: "0x82fd5bac", // getDeal(uint256)
  getGrant: "0xb8cc6c93", // getGrant(uint256)
  vested: "0x968fb8ba", // vested(uint256)
  claimable: "0xd1d58b25", // claimable(uint256)
  treasury: "0x61d027b3", // treasury()
  feeBps: "0xbf333f2c", // FEE_BPS()
  createDeal: "0x54695758", // createDeal((address,address,address,uint256,uint256,uint64,uint8,uint64,uint64,uint64))
  fill: "0x3fda5389", // fill(uint256)
  cancel: "0x40e58ee5", // cancel(uint256)
  claim: "0x379607f5", // claim(uint256)
};
const TOPIC = {
  funded: "0x9294fa05cf234497458b8dc9e3cd8aaffbbc119a49d43f18739c7ebefc5ab81f", // DealFunded(uint256,address,address)
  settled: "0xcc81a8771776afbb9e09d2740010d6c455c87cf93b32b0d7464effae6511af64", // DealSettled(uint256,uint256,uint256,uint256)
  cancelled: "0x31b0c01e8429f81903c3f8adc204767b8efa7cfca91a00f3b4bb40ce63c8a206", // DealCancelled(uint256)
  granted: "0x55ce46f2fdb7a9f0f6cc90970ee0b6b9c91a80586e15ea8c6fa8cfba9d7fe359", // GrantCreated(uint256,uint256,address)
  claimed: "0x617847aec64ffd2e4a19d71c3e0062f744212a6f13486fec81d004b3a5c8fb2e", // GrantClaimed(uint256,address,uint256)
};
const STATUS = ["none", "funded", "settled", "cancelled"];
const DELIVERY = ["immediate", "vesting"];

/** Each side's fee, in hundredths of a percent of the price: 0.5%. The page refuses to work with a contract that says otherwise. */
export const FEE_BPS = 50n;
const BPS = 10_000n;

/** The money of a settlement at price `quote`, in the payment token's smallest unit: both fees rounded down. */
export function money(quote) {
  const fee = (quote * FEE_BPS) / BPS;
  return { quote, buyerFee: fee, sellerFee: fee, buyerTotal: quote + fee, sellerNet: quote - fee, feePool: 2n * fee };
}

/** How much of `allocation` has vested at `time` on a schedule `{ start, cliff, end }` (unix seconds), as the contract counts. */
export function vestedAt({ allocation, start, cliff, end }, time) {
  const at = BigInt(time);
  if (at < cliff) return 0n;
  if (at >= end) return allocation;
  return (allocation * (at - start)) / (end - start);
}

export const fillData = (id) => encode(SELECTOR.fill, id);
export const cancelData = (id) => encode(SELECTOR.cancel, id);
export const claimData = (id) => encode(SELECTOR.claim, id);
/** createDeal's data for `terms`; `delivery` is "immediate" or "vesting", and nothing else can be written. */
export function createDealData({ baseToken, quoteToken, buyer, allocation, quote, expiry, delivery, fixedStart, cliffSeconds, durationSeconds }) {
  if (!DELIVERY.includes(delivery)) throw say("This kind of delivery is not supported.");
  return encode(SELECTOR.createDeal, baseToken, quoteToken, buyer, allocation, quote, expiry, DELIVERY.indexOf(delivery), fixedStart, cliffSeconds, durationSeconds);
}
/** The id of the deal a createDeal transaction funded, from its DealFunded event. */
export const fundedId = (receipt, contract) => createdId(receipt, contract, TOPIC.funded);

/** Reads the v2 deal contract at `contract` through `chain`. `fromBlock` is where its events start (its deployment). */
export class DealsV2 {
  constructor(chain, contract, fromBlock = 0) {
    this.chain = chain;
    this.contract = contract.toLowerCase();
    this.fromBlock = fromBlock;
    this.blockTimes = new Map();
  }

  /** The treasury that receives both fees, once the contract has answered that it is a v2 deal contract with a 0.5% fee. */
  setup() {
    this.ready ??= Promise.all([this.chain.call(this.contract, SELECTOR.treasury), this.chain.call(this.contract, SELECTOR.feeBps)]).then(([treasury, fee]) => {
      if (words(treasury).length !== 1 || words(fee).length !== 1) throw say(`There is no v2 deal contract at ${this.contract} on this network: the site's config.json may be wrong.`);
      if (uint(words(fee)[0]) !== FEE_BPS) throw say("The deal contract's fee is not the 0.5% this page shows: the site must be updated before it can be used.");
      return { treasury: address(words(treasury)[0]) };
    });
    this.ready.catch(() => (this.ready = null)); // a failed look-up is tried again next time
    return this.ready;
  }

  /** Deal `id` as the chain has it; `status` is "none" for an id no deal has. */
  async deal(id) {
    const w = words(await this.chain.call(this.contract, encode(SELECTOR.getDeal, id)));
    if (w.length !== 13) throw say(`There is no v2 deal contract at ${this.contract} on this network: the site's config.json may be wrong.`);
    return {
      id, seller: address(w[0]), baseToken: address(w[1]), quoteToken: address(w[2]), buyer: address(w[3]), allocation: uint(w[4]), quote: uint(w[5]),
      expiry: Number(uint(w[6])), delivery: DELIVERY[Number(uint(w[7]))], fixedStart: Number(uint(w[8])), cliffSeconds: uint(w[9]), durationSeconds: uint(w[10]),
      status: STATUS[Number(uint(w[11]))], grantId: uint(w[12]),
    };
  }

  /** Grant `id`, with what the contract says has vested and can be claimed at the latest block, and what its vault holds. */
  async grant(id) {
    const call = (selector) => this.chain.call(this.contract, encode(selector, id));
    const [grant, vested, claimable] = (await Promise.all([call(SELECTOR.getGrant), call(SELECTOR.vested), call(SELECTOR.claimable)])).map(words);
    const g = {
      id, dealId: uint(grant[0]), token: address(grant[1]), beneficiary: address(grant[2]), custodian: address(grant[3]), allocation: uint(grant[4]),
      start: uint(grant[5]), cliff: uint(grant[6]), end: uint(grant[7]), claimed: uint(grant[8]), vested: uint(vested[0]), claimable: uint(claimable[0]),
    };
    return { ...g, held: await this.chain.balanceOf(g.token, g.custodian) };
  }

  /** What the contract emitted about deal `id` and its grant, oldest first: the receipts of everything that happened to it. */
  async history(id) {
    const logs = await this.chain.rpc("eth_getLogs", [{ address: this.contract, topics: [Object.values(TOPIC), `0x${word(id)}`], fromBlock: `0x${this.fromBlock.toString(16)}`, toBlock: "latest" }]);
    const kinds = Object.fromEntries(Object.entries(TOPIC).map(([kind, topic]) => [topic, kind]));
    return Promise.all(logs.map(async (log) => {
      const kind = kinds[log.topics[0]], data = words(log.data);
      const entry = { kind, hash: log.transactionHash, block: Number(log.blockNumber), time: await this.blockTime(log.blockNumber) };
      if (kind === "settled") Object.assign(entry, { buyerFee: uint(data[1]), sellerFee: uint(data[2]) });
      if (kind === "claimed") Object.assign(entry, { amount: uint(data[0]) });
      return entry;
    }));
  }

  /** The time of block `number` (as the node writes it, in hex), in unix seconds. */
  blockTime(number) {
    if (!this.blockTimes.has(number)) {
      const time = this.chain.rpc("eth_getBlockByNumber", [number, false]).then((block) => Number(block.timestamp));
      time.catch(() => this.blockTimes.delete(number));
      this.blockTimes.set(number, time);
    }
    return this.blockTimes.get(number);
  }
}
