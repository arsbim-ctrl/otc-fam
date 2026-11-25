// OtcDealsV2 beyond the round's checks: fee rounding at every size, the schedule's edges, what createDeal and fill
// refuse, a settlement that cannot deliver, tokens that keep fees or answer nothing, calls back into the contract,
// and who may claim. Each test runs on a fresh chain (test/lib/v2-world.mjs) and asserts what every party holds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deploy } from "../.launchpad/checks/round-1/chain.mjs";
import { ALLOCATION, artifacts, DAY, feeOn, KIND, QUOTE, revertsWith, STATUS, world, ZERO } from "./lib/v2-world.mjs";

const MAX_UINT64 = 2n ** 64n - 1n;

test("each side's fee is floor(Q * 50 / 10000), and what the buyer pays is exactly what the seller and the treasury receive", async () => {
  const w = await world();
  for (const quote of [1n, 199n, 200n, 201n, 399n, 400n, QUOTE, 10n ** 30n + 7n, 2n ** 255n]) {
    const { buyerFee, sellerFee } = await w.deals.read.fees(quote);
    assert.equal(buyerFee, feeOn(quote), `buyer fee on ${quote}`);
    assert.equal(sellerFee, feeOn(quote), `seller fee on ${quote}`);
  }
  for (const quote of [1n, 199n, 200n, 201n, QUOTE, 10n ** 30n + 7n]) {
    const t = await w.terms({ quote }), fee = feeOn(quote);
    const id = await w.fund(t);
    await w.ready(t);
    const before = await w.holdings();
    const [settled] = await w.deals.as(w.buyer).fill(id);
    assert.deepEqual([settled.name, settled.args.grantId, settled.args.buyerFee, settled.args.sellerFee], ["DealSettled", 0n, fee, fee]);
    const expected = { "buyer.USDC": -(quote + fee), "seller.USDC": quote - fee, "buyer.FAM": ALLOCATION, "deals.FAM": -ALLOCATION };
    if (fee) expected["treasury.USDC"] = 2n * fee;
    assert.deepEqual(await w.moved(before), expected, `quote ${quote}`);
    assert.equal(quote + fee, quote - fee + 2n * fee, "buyerTotal = sellerNet + feePool");
  }
  assert.equal(feeOn(QUOTE), 617_283n, "0.617283 USDC on 123.456789 USDC: the 0.000000945 below a unit stays with the payer");
});

test("vesting delivery funds a new vault with the whole allocation, and each grant has a vault of its own", async () => {
  const w = await world();
  const t = await w.vesting();
  const first = await w.fund(t), second = await w.fund({ ...t, allocation: 7n });
  await w.ready(t);
  const before = await w.holdings();
  await w.next(t.expiry - 100);
  const events = await w.deals.as(w.buyer).fill(first);
  assert.deepEqual(events.map((e) => e.name), ["GrantCreated", "DealSettled"]);
  const grant = await w.deals.read.getGrant(first), deal = await w.deals.read.getDeal(first);
  assert.equal(deal.grantId, first, "a deal's grant has the deal's id");
  assert.equal(deal.status, STATUS.Settled);
  assert.deepEqual([grant.dealId, grant.beneficiary.toLowerCase(), grant.allocation, grant.claimed], [first, w.buyer, ALLOCATION, 0n]);
  assert.deepEqual([grant.start, grant.cliff, grant.end].map(Number), [0, 30 * DAY, 90 * DAY].map((s) => t.expiry - 100 + s));
  w.watch("vault", grant.custodian);
  const fee = feeOn(QUOTE);
  assert.deepEqual(await w.moved(before), { "buyer.USDC": -(QUOTE + fee), "seller.USDC": QUOTE - fee, "treasury.USDC": 2n * fee,
    "deals.FAM": -ALLOCATION, "vault.FAM": ALLOCATION });
  const vault = await w.vault(first);
  assert.deepEqual([await vault.read.deals(), await vault.read.token(), await vault.read.beneficiary()].map((a) => a.toLowerCase()),
    [w.deals.address, w.fam.address, w.buyer].map((a) => a.toLowerCase()), "the vault names its deal contract, its token and its beneficiary");
  assert.equal(await w.fam.read.balanceOf(w.deals.address), 7n, "the other deal's allocation is still held for it");

  await w.settle(second, { ...t, allocation: 7n });
  const other = await w.deals.read.getGrant(second);
  assert.notEqual(other.custodian, grant.custodian);
  assert.equal(await w.fam.read.balanceOf(other.custodian), 7n);
  assert.equal(await w.fam.read.balanceOf(grant.custodian), ALLOCATION);
  assert.equal(await revertsWith(vault.as(w.buyer).pay(1n)), "NotDeals", "nobody but the deal contract makes a vault pay");
  assert.equal(await revertsWith(vault.as(w.seller).pay(1n)), "NotDeals");
});

