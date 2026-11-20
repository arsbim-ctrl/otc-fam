import assert from 'node:assert/strict';
import { parseAmount, formatAmount, durationSeconds, dealRoute, MAX_UINT256 } from '../web/amounts.mjs';
let count = 0;
const test = (name, f) => { f(); console.log(`PASS ${++count}: ${name}`); };
test('exact 0, 6, 18, 24 and 255 decimals round-trip', () => {
  for (const d of [0, 6, 18, 24, 255]) for (const n of [1n, 123456n, MAX_UINT256]) assert.equal(parseAmount(formatAmount(n, d), d), n);
});
test('reject decimals beyond precision, including trailing zero', () => { for (const [v, d] of [['1.0', 0], ['1.0000000', 6], ['0.0000001', 6]]) assert.throws(() => parseAmount(v, d)); });
test('reject negative, zero, exponent, comma, nonfinite, empty and overflow', () => { for (const v of ['-1', '0', '0.00', '+1', '1e3', '1,000', 'NaN', 'Infinity', '', '.5', '1.', (MAX_UINT256 + 1n).toString()]) assert.throws(() => parseAmount(v, 0)); });
test('plain exact formatting with no floating-point rounding', () => { assert.equal(formatAmount(1500250000n, 6), '1500.25'); assert.equal(formatAmount(1n, 18), '0.000000000000000001'); });
test('duration enforces whole seconds, bounds and valid notation', () => { assert.equal(durationSeconds('0.5'), 1800n); for (const x of ['0', '-1', '1e2', '.5', '0.0001', '9000', 'Infinity']) assert.throws(() => durationSeconds(x)); });
test('route ids preserve full uint256 precision and reject malformed routes', () => { assert.equal(dealRoute('#/d/' + MAX_UINT256).id, MAX_UINT256); for (const x of ['#/d/-1', '#/d/1e3', '#/d/' + (MAX_UINT256 + 1n), '#/other']) assert.equal(dealRoute(x).kind, 'missing'); });
console.log(`${count} amount and route tests passed.`);
