// V2 uses static ABI tuples. Amounts stay in raw units through review, approval and submission.
import { Chain, address, approveData, encode, same, transact, uint, words, ZERO_ADDRESS } from "./eth.js";
import { isAddress, parseAmount } from "./units.js";

export const feeFor = quote => quote / 200n;
const MAX = (1n << 256n) - 1n;
const fundedTopic = "0x9294fa05cf234497458b8dc9e3cd8aaffbbc119a49d43f18739c7ebefc5ab81f";

export function createData(t) {
  return encode("0x54695758", t.baseToken, t.quoteToken, t.buyer, t.allocation, t.quote, t.expiry,
    t.delivery, t.fixedStart, t.cliffSeconds, t.durationSeconds);
}
export const claimData = id => encode("0x379607f5", id);
export function fundedId(receipt, contract) {
  const log = receipt.logs.find(l => same(l.address, contract) && l.topics[0] === fundedTopic);
  if (!log) throw new Error("The receipt has no funded deal. Check the transaction in your wallet.");
  return BigInt(log.topics[1]);
}

export class VestingChain extends Chain {
  async readWords(selector, args, count, block = "latest") {
    const data = encode(selector, ...args);
    const result = await this.rpc("eth_call", [{ to: this.contract, data }, block]);
    if (!new RegExp("^0x[0-9a-f]{" + count * 64 + "}$", "i").test(result))
      throw new Error("The configured V2 contract did not return the expected data.");
    return words(result);
  }

  async fungibleToken(token) {
    for (const id of ["80ac58cd", "d9b67a26"]) {
      const data = "0x01ffc9a7" + id.padEnd(64, "0");
      // ERC-165 is optional for ERC-20s. A positive NFT identification is definitive.
      const answer = await this.call(token, data).catch(() => "0x");
      if (/^0x0{63}1$/i.test(answer)) throw new Error("Existing NFT positions cannot fund this deal.");
    }
    try { return await this.token(token); }
    catch { throw new Error("Check the token address and network. A supported ERC-20 must report its decimals."); }
  }

  async deployment(chainId) {
    if (Number(await this.rpc("eth_chainId", [])) !== chainId) throw new Error("The configured RPC serves a different network.");
    const treasury = address((await this.readWords("0x61d027b3", [], 1))[0]);
    if (treasury === ZERO_ADDRESS) throw new Error("The treasury is missing from this deployment.");
    return treasury;
  }

  async deal(id, block) {
    const w = await this.readWords("0x82fd5bac", [id], 13, block);
    return { seller: address(w[0]), baseToken: address(w[1]), quoteToken: address(w[2]), buyer: address(w[3]),
      allocation: uint(w[4]), quote: uint(w[5]), expiry: uint(w[6]), delivery: Number(uint(w[7])),
      fixedStart: uint(w[8]), cliffSeconds: uint(w[9]), durationSeconds: uint(w[10]),
      status: ["Missing", "Funded", "Settled", "Cancelled"][Number(uint(w[11]))], grantId: uint(w[12]) };
  }

  async grant(id, block) {
    const [w, available] = await Promise.all([
      this.readWords("0xb8cc6c93", [id], 9, block), this.readWords("0xd1d58b25", [id], 1, block),
    ]);
    return { dealId: uint(w[0]), token: address(w[1]), beneficiary: address(w[2]), custodian: address(w[3]),
      allocation: uint(w[4]), start: uint(w[5]), cliff: uint(w[6]), end: uint(w[7]),
      claimed: uint(w[8]), claimable: uint(available[0]) };
  }
}

export async function readTerms(form, chain, seller) {
  const { baseToken, quoteToken, buyer } = form;
  for (const [label, addr] of [["Allocation token", baseToken], ["Payment token", quoteToken], ["Buyer", buyer]]) {
    if (!isAddress(addr) || same(addr, ZERO_ADDRESS)) throw new Error(label + " needs a nonzero address.");
  }
  if (same(buyer, seller) || same(buyer, chain.contract)) throw new Error("Enter the receiving buyer’s wallet address.");
  if (same(baseToken, quoteToken)) throw new Error("Choose different allocation and payment tokens.");
  const [base, payment, now] = await Promise.all([
    chain.fungibleToken(baseToken), chain.fungibleToken(quoteToken), chain.now(),
  ]);
  const allocation = parseAmount(form.allocation, base.decimals, base.symbol);
  const quote = parseAmount(form.quote, payment.decimals, payment.symbol);
  if (quote + feeFor(quote) > MAX) throw new Error("The quote plus the buyer fee is too large.");
  if (allocation === MAX || quote + feeFor(quote) === MAX) throw new Error("Choose a smaller amount to avoid an unlimited approval.");
  const hours = Number(form.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 8760 || Math.floor(hours * 3600) < 1)
    throw new Error("Enter an expiry between one second and one year from now.");
  const expiry = BigInt(now + Math.floor(hours * 3600));
  const delivery = form.delivery === "vesting" ? 1 : 0;
  if (!["vesting", "immediate"].includes(form.delivery)) throw new Error("Existing positions cannot be sold here. Choose liquid ERC-20 tokens.");
  let fixedStart = 0n, cliffSeconds = 0n, durationSeconds = 0n;
  if (delivery) {
    if (form.startMode === "fixed") {
      const start = new Date(form.startDate).getTime() / 1000;
      if (!Number.isSafeInteger(start) || start <= now) throw new Error("Choose a fixed start in the future.");
      fixedStart = BigInt(start);
    }
    for (const value of [form.cliff, form.duration]) {
      if (!/^\d{1,20}$/.test(value)) throw new Error("Enter whole numbers for the cliff and total duration.");
    }
    const unit = form.scheduleUnit === "seconds" ? 1n : 86400n;
    cliffSeconds = BigInt(form.cliff) * unit;
    durationSeconds = BigInt(form.duration) * unit;
    if (durationSeconds <= cliffSeconds || (fixedStart || expiry - 1n) + durationSeconds >= (1n << 64n))
      throw new Error("The total duration must exceed the cliff and fit the on-chain schedule.");
  }
  return { baseToken, quoteToken, buyer, allocation, quote, expiry, delivery, fixedStart, cliffSeconds, durationSeconds, base, payment };
}

// A nonzero mismatched allowance always gets its own explicit reset. This also
// removes a prior unlimited approval and works for tokens requiring zero first.
export async function spendingStep(app, token, required, account) {
  if (required === MAX) return { kind: "unlimited" };
  const { chain, config } = app;
  const [balance, allowance] = await Promise.all([chain.balanceOf(token.address, account), chain.allowance(token.address, account)]);
  if (balance < required) return { kind: "short", balance };
  if (allowance === required) return { kind: "ready" };
  const value = allowance === 0n ? required : 0n;
  return { kind: value === 0n ? "reset" : "approve", value, allowance, run: async stage => {
    await transact(app, token.address, approveData(config.contract, value), stage, value === 0n ? "Resetting the previous allowance" : "Approving the exact amount", account);
    if (await chain.allowance(token.address, account) !== value) throw new Error("The token did not set the requested allowance. Review the token before continuing.");
  } };
}