test("the schedule follows block time: nothing before the cliff, the accrued share at the cliff, everything from the end on", async () => {
  for (const fixed of [false, true]) {
    const w = await world();
    const now = await w.chain.now();
    const t = await w.vesting({ fixedStart: fixed ? now + 3 * DAY : 0, expiry: now + 2 * DAY });
    const id = await w.fund(t);
    await w.ready(t);
    await w.next(now + DAY);
    await w.deals.as(w.buyer).fill(id);
    const { start, cliff, end } = await w.deals.read.getGrant(id);
    assert.equal(Number(start), fixed ? now + 3 * DAY : now + DAY, fixed ? "a fixed start is kept" : "the grant starts at its settlement");
    assert.deepEqual([cliff - start, end - start], [BigInt(30 * DAY), BigInt(90 * DAY)]);
    const span = end - start;
    for (const [time, expected, what] of [
      ...(fixed ? [[start - 1n, 0n, "a second before the start"]] : []),
      [start + 1n, 0n, "a second after the start"],
      [start + 29n * BigInt(DAY), 0n, "day 29"],
      [cliff - 1n, 0n, "a second before the cliff"],
      [cliff, ALLOCATION / 3n, "the cliff: a third accrued over 30 of 90 days"],
      [cliff + 1n, (ALLOCATION * (BigInt(30 * DAY) + 1n)) / span, "a second after the cliff"],
      [start + 45n * BigInt(DAY), ALLOCATION / 2n, "day 45"],
      [end - 1n, (ALLOCATION * (span - 1n)) / span, "a second before the end"],
      [end, ALLOCATION, "the end"],
      [end + 365n * BigInt(DAY), ALLOCATION, "a year after the end"],
    ]) {
      await w.at(time);
      assert.equal(await w.deals.read.vested(id), expected, what);
      assert.equal(await w.deals.read.claimable(id), expected, `${what}, claimable`);
    }
  }
});

test("a grant with no cliff vests from its first second, and the shortest grants and the longest cliffs stay exact", async () => {
  const w = await world();
  const now = await w.chain.now();
  const cases = [
    { cliffSeconds: 0, durationSeconds: 1000, at: [[0, 0n], [1, ALLOCATION / 1000n], [999, (ALLOCATION * 999n) / 1000n], [1000, ALLOCATION]] },
    { cliffSeconds: 0, durationSeconds: 1, at: [[0, 0n], [1, ALLOCATION]] },
    { cliffSeconds: 999, durationSeconds: 1000, at: [[998, 0n], [999, (ALLOCATION * 999n) / 1000n], [1000, ALLOCATION]] },
  ];
  let start = now + 100;
  for (const { at, ...schedule } of cases) {
    const t = await w.vesting({ ...schedule, fixedStart: start, expiry: start });
    const id = await w.fund(t);
    await w.settle(id, t);
    for (const [seconds, expected] of at) {
      await w.at(start + seconds);
      assert.equal(await w.deals.read.vested(id), expected, `cliff ${schedule.cliffSeconds}, duration ${schedule.durationSeconds}, second ${seconds}`);
    }
    start += 2000;
  }
});

