import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schedule, vesting, expirySeconds } from '../web/vesting.js';
test('cliff releases accrual since start, exact boundaries and dust', () => {
  for (const allocation of [1n, 1000000n * 10n ** 18n, 1n << 240n, (1n << 240n) + 1n]) {
    const g = { allocation, start: 100n, cliff: 130n, end: 190n, claimed: 0n };
    for (const t of [99n, 100n, 129n, 130n, 145n, 189n, 190n, 191n]) {
      const expected = t < 130n ? 0n : t >= 190n ? allocation : allocation * (t - 100n) / 90n;
      assert.equal(vesting(g, t).vested, expected);
      assert.equal(vesting(g, t).locked + expected, allocation);
    }
  }
});
test('schedule and expiry reject stale starts, unsupported bounds and sub-minute hours', () => {
  for (const value of ['0.0001', '0.0166666', '1e2', '8760.1', '-1', 'Infinity']) assert.throws(() => expirySeconds(value));
  assert.equal(expirySeconds('0.0166667'), 61); assert.equal(expirySeconds('8760'), 31536000);
  const good = { delivery: 1, fixedStart: 200n, cliffSeconds: 30n, durationSeconds: 90n };
  assert.deepEqual(schedule(good, 100), { start: 200n, cliff: 230n, end: 290n });
  for (const patch of [{ fixedStart: 100n }, { durationSeconds: 0n }, { cliffSeconds: 90n }, { fixedStart: (1n << 64n) - 1n }]) assert.throws(() => schedule({ ...good, ...patch }, 100));
});
