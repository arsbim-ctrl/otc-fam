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

/**
 * How long a new deal stays open, from the hours a person typed: `{ hours }`, or what to fix (`problem`, `note`).
 * At least a minute: a deal that ends within seconds is refused by the chain as already over, or dies unseen.
 */
export function openFor(text) {
  const hours = Number(text);
  if (/^\d+(\.\d+)?$/.test(text) && hours * 3600 >= 60 && hours <= 8760) return { hours };
  return { problem: "Check the hours", note: "Write a number of hours, at least 0.017 (one minute) and at most 8760 (a year), like 24 or 0.5." };
}

/** "30" or "0.5" days -> seconds, exactly (a day is 86,400 seconds of chain time); throws when it is not a whole number of seconds. */
export function daysToSeconds(text) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new Error("Write a number of days with digits and a dot, like 30 or 0.5.");
  const fraction = match[2] ?? "", scale = 10n ** BigInt(fraction.length);
  const scaled = BigInt(match[1] + fraction) * 86_400n;
  if (scaled % scale) throw new Error("That is not a whole number of seconds: write fewer digits after the dot.");
  if (scaled / scale >= 2n ** 64n) throw new Error("That is too long to be written on the chain.");
  return scaled / scale;
}

/** "2026-12-01 00:00" (or 2026-12-01T00:00:30Z), read as UTC -> unix seconds; throws when it is not such a date. */
export function parseUtc(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:Z|UTC)?$/i.exec(text.trim());
  const [year, month, day, hour, minute, second] = (match ?? []).slice(1).map((part) => Number(part ?? 0));
  const time = match ? new Date(Date.UTC(year, month - 1, day, hour, minute, second)) : null;
  const real = time && time.getUTCFullYear() === year && time.getUTCMonth() === month - 1 && time.getUTCDate() === day
    && time.getUTCHours() === hour && time.getUTCMinutes() === minute && time.getUTCSeconds() === second;
  if (!real) throw new Error("Write the date and the time in UTC, like 2026-12-01 00:00.");
  return time.getTime() / 1000;
}