test("vested never decreases, a claim never pays an old amount again, and the claims of a grant add up to exactly its allocation", async () => {
  let seed = 20261123n;
  const random = (below) => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n) % below;
  for (const allocation of [1n, 2n, 3n, ALLOCATION + 1n, 2n ** 255n]) {
    const w = await world();
    const t = await w.vesting({ allocation, cliffSeconds: 7 * DAY, durationSeconds: 100 * DAY - 1 });
    const id = await w.fund(t);
    await w.settle(id, t);
    const { start, cliff, end, custodian } = await w.deals.read.getGrant(id);
    const vestedAt = (time) => (time < cliff ? 0n : time >= end ? allocation : (allocation * (time - start)) / (end - start));
    let time = start, vested = 0n, paid = 0n;
    while (time < end) {
      time += 60n + random(BigInt(12 * DAY));
      await w.at(time);
      const now = await w.deals.read.vested(id);
      assert.equal(now, vestedAt(time));
      assert.ok(now >= vested && now <= allocation, `vested went from ${vested} to ${now}`);
      vested = now;
      if (random(2n) === 0n) continue;
      const due = now - paid, at = time + 1n + random(1000n);
      await w.next(at);
      time = at;
      const claiming = w.deals.as(w.buyer).claim(id);
      const expected = vestedAt(at) - paid;
      if (expected === 0n) {
        assert.equal(await revertsWith(claiming), "NothingToClaim");
        continue;
      }
      const [claimed] = await claiming;
      assert.ok(claimed.args.amount >= due);
      assert.equal(claimed.args.amount, expected);
      paid += claimed.args.amount;
      await w.next(at);
      assert.equal(await revertsWith(w.deals.as(w.buyer).claim(id)), "NothingToClaim", "a second claim in the same second pays nothing");
      assert.equal(await w.fam.read.balanceOf(custodian), allocation - paid, "the vault holds exactly what is not claimed yet");
    }
    if (paid < allocation) await w.deals.as(w.buyer).claim(id); // the loop ended at or after the end
    assert.equal(await w.fam.read.balanceOf(w.buyer), allocation, "the last claim takes what rounding left");
    assert.equal(await w.fam.read.balanceOf(custodian), 0n);
    assert.equal((await w.deals.read.getGrant(id)).claimed, allocation);
    assert.equal(await revertsWith(w.deals.as(w.buyer).claim(id)), "NothingToClaim");
  }
});

