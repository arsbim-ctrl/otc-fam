import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fees } from '../web/vesting.js';
test('fees agree with independent basis-point oracle including dust and uint256 boundary', () => {
  let seed = 17n;
  const quotes = [0n, 1n, 199n, 200n, 123456789n, (1n << 255n) - 1n];
  for (let i = 0; i < 100; i++) { seed = (seed * 48271n) % 2147483647n; quotes.push(seed * seed); }
  for (const q of quotes) {
    const f = fees(q), expected = q * 50n / 10000n;
    assert.equal(f.buyerFee, expected); assert.equal(f.sellerFee, expected);
    assert.equal(f.buyerTotal, q + expected); assert.equal(f.sellerNet, q - expected);
    assert.equal(f.feePool, 2n * expected); assert.equal(f.buyerTotal, f.sellerNet + f.feePool);
  }
});
