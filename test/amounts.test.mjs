// web/units.js: amounts are shown with every digit, and typed amounts become exactly the token's smallest unit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAmount, isAddress, parseAmount } from "../web/units.js";

test("an amount is shown in whole tokens, never rounded, with commas between thousands", () => {
  assert.equal(formatAmount(1_500_250_000n, 6), "1,500.25");
  assert.equal(formatAmount(750_000_000_000_000_000n, 18), "0.75");
  assert.equal(formatAmount(1n, 18), "0.000000000000000001");
  assert.equal(formatAmount(1_000_000n, 0), "1,000,000");
  assert.equal(formatAmount(0n, 6), "0");
  assert.equal(formatAmount(2n ** 256n - 1n, 18), "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.584007913129639935");
});

test("a typed amount becomes exactly the token's smallest unit", () => {
  assert.equal(parseAmount("1500.25", 6), 1_500_250_000n);
  assert.equal(parseAmount(" 250.5 ", 6), 250_500_000n);
  assert.equal(parseAmount("0.125", 18), 125_000_000_000_000_000n);
  assert.equal(parseAmount(".5", 1), 5n);
  assert.equal(parseAmount("7.", 0), 7n);
  assert.equal(parseAmount("1.500000000", 6), 1_500_000n, "zeros past the token's decimals change nothing");
  for (const units of [1n, 999_999n, 1_500_250_000n]) assert.equal(parseAmount(formatAmount(units, 6).replaceAll(",", ""), 6), units);
});

test("an amount the token cannot hold is refused, with a reason a person can act on", () => {
  assert.throws(() => parseAmount("2.5", 0, "WHOLE"), /WHOLE has no decimals: write a whole number/);
  assert.throws(() => parseAmount("0.1234567", 6, "ALFA"), /ALFA has 6 decimals: write at most 6 digits after the dot/);
  assert.throws(() => parseAmount("0", 6), /more than zero/);
  assert.throws(() => parseAmount("0.000", 6), /more than zero/);
  assert.throws(() => parseAmount(`1${"0".repeat(78)}`, 0), /too large/);
  for (const text of ["", ".", "1,5", "1.2.3", "-1", "1e18", "0x10", "ten"]) assert.throws(() => parseAmount(text, 6), /digits and a dot/, JSON.stringify(text));
});

test("an address is 0x and 40 hex digits", () => {
  assert.ok(isAddress("0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"));
  assert.ok(isAddress("0x1A2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4D"));
  for (const text of ["", "0x", "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4", "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4g"]) {
    assert.ok(!isAddress(text), text);
  }
});