test("createDeal refuses terms that could not be settled as written, and takes nothing", async () => {
  const w = await world();
  const now = await w.chain.now();
  await w.fam.as(w.deployer).mint(w.seller, 10n * ALLOCATION);
  await w.fam.as(w.seller).approve(w.deals.address, 10n * ALLOCATION);
  const immediate = await w.terms(), vesting = await w.vesting();
  const refused = [
    [{ ...immediate, allocation: 0n }, "ZeroAmount"],
    [{ ...immediate, quote: 0n }, "ZeroAmount"],
    [{ ...immediate, quote: 2n ** 256n - 1n }, "QuoteTooLarge"],
    [{ ...immediate, quoteToken: w.fam.address }, "SameToken"],
    [{ ...immediate, baseToken: w.other }, "NotAToken"],
    [{ ...immediate, quoteToken: w.other }, "NotAToken"],
    [{ ...immediate, buyer: ZERO }, "NoBuyer"],
    [{ ...immediate, buyer: w.seller }, "BuyerIsSeller"],
    [{ ...immediate, expiry: now }, "ExpiryNotInFuture"],
    [{ ...immediate, fixedStart: now + DAY }, "ScheduleOnImmediate"],
    [{ ...immediate, cliffSeconds: 1 }, "ScheduleOnImmediate"],
    [{ ...immediate, durationSeconds: 90 * DAY }, "ScheduleOnImmediate"],
    [{ ...vesting, durationSeconds: 0, cliffSeconds: 0 }, "BadSchedule"],
    [{ ...vesting, cliffSeconds: vesting.durationSeconds }, "BadSchedule"],
    [{ ...vesting, cliffSeconds: vesting.durationSeconds + 1 }, "BadSchedule"],
    [{ ...vesting, fixedStart: now - 1 }, "StartNotInFuture"],
    [{ ...vesting, fixedStart: now }, "StartNotInFuture"],
    [{ ...vesting, fixedStart: MAX_UINT64 - BigInt(vesting.durationSeconds) + 1n }, "ScheduleTooLong"],
    [{ ...vesting, expiry: MAX_UINT64 - BigInt(vesting.durationSeconds) + 1n }, "ScheduleTooLong"],
  ];
  for (const [terms, error] of refused) assert.equal(await revertsWith(w.deals.as(w.seller).createDeal(terms)), error, JSON.stringify(terms, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  // A third delivery mode (an existing position) is not a value the contract can read at all.
  const data = w.deals.interface.encodeFunctionData("createDeal", [vesting]), delivery = 2 + 8 + 6 * 64; // the seventh word of the terms
  assert.equal(BigInt(`0x${data.slice(delivery, delivery + 64)}`), 1n);
  const withMode = `${data.slice(0, delivery)}${"2".padStart(64, "0")}${data.slice(delivery + 64)}`;
  assert.equal((await w.chain.rpc("eth_getTransactionReceipt", [await w.chain.submit(w.seller, { to: w.deals.address, data: withMode })])).status, "0x0");
  assert.equal(await w.fam.read.balanceOf(w.deals.address), 0n);
  assert.equal((await w.deals.read.getDeal(1)).status, STATUS.None);

  // The same terms, valid: each is accepted, and the edges of the schedule that still fit are too.
  for (const terms of [immediate, vesting, { ...vesting, cliffSeconds: 0 }, { ...vesting, fixedStart: MAX_UINT64 - BigInt(vesting.durationSeconds) },
    { ...vesting, expiry: MAX_UINT64 - BigInt(vesting.durationSeconds) }]) {
    await w.deals.as(w.seller).createDeal(terms);
  }
  assert.equal((await w.deals.read.getDeal(5)).status, STATUS.Funded);
  assert.equal(await w.fam.read.balanceOf(w.deals.address), 5n * ALLOCATION);
});

test("fill is the named buyer's alone, before the expiry and not after a fixed start, and a refused fill moves nothing", async () => {
  const w = await world();
  const now = await w.chain.now();
  const t = await w.vesting({ fixedStart: now + 1000, expiry: now + 2000 });
  const id = await w.fund(t), late = await w.fund(t), expired = await w.fund({ ...t, fixedStart: 0 });
  await w.ready(t);
  await w.ready(t, w.other);
  const before = await w.holdings();
  assert.equal(await revertsWith(w.deals.as(w.other).fill(id)), "NotBuyer", "another wallet that holds the payment");
  assert.equal(await revertsWith(w.deals.as(w.seller).fill(id)), "NotBuyer", "the seller");
  assert.equal(await revertsWith(w.deals.as(w.buyer).fill(99)), "NotFunded", "an id no deal has");
  await w.usdc.as(w.buyer).approve(w.deals.address, QUOTE);
  assert.equal(await revertsWith(w.deals.as(w.buyer).fill(id)), "TransferFailed", "an approval without the buyer fee");
  assert.deepEqual(await w.moved(before), {});

  await w.ready(t);
  await w.next(now + 1000);
  await w.deals.as(w.buyer).fill(id); // in the very second of the fixed start
  assert.equal((await w.deals.read.getGrant(id)).start, BigInt(now + 1000));
  await w.ready(t);
  const settled = await w.holdings();
  await w.next(now + 1100);
  assert.equal(await revertsWith(w.deals.as(w.buyer).fill(late)), "StartPassed", "a grant never starts before it is funded");
  assert.equal(await revertsWith(w.deals.as(w.buyer).fill(id)), "NotFunded", "a settled deal");
  await w.next(now + 2000);
  assert.equal(await revertsWith(w.deals.as(w.buyer).fill(expired)), "DealExpired", "at the expiry");
  assert.deepEqual(await w.moved(settled), {});
  for (const stuck of [late, expired]) {
    assert.equal((await w.deals.read.getDeal(stuck)).status, STATUS.Funded);
    await w.deals.as(w.seller).cancel(stuck);
  }
  assert.equal(await w.fam.read.balanceOf(w.seller), 2n * ALLOCATION, "the seller holds both unsettled allocations again");
});

test("cancel is the seller's alone, on a funded deal only, takes no fee and returns the whole allocation", async () => {
  const w = await world();
  const t = await w.terms();
  const id = await w.fund(t), settledId = await w.fund(t);
  await w.settle(settledId, t);
  const before = await w.holdings();
  for (const who of [w.buyer, w.other, w.treasury]) assert.equal(await revertsWith(w.deals.as(who).cancel(id)), "NotSeller");
  assert.equal(await revertsWith(w.deals.as(w.seller).cancel(settledId)), "NotFunded", "a settled deal");
  assert.equal(await revertsWith(w.deals.as(w.seller).cancel(99)), "NotFunded", "an id no deal has");
  assert.deepEqual(await w.moved(before), {});
  await w.deals.as(w.seller).cancel(id);
  assert.deepEqual(await w.moved(before), { "seller.FAM": ALLOCATION, "deals.FAM": -ALLOCATION });
  assert.equal(await revertsWith(w.deals.as(w.seller).cancel(id)), "NotFunded", "a cancelled deal");
  await w.ready(t);
  assert.equal(await revertsWith(w.deals.as(w.buyer).fill(id)), "NotFunded", "a cancelled deal cannot be settled");
});

test("a settlement that cannot deliver rolls back whole: no payment, no fee, no grant, no vault, and the deal can be settled later", async () => {
  for (const delivery of ["immediate", "vesting"]) {
    const w = await world();
    const fixture = await w.token("FIX", 18, "FixtureToken");
    const t = await (delivery === "vesting" ? w.vesting : w.terms)({ baseToken: fixture.address });
    const id = await w.fund(t);
    await w.ready(t);
    await fixture.as(w.deployer).setBlockedSender(w.deals.address); // the token refuses to leave the deal contract
    const before = await w.holdings(), nonce = await w.chain.rpc("eth_getTransactionCount", [w.deals.address, "latest"]);
    assert.equal(await revertsWith(w.deals.as(w.buyer).fill(id)), "TransferFailed", delivery);
    assert.deepEqual(await w.moved(before), {}, `${delivery}: nothing moved, the fees included`);
    const deal = await w.deals.read.getDeal(id);
    assert.deepEqual([deal.status, deal.grantId], [STATUS.Funded, 0n]);
    assert.equal((await w.deals.read.getGrant(id)).custodian, ZERO, "no grant is left behind");
    assert.equal(await w.chain.rpc("eth_getTransactionCount", [w.deals.address, "latest"]), nonce, "no vault was deployed");
    assert.equal(await revertsWith(w.deals.as(w.seller).cancel(id)), "TransferFailed", "the refund waits for the token too, and the deal stays funded");

    await fixture.as(w.deployer).setBlockedSender(ZERO);
    await w.deals.as(w.buyer).fill(id);
    assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Settled);
    const holder = delivery === "vesting" ? (await w.deals.read.getGrant(id)).custodian : w.buyer;
    assert.equal(await fixture.read.balanceOf(holder), ALLOCATION);
  }
});

test("a token that keeps a fee on transfer only cannot short a settlement, and its seller can still take it back", async () => {
  for (const delivery of ["immediate", "vesting"]) {
    const w = await world();
    const short = await w.token("SHORT", 18, "TransferFee"); // comes in whole by transferFrom, leaves 1% short by transfer
    const terms = delivery === "vesting" ? w.vesting : w.terms;
    const sold = await terms({ baseToken: short.address });
    const id = await w.fund(sold);
    await w.ready(sold);
    const before = await w.holdings();
    assert.equal(await revertsWith(w.deals.as(w.buyer).fill(id)), "InexactTransfer", `${delivery}: the buyer, or the grant, would get 1% less than the deal says`);
    assert.deepEqual(await w.moved(before), {});
    assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Funded);
    await w.deals.as(w.seller).cancel(id);
    assert.deepEqual(await w.moved(before), { "deals.SHORT": -ALLOCATION, "seller.SHORT": ALLOCATION - ALLOCATION / 100n },
      "the refund is not blocked: the deal contract gives up exactly the allocation, and the token keeps its own fee");

    const paid = await terms({ quoteToken: short.address });
    const paidId = await w.fund(paid);
    await w.ready(paid);
    const then = await w.holdings();
    assert.equal(await revertsWith(w.deals.as(w.buyer).fill(paidId)), "InexactTransfer", `${delivery}: the seller would be paid 1% less than the deal says`);
    assert.deepEqual(await w.moved(then), {});
  }
});

