import { compile } from '../../.launchpad/checks/round-1/compile.mjs';
import { deploy, Reverted } from '../../.launchpad/checks/round-1/chain.mjs';
import { world } from '../../.launchpad/checks/round-1/world.mjs';
export const v2Artifact = compile(process.cwd(), 'contracts/OtcDealsV2.sol').OtcDealsV2;
export const edgeArtifact = compile(process.cwd(), 'test/tokens/EdgeToken.sol').EdgeToken;
export async function v2World() {
  const w = await world();
  w.v2 = await deploy(w.chain, w.deployer, v2Artifact, [w.other]);
  w.base = await deploy(w.chain, w.deployer, edgeArtifact, ['ALLOCATION', 18, 0]);
  w.quote = await deploy(w.chain, w.deployer, edgeArtifact, ['USDC', 6, 0]);
  for (const who of [w.maker, w.taker, w.other]) {
    await w.base.as(w.deployer).mint(who, who === w.maker ? 1n << 244n : 10n ** 24n);
    await w.quote.as(w.deployer).mint(who, 10n ** 30n);
  }
  w.termsV2 = async (changes = {}) => ({ baseToken: w.base.address, quoteToken: w.quote.address, buyer: w.taker, allocation: 10n ** 24n, quote: 123456789n, expiry: BigInt(await w.chain.now()) + 10000000n, delivery: 0, fixedStart: 0n, cliffSeconds: 0n, durationSeconds: 0n, ...changes });
  w.offerV2 = async (changes = {}) => {
    const t = await w.termsV2(changes);
    await w.base.as(w.maker).approve(w.v2.address, t.allocation);
    const events = await w.v2.as(w.maker).createDeal(t);
    return events.find(e => e.name === 'DealFunded').args[0];
  };
  w.acceptV2 = async id => {
    const { terms } = await w.v2.read.getDeal(id);
    await w.quote.as(w.taker).approve(w.v2.address, terms.quote + terms.quote * 50n / 10000n);
    return w.v2.as(w.taker).fill(id);
  };
  w.snapshot = async () => Promise.all([w.base, w.quote].flatMap(t => [w.maker, w.taker, w.other, w.v2.address].map(a => t.read.balanceOf(a))));
  return w;
}
export const reverted = promise => import('node:assert/strict').then(({default: assert}) => assert.rejects(promise, Reverted));
