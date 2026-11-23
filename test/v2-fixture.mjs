import { deploy } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { world } from "../.launchpad/checks/round-1/world.mjs";

export const DAY = 86_400n;
export const QUOTE = 123_456_789n;
export const ALLOCATION = 1_000_000n * 10n ** 18n;
export const TREASURY = "0xc9d1b149c93468b4fabe0e4cfd0e953d4d7450e3";
export const STATUS = { funded: 1n, settled: 2n, cancelled: 3n };

let artifact;
export async function v2World(baseKind = "PlainToken") {
  artifact ??= compile(ROOT, "contracts/OtcDealsV2.sol").OtcDealsV2;
  const w = await world();
  w.v2 = await deploy(w.chain, w.deployer, artifact, [TREASURY]);
  w.base = await w.token(baseKind, "BASE", 18);
  w.usdc = await w.token("PlainToken", "USDC", 6);
  w.termsV2 = async (overrides = {}) => ({
    baseToken: w.base.address, quoteToken: w.usdc.address, buyer: w.taker, allocation: ALLOCATION, quote: QUOTE,
    expiry: BigInt(await w.chain.now()) + DAY, delivery: 1, fixedStart: 0n, cliffSeconds: DAY * 30n,
    durationSeconds: DAY * 90n, ...overrides,
  });
  w.balances = async (token = w.base) => Promise.all([w.maker, w.taker, TREASURY, w.v2.address, w.other]
    .map((address) => token.read.balanceOf(address)));
  w.warp = async (timestamp) => {
    await w.chain.setNextTime(timestamp);
    await w.chain.mine();
  };
  return w;
}