test("a token that takes a fee from the amount or on top of it is refused when the deal is funded and when it is paid", async () => {
  for (const kind of ["Fee", "FeeOnTop"]) {
    const w = await world();
    const fee = await w.token("FEE", 18, kind);
    await fee.as(w.deployer).mint(w.seller, 2n * ALLOCATION);
    await fee.as(w.seller).approve(w.deals.address, 2n * ALLOCATION);
    assert.equal(await revertsWith(w.deals.as(w.seller).createDeal(await w.terms({ baseToken: fee.address }))), "InexactTransfer", `${kind}, sold`);
    assert.equal(await fee.read.balanceOf(w.deals.address), 0n);
    const t = await w.terms({ quoteToken: fee.address });
    const id = await w.fund(t);
    await fee.as(w.deployer).mint(w.buyer, 2n * QUOTE);
    await fee.as(w.buyer).approve(w.deals.address, 2n * QUOTE);
    const before = await w.holdings();
    assert.equal(await revertsWith(w.deals.as(w.buyer).fill(id)), "InexactTransfer", `${kind}, paid`);
    assert.deepEqual(await w.moved(before), {});
  }
});

test("a token that turns a fee on once a grant holds it cannot lock the grant, and never makes one deal pay for another", async () => {
  const w = await world();
  const t = await w.vesting();
  const id = await w.fund(t), funded = await w.fund({ ...t, allocation: 500n });
  await w.fund({ ...t, allocation: 1000n }); // a third deal, whose tokens the deal contract goes on holding
  await w.settle(id, t);
  const { custodian, cliff, end } = await w.deals.read.getGrant(id);
  w.watch("vault", custodian);

  await w.fam.as(w.deployer).setKind(KIND.FeeOnTop); // paying out now costs the holder 1% more than the amount
  await w.at(cliff);
  const before = await w.holdings();
  assert.equal(await revertsWith(w.deals.as(w.buyer).claim(id)), "InexactTransfer");
  assert.equal(await revertsWith(w.deals.as(w.seller).cancel(funded)), "InexactTransfer");
  assert.deepEqual(await w.moved(before), {}, "neither the vault nor the deal contract gives more than the amount asked");

  await w.fam.as(w.deployer).setKind(KIND.Fee); // a fee its recipient pays
  await w.next(end);
  await w.deals.as(w.buyer).claim(id);
  await w.deals.as(w.seller).cancel(funded);
  assert.deepEqual(await w.moved(before), { "vault.FAM": -ALLOCATION, "buyer.FAM": ALLOCATION - ALLOCATION / 100n, "deals.FAM": -500n, "seller.FAM": 495n });
  assert.equal((await w.deals.read.getGrant(id)).claimed, ALLOCATION, "claimed counts what left the vault");
  assert.equal(await w.fam.read.balanceOf(w.deals.address), 1000n, "the third deal's tokens are all still there");
});

