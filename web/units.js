// Amounts: a token's smallest unit (a BigInt, as the chain counts) and the whole-token text people read and type.
// Nothing is ever rounded: 1500250000 of a 6-decimal token is "1,500.25", and "1500.25" is 1500250000 again.

const MAX_UINT256 = 2n ** 256n - 1n;

export const isAddress = (text) => /^0x[0-9a-fA-F]{40}$/.test(text);

/** 1500250000n with 6 decimals -> "1,500.25": every digit kept, commas between thousands. */
export function formatAmount(units, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = (units / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * "250.5" of a token with `decimals` -> its smallest unit. Throws a reason a person can act on when the text is
 * not an amount of this token: not a number, more decimals than the token has, zero, too large.
 */
export function parseAmount(text, decimals, symbol = "This token") {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!match || (!match[1] && !match[2])) throw new Error("Write the amount with digits and a dot, like 250.5.");
  const whole = match[1] || "0";
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) {
    throw new Error(decimals === 0 ? `${symbol} has no decimals: write a whole number.` : `${symbol} has ${decimals} decimals: write at most ${decimals} digits after the dot.`);
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units === 0n) throw new Error("The amount must be more than zero.");
  if (units > MAX_UINT256) throw new Error("That amount is too large.");
  return units;
}
