export const MAX_UINT256 = (1n << 256n) - 1n;

export function parseAmount(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Token precision is unavailable.');
  const text = String(value).trim();
  if (text.length > 340 || !/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Enter a positive amount using digits and a decimal point.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`This token allows ${decimals} decimal places. Remove the extra digits; amounts are never rounded.`);
  const result = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (result === 0n || result > MAX_UINT256) throw new Error('Amount must be greater than zero and fit within the token’s limit.');
  return result;
}

export function formatAmount(value, decimals) {
  const text = BigInt(value).toString().padStart(decimals + 1, '0');
  if (decimals === 0) return text;
  const fraction = text.slice(-decimals).replace(/0+$/, '');
  return text.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}

export function durationSeconds(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(text) || text.length > 12) throw new Error('Enter a duration in hours, for example 24 or 0.5.');
  const [whole, fraction = ''] = text.split('.');
  const scaled = BigInt(whole + fraction.padEnd(4, '0')) * 3600n;
  if (scaled % 10000n !== 0n) throw new Error('The duration must be a whole number of seconds.');
  const seconds = scaled / 10000n;
  if (seconds < 60n || seconds > 365n * 86400n) throw new Error('Choose a duration between one minute and 365 days.');
  return seconds;
}

export function dealRoute(hash) {
  if (hash === '' || hash === '#/' || hash === '#/new') return { kind: 'new' };
  const match = /^#\/d\/(\d+)$/.exec(hash);
  if (!match || match[1].length > 78) return { kind: 'missing' };
  const id = BigInt(match[1]);
  return id > MAX_UINT256 ? { kind: 'missing' } : { kind: 'deal', id };
}