test("a token that answers false, or an address with no token behind it, cannot be sold or paid with", async () => {
  const w = await world();
  const nope = await w.token("NOPE", 18, "False");
  await nope.as(w.deployer).mint(w.seller, ALLOCATION);
  await nope.as(w.seller).approve(w.deals.address, ALLOCATION);
  assert.equal(await revertsWith(w.deals.as(w.seller).createDeal(await w.terms({ baseToken: nope.address }))), "TransferFailed");
  const t = await w.terms({ quoteToken: nope.address });
  const id = await w.fund(t);
  await w.ready(t);
  const before = await w.holdings();
  assert.equal(await revertsWith(w.deals.as(w.buyer).fill(id)), "TransferFailed");
  assert.deepEqual(await w.moved(before), {});
  assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Funded);
});

test("tokens that answer nothing (as USDT does) work as the allocation and as the payment, delivered at once or vested", async () => {
  for (const delivery of ["immediate", "vesting"]) {
    const w = await world();
    const base = await w.token("QUIET", 18, "NoReturnToken"), usdt = await w.token("USDT", 6, "NoReturnToken");
    const t = await (delivery === "vesting" ? w.vesting : w.terms)({ baseToken: base.address, quoteToken: usdt.address });
    const id = await w.fund(t);
    await w.settle(id, t);
    const fee = feeOn(QUOTE);
    assert.deepEqual([await usdt.read.balanceOf(w.seller), await usdt.read.balanceOf(w.treasury), await usdt.read.balanceOf(w.buyer)], [QUOTE - fee, 2n * fee, 0n]);
    if (delivery === "vesting") {
      await w.at((await w.deals.read.getGrant(id)).end);
      await w.deals.as(w.buyer).claim(id);
    }
    assert.equal(await base.read.balanceOf(w.buyer), ALLOCATION);
  }
});

test("while tokens move, every call back into createDeal, fill, cancel or claim is refused", async () => {
  for (const callback of ["createDeal", "fill", "cancel", "claim"]) {
    const w = await world();
    const evil = await w.token("EVIL", 6, "ReentrantToken");
    await w.chain.fund(evil.address);
    // EVIL itself is the seller of a second deal and the buyer of a vested one: without the lock its calls would go through.
    const t = await w.terms({ quoteToken: evil.address });
    const id = await w.fund(t), own = await w.fund(await w.terms({ allocation: 5n }), evil.address);
    const grantTerms = await w.vesting({ buyer: evil.address, cliffSeconds: 0, durationSeconds: 3600 });
    const grant = await w.fund(grantTerms);
    await w.settle(grant, grantTerms);
    const pending = await w.terms({ buyer: evil.address, allocation: 9n });
    const toFill = await w.fund(pending);
    await w.ready(pending);
    await w.fam.as(w.deployer).mint(evil.address, 3n);
    await w.fam.as(evil.address).approve(w.deals.address, 3n);
    const args = { createDeal: [await w.terms({ allocation: 3n, buyer: w.other })], fill: [toFill], cancel: [own], claim: [grant] }[callback];
    await w.at((await w.deals.read.getGrant(grant)).end);
    await w.ready(t);
    await evil.as(w.other).arm(w.deals.address, w.deals.interface.encodeFunctionData(callback, args));
    const before = await w.holdings();
    await w.deals.as(w.buyer).fill(id); // the buyer pays in EVIL, whose transfer calls the contract back
    assert.equal(await evil.read.calledBack(), false, `the call back into ${callback} went through`);
    const fee = feeOn(QUOTE);
    assert.deepEqual(await w.moved(before), { "buyer.EVIL": -(QUOTE + fee), "seller.EVIL": QUOTE - fee, "treasury.EVIL": 2n * fee, "buyer.FAM": ALLOCATION, "deals.FAM": -ALLOCATION },
      "only the deal being settled moved");
    for (const other of [own, toFill]) assert.equal((await w.deals.read.getDeal(other)).status, STATUS.Funded);
    assert.equal((await w.deals.read.getGrant(grant)).claimed, 0n);
    assert.equal((await w.deals.read.getDeal(toFill + 1n)).status, STATUS.None, "no deal was made from inside the transfer");
  }
});

