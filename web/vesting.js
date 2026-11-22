// Raw units and chain seconds only; no display rounding or browser clock.
export function fees(quote) {
  const buyerFee = quote / 200n, sellerFee = quote / 200n;
  return { buyerFee, sellerFee, buyerTotal: quote + buyerFee, sellerNet: quote - sellerFee, feePool: buyerFee + sellerFee };
}
export function vesting(grant, time) {
  const t = BigInt(time), { allocation: a, start, cliff, end, claimed } = grant;
  const vested = t < cliff ? 0n : t >= end ? a : a * (t - start) / (end - start);
  return { vested, claimed, claimable: vested - claimed, locked: a - vested };
}
export function expirySeconds(text) {
  const hours = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || hours * 3600 < 60 || hours > 8760) throw new Error(`Expiry hours “${text}”: enter at least 1 minute (0.0166667 hours), up to 8760 hours.`);
  return Math.ceil(hours * 3600);
}
export function schedule({ delivery, fixedStart, cliffSeconds, durationSeconds }, now) {
  const start = fixedStart || BigInt(now);
  if (!delivery) {
    if (fixedStart || cliffSeconds || durationSeconds) throw new Error("Immediate delivery requires zero schedule fields.");
  } else if (!durationSeconds || cliffSeconds >= durationSeconds || (fixedStart && fixedStart <= BigInt(now)) || start + durationSeconds > (1n << 64n) - 1n) {
    throw new Error("Schedule: use a future UTC start, a positive duration and a cliff shorter than the duration.");
  }
  return { start, cliff: start + cliffSeconds, end: start + durationSeconds };
}
