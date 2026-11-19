import { Interface, getAddress, decodeBytes32String } from './vendor/ethers.js';

export const ZERO = '0x' + '0'.repeat(40);
export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const address = (value) => getAddress(value.trim());
export const dealsABI = new Interface([
  'function getDeal(uint256) view returns (tuple(address maker,address taker,address sellToken,uint256 sellAmount,address buyToken,uint256 buyAmount,uint64 expiry,uint8 status))',
  'function createDeal(address,uint256,address,uint256,address,uint64) returns (uint256)',
  'function fill(uint256)', 'function cancel(uint256)',
  'event DealCreated(uint256 indexed id,address indexed maker,address indexed taker)',
  'error NotOpen()', 'error NotMaker()', 'error NotTaker()', 'error Expired()',
  'error InexactTransfer()', 'error InvalidTerms()', 'error InvalidToken()',
]);
export const tokenABI = new Interface([
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

export class Chain {
  constructor(config) { this.config = config; this.counter = 0; this.metadata = new Map(); }
  async rpc(method, params = []) {
    const id = ++this.counter;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(this.config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: controller.signal });
      if (!response.ok) throw new Error('The network is unavailable. Try refreshing in a moment.');
      const data = await response.json();
      if (data.id !== id || data.jsonrpc !== '2.0') throw new Error('The network returned an invalid response.');
      if (data.error) throw Object.assign(new Error('The chain could not complete this request.'), { rpcError: data.error });
      return data.result;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('The network is not responding. Check your connection and refresh.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async call(abi, to, name, args = []) {
    const raw = await this.rpc('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, 'latest']);
    return abi.decodeFunctionResult(name, raw)[0];
  }
  deal(id) { return this.call(dealsABI, this.config.contract, 'getDeal', [id]); }
  balance(token, who) { return this.call(tokenABI, token, 'balanceOf', [who]); }
  allowance(token, who) { return this.call(tokenABI, token, 'allowance', [who, this.config.contract]); }
  async now() { return BigInt((await this.rpc('eth_getBlockByNumber', ['latest', false])).timestamp); }
  token(token) {
    if (!this.metadata.has(token)) this.metadata.set(token, (async () => {
      if (await this.rpc('eth_getCode', [token, 'latest']) === '0x') throw new Error('This address is not a token contract on this network.');
      const decimals = Number(await this.call(tokenABI, token, 'decimals'));
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Token precision is unavailable.');
      let symbol;
      try { symbol = await this.call(tokenABI, token, 'symbol'); }
      catch {
        try { symbol = decodeBytes32String(await this.rpc('eth_call', [{ to: token, data: tokenABI.encodeFunctionData('symbol') }, 'latest'])); }
        catch { symbol = 'Unknown token'; }
      }
      if (typeof symbol !== 'string' || symbol.length > 100 || /[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/.test(symbol)) symbol = 'Unknown token';
      return { address: token, decimals, symbol };
    })().catch(error => { this.metadata.delete(token); throw error; }));
    return this.metadata.get(token);
  }
}

export async function loadConfig() {
  const response = await fetch(new URL('config.json', document.baseURI), { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Could not load the site configuration. Refresh to try again.');
  const config = await response.json();
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error('The site has an invalid network configuration.');
  config.contract = address(config.contract);
  if (same(config.contract, ZERO)) throw new Error('This site has not been connected to a deployed deal contract yet.');
  const rpc = new URL(config.rpcUrl, document.baseURI);
  if (!['http:', 'https:'].includes(rpc.protocol) || rpc.username || rpc.password) throw new Error('The site has an invalid RPC configuration.');
  config.rpcUrl = rpc.href;
  return config;
}
