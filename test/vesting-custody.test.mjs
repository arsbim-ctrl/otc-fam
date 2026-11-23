import assert from "node:assert/strict";
import { test } from "node:test";
import { deploy, Reverted, startChain } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";

test("a token changing its transfer fee cannot short a grant claim or consume another funded deal", async () => {
  const [seller, buyer, treasury] = ["11","22","33"].map(pair => "0x" + pair.repeat(20));
  const chain = await startChain([seller,buyer]);
  const { OtcDealsV2 } = compile(ROOT, "contracts/OtcDealsV2.sol");
  const { EdgeToken } = compile(ROOT, "test/tokens/EdgeToken.sol");
  const deals = await deploy(chain, seller, OtcDealsV2, [treasury]);
  const base = await deploy(chain, seller, EdgeToken, ["BASE",0,0]);
  const pay = await deploy(chain, seller, EdgeToken, ["PAY",0,0]);
  await base.as(seller).mint(seller, 2000);
  await base.as(seller).approve(deals.address, 2000);
  const terms = { baseToken: base.address, quoteToken: pay.address, buyer, allocation: 1000, quote: 200,
    delivery: 1, expiry: await chain.now()+3600, fixedStart: 0, cliffSeconds: 0, durationSeconds: 10 };
  await deals.as(seller).createDeal(terms);
  await deals.as(seller).createDeal(terms);
  await pay.as(seller).mint(buyer, 201);
  await pay.as(buyer).approve(deals.address, 201);
  await deals.as(buyer).fill(1);
  const grant = await deals.read.getGrant(1);
  await chain.setNextTime(Number(grant.end));
  for (const kind of [1,2]) {
    await base.as(seller).setKind(kind);
    await assert.rejects(deals.as(buyer).claim(1), Reverted);
    assert.equal((await deals.read.getGrant(1)).claimed, 0n);
    assert.equal(await base.read.balanceOf(deals.address), 2000n);
    assert.equal(await base.read.balanceOf(buyer), 0n);
  }
  await base.as(seller).setKind(0);
  await deals.as(buyer).claim(1);
  await deals.as(seller).cancel(2);
  assert.equal(await base.read.balanceOf(seller), 1000n);
  assert.equal(await base.read.balanceOf(buyer), 1000n);
});