test("only the beneficiary claims, only what has vested, and the tokens only ever go to the beneficiary", async () => {
  const w = await world();
  const t = await w.vesting();
  const id = await w.fund(t);
  await w.settle(id, t);
  const { cliff, end, custodian } = await w.deals.read.getGrant(id);
  w.watch("vault", custodian);
  const before = await w.holdings();
  assert.equal(await revertsWith(w.deals.as(w.buyer).claim(id)), "NothingToClaim", "before the cliff");
  await w.at(cliff);
  for (const who of [w.seller, w.other, w.treasury, w.deployer]) assert.equal(await revertsWith(w.deals.as(who).claim(id)), "NotBeneficiary");
  assert.equal(await revertsWith(w.deals.as(w.buyer).claim(99)), "NotBeneficiary", "an id no grant has");
  assert.deepEqual(await w.moved(before), {});

  await w.next(cliff + BigInt(15 * DAY)); // day 45: half
  const [claimed] = await w.deals.as(w.buyer).claim(id);
  assert.deepEqual([claimed.name, claimed.args.grantId, claimed.args.beneficiary.toLowerCase(), claimed.args.amount], ["GrantClaimed", id, w.buyer, ALLOCATION / 2n]);
  assert.deepEqual(await w.moved(before), { "vault.FAM": -(ALLOCATION / 2n), "buyer.FAM": ALLOCATION / 2n }, "no fee on a claim, and nothing for anyone else");
  await w.next(end);
  await w.deals.as(w.buyer).claim(id);
  assert.deepEqual(await w.moved(before), { "vault.FAM": -ALLOCATION, "buyer.FAM": ALLOCATION });
});

test("no fee is ever taken outside a settlement: not on funding, a refused fill, a cancel or a claim", async () => {
  const w = await world();
  const t = await w.vesting({ cliffSeconds: 0 });
  const treasury = async () => [await w.usdc.read.balanceOf(w.treasury), await w.fam.read.balanceOf(w.treasury)];
  const cancelled = await w.fund(t), id = await w.fund(t);
  assert.deepEqual(await treasury(), [0n, 0n], "after funding");
  await revertsWith(w.deals.as(w.buyer).fill(id));
  await w.deals.as(w.seller).cancel(cancelled);
  assert.deepEqual(await treasury(), [0n, 0n], "after a refused fill and a cancel");
  await w.settle(id, t);
  const fees = 2n * feeOn(QUOTE);
  assert.deepEqual(await treasury(), [fees, 0n], "after the settlement");
  await w.at((await w.deals.read.getGrant(id)).end);
  await w.deals.as(w.buyer).claim(id);
  assert.deepEqual(await treasury(), [fees, 0n], "after a claim");
});

test("the treasury is fixed at deployment, and besides createDeal, fill, cancel and claim nothing changes anything", async () => {
  const w = await world();
  const { OtcDealsV2, GrantVault } = artifacts();
  assert.equal(await revertsWith(deploy(w.chain, w.deployer, OtcDealsV2, [ZERO])), "BadTreasury");
  assert.equal((await w.deals.read.treasury()).toLowerCase(), w.treasury);
  assert.equal(await w.deals.read.FEE_BPS(), 50n);
  const changing = (abi) => abi.filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).map((f) => f.name).sort();
  assert.deepEqual(changing(OtcDealsV2.abi), ["cancel", "claim", "createDeal", "fill"]);
  assert.deepEqual(changing(GrantVault.abi), ["pay"]);
  for (const { abi } of [OtcDealsV2, GrantVault]) {
    assert.ok(!abi.some((f) => f.type === "fallback" || f.type === "receive" || f.stateMutability === "payable"), "nothing is payable, and there is no fallback");
  }
});

