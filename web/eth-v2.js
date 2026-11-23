import { Chain, same, explain as explainLegacy } from "./eth.js";
export const SELECTOR_V2 = {
  createDeal: "0x54695758", // createDeal((address,address,address,uint256,uint256,uint64,uint8,uint64,uint64,uint64))
  getDeal: "0x82fd5bac", // getDeal(uint256)
  getGrant: "0xb8cc6c93", // getGrant(uint256)
  vested: "0x968fb8ba", // vested(uint256)
  claimable: "0xd1d58b25", // claimable(uint256)
  claim: "0x379607f5", // claim(uint256)
  treasury: "0x61d027b3", // treasury()
};
const FUNDED = "0x9294fa05cf234497458b8dc9e3cd8aaffbbc119a49d43f18739c7ebefc5ab81f";
// DealSettled(uint256,uint256,uint256,uint256), DealCancelled(uint256), GrantClaimed(uint256,address,uint256)
const SETTLED = "0xcc81a8771776afbb9e09d2740010d6c455c87cf93b32b0d7464effae6511af64";
const CANCELLED = "0x31b0c01e8429f81903c3f8adc204767b8efa7cfca91a00f3b4bb40ce63c8a206";
const CLAIMED = "0x617847aec64ffd2e4a19d71c3e0062f744212a6f13486fec81d004b3a5c8fb2e";
const word = v => BigInt(v).toString(16).padStart(64, "0");
export const encodeV2 = (name, ...args) => SELECTOR_V2[name] + args.map(word).join("");
export const createV2Data = t => encodeV2("createDeal", t.baseToken, t.quoteToken, t.buyer, t.allocation, t.quote, t.expiry, t.delivery, t.fixedStart, t.cliffSeconds, t.durationSeconds);
const words = hex => hex.slice(2).match(/.{64}/g) ?? [];
const uint = w => BigInt(`0x${w}`);
const addr = w => `0x${w.slice(24)}`;
export function fundedId(receipt, contract) {
  const log = receipt.logs.find(l => same(l.address, contract) && l.topics[0] === FUNDED);
  if (!log) throw new Error("No funded deal was recorded in the transaction receipt. Check your wallet activity before trying again.");
  return BigInt(log.topics[1]);
}
export class ChainV2 extends Chain {
  async deal(id, block = "latest") {
    const w = words(await this.rpc("eth_call", [{ to: this.contract, data: encodeV2("getDeal", id) }, block]));
    if (w.length !== 13) throw new Error("No V2 deal contract answers here. Check contractV2 in config.json.");
    return { id, seller: addr(w[0]), baseToken: addr(w[1]), quoteToken: addr(w[2]), buyer: addr(w[3]), allocation: uint(w[4]), quote: uint(w[5]), expiry: uint(w[6]), delivery: Number(uint(w[7])), fixedStart: uint(w[8]), cliffSeconds: uint(w[9]), durationSeconds: uint(w[10]), status: ["none", "funded", "settled", "cancelled"][Number(uint(w[11]))], grantId: uint(w[12]) };
  }
  async grant(id, block = "latest") {
    const w = words(await this.rpc("eth_call", [{ to: this.contract, data: encodeV2("getGrant", id) }, block]));
    if (w.length !== 9) throw new Error("The grant could not be read. Try again.");
    return { id, dealId: uint(w[0]), token: addr(w[1]), beneficiary: addr(w[2]), custodian: addr(w[3]), allocation: uint(w[4]), start: uint(w[5]), cliff: uint(w[6]), end: uint(w[7]), claimed: uint(w[8]) };
  }
  // Pin grant accounting and time to one block, including when another tab claims.
  async snapshot(id) {
    const block = await this.rpc("eth_getBlockByNumber", ["latest", false]);
    const deal = await this.deal(id, block.number);
    const grant = deal.grantId ? await this.grant(deal.grantId, block.number) : null;
    return { deal, grant, time: Number(BigInt(block.timestamp)) };
  }
  // Settlement, cancellation and claim receipts, read back from contract events so they survive a reload.
  async history(deal) {
    const logs = (topics) => this.rpc("eth_getLogs", [{ address: this.contract, fromBlock: "0x0", toBlock: "latest", topics }]);
    const found = [...await logs([[SETTLED, CANCELLED], `0x${word(deal.id)}`]), ...(deal.grantId ? await logs([CLAIMED, `0x${word(deal.grantId)}`]) : [])]
      .filter(l => !l.removed).sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    return Promise.all(found.map(async l => ({
      kind: l.topics[0] === SETTLED ? "Settlement" : l.topics[0] === CANCELLED ? "Cancellation and refund" : "Claim",
      claimed: l.topics[0] === CLAIMED ? uint(words(l.data)[0]) : null,
      receipt: await this.rpc("eth_getTransactionReceipt", [l.transactionHash]),
    })));
  }
  async treasury() { return addr(words(await this.call(this.contract, SELECTOR_V2.treasury))[0]); }
}

const REASONS_V2 = {
  '0x1f2a2005': 'Both amounts must be more than zero, and the buyer total (payment plus the 0.5% buyer fee) must fit the token integer limit.',
  '0xd92e233d': 'Buyer and treasury must be nonzero external addresses.',
  '0xdba16ce8': 'The vesting schedule is invalid or its fixed start has passed. Ask the seller to cancel and create fresh terms.',
  '0x6a06b652': 'This deal is no longer funded: it was settled or cancelled. Refresh its status.',
  '0x09b4c33d': 'Only the designated buyer can settle. Switch to the buyer wallet.',
  '0xa7e67778': 'Only the seller can cancel and refund this allocation.',
  '0xf9489585': 'Nothing is claimable at this block. Check the schedule and refresh after more tokens vest.',
};
export function explainV2(error) {
  const data = [error?.data, error?.data?.data, error?.data?.originalError?.data, error?.error?.data, error?.info?.error?.data].find(x => typeof x === 'string');
  return REASONS_V2[data?.slice(0, 10)] ?? explainLegacy(error);
}