test("R2-03: a token that returns false or charges a fee during fill() reverts everything, and holdings() are equal before and after", async () => {
  const deliveries = ["terms", "vesting"]; // w.terms: delivered at once; w.vesting: into a new grant
  /** fill() of deal `id` reverts with `error`: nobody's holdings change, the deal is still funded and no grant is left behind. */
  const fillReverts = async (w, id, before, error, what) => {
    assert.equal(await revertsWith(w.deals.as(w.buyer).fill(id)), error, what);
    assert.deepEqual(await w.holdings(), before, `${what}: holdings() before and after fill()`);
    const deal = await w.deals.read.getDeal(id);
    assert.deepEqual([deal.status, deal.grantId], [STATUS.Funded, 0n], `${what}: the deal is still funded`);
    assert.equal((await w.deals.read.getGrant(id)).custodian, ZERO, `${what}: no grant is left behind`);
  };

  // The payment token misbehaves: the deal is funded in a plain base token, and fill() is where the payment token is first asked to move.
  for (const [kind, error] of [["False", "TransferFailed"], ["Fee", "InexactTransfer"], ["FeeOnTop", "InexactTransfer"], ["TransferFee", "InexactTransfer"]]) {
    for (const delivery of deliveries) {
      const w = await world();
      const pay = await w.token("PAY", 6, kind);
      const t = await w[delivery]({ quoteToken: pay.address });
      const id = await w.fund(t);
      await w.ready(t);
      await pay.as(w.deployer).mint(w.buyer, t.quote); // more than the payment in hand, so that a fee on top can be charged
      const before = await w.holdings();
      await fillReverts(w, id, before, error, `${delivery}, a payment token of kind ${kind}`);
      await w.deals.as(w.seller).cancel(id);
      assert.deepEqual(await w.moved(before), { "deals.FAM": -ALLOCATION, "seller.FAM": ALLOCATION }, `${kind}: the seller cancels and holds the whole allocation again`);
    }
  }

  // The base token misbehaves. createDeal already refuses one that answers false or takes a fee as it comes in: nothing moves, and there is no deal to fill.
  for (const [kind, error] of [["False", "TransferFailed"], ["Fee", "InexactTransfer"], ["FeeOnTop", "InexactTransfer"]]) {
    const w = await world();
    const base = await w.token("BASE", 18, kind);
    await base.as(w.deployer).mint(w.seller, 2n * ALLOCATION);
    await base.as(w.seller).approve(w.deals.address, 2n * ALLOCATION);
    const before = await w.holdings();
    assert.equal(await revertsWith(w.deals.as(w.seller).createDeal(await w.terms({ baseToken: base.address }))), error, `createDeal, a base token of kind ${kind}`);
    assert.deepEqual(await w.holdings(), before, `${kind}: holdings() before and after createDeal()`);
    assert.equal((await w.deals.read.getDeal(1)).status, STATUS.None);
  }
  // So fill() meets such a base token only when it comes in whole (a fee on transfer only), or when it starts to misbehave after
  // the deal is funded, as an upgradeable token can. `cancel` is what the seller's cancel does meanwhile: it returns the allocation
  // short of the token's own fee, or it waits with that error until the token behaves again.
  for (const [kind, error, cancel] of [["TransferFee", "InexactTransfer", "short"], ["False", "TransferFailed", "TransferFailed"], ["Fee", "InexactTransfer", "short"],
    ["FeeOnTop", "InexactTransfer", "InexactTransfer"]]) {
    for (const delivery of deliveries) {
      const w = await world();
      const base = await w.token("BASE", 18);
      const t = await w[delivery]({ baseToken: base.address });
      const id = await w.fund(t);
      await w.fund(t); // a second deal in the same token, whose allocation must not pay for the first
      await w.ready(t);
      await base.as(w.deployer).setKind(KIND[kind]);
      const before = await w.holdings();
      await fillReverts(w, id, before, error, `${delivery}, a base token of kind ${kind}`);
      if (cancel !== "short") {
        assert.equal(await revertsWith(w.deals.as(w.seller).cancel(id)), cancel, `${kind}: the cancel waits for the token too`);
        assert.deepEqual(await w.holdings(), before, `${kind}: holdings() before and after the refused cancel()`);
        assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Funded);
        await base.as(w.deployer).setKind(KIND.Plain);
      }
      await w.deals.as(w.seller).cancel(id);
      assert.deepEqual(await w.moved(before), { "deals.BASE": -ALLOCATION, "seller.BASE": cancel === "short" ? ALLOCATION - ALLOCATION / 100n : ALLOCATION },
        `${kind}: the seller cancels, the contract gives up exactly the allocation, and the second deal's tokens stay`);
      assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Cancelled);
    }
  }
});
