import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

export async function site(w, { prefix = '/', config = {}, rpcHook } = {}) {
  let url;
  const server = createServer(async (req, res) => {
    const send = (status, type, text) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(text);
    try {
      const path = new URL(req.url, url).pathname;
      if (path === prefix + 'rpc' && req.method === 'POST') {
        let text = ''; for await (const chunk of req) text += chunk;
        const q = JSON.parse(text), reply = await rpcHook?.(q) ?? await w.chain.publicRpc(q);
        return send(200, 'application/json', JSON.stringify(reply));
      }
      if (path === prefix + 'config.json') return send(200, 'application/json', JSON.stringify({ chainId: 31337, contract: w.deals.address, rpcUrl: url + 'rpc', ...config }));
      if (!path.startsWith(prefix)) return send(404, 'text/plain', 'not found');
      const base = resolve('dist'), file = resolve(base, path.slice(prefix.length) || 'index.html');
      if (!file.startsWith(base + sep)) return send(404, 'text/plain', 'not found');
      return send(200, { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript' }[extname(file)] || 'text/plain', readFileSync(file));
    } catch { send(500, 'text/plain', 'test server failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}${prefix}`;
  return { url, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
export function testWallet(w, account = w.taker) {
  const control = { account, connected: false, chainId: 31337, sends: [], calls: [], reject: null, beforeSend: null, delay: 0 };
  control.answer = async ({ method, params = [] }) => {
    control.calls.push(method);
    if (control.reject === method) return { error: { code: 4001, message: 'User declined' } };
    switch (method) {
      case 'eth_accounts': return { result: control.connected ? [control.account] : [] };
      case 'eth_chainId': return { result: '0x' + control.chainId.toString(16) };
      case 'eth_requestAccounts': control.connected = true; return { result: [control.account] };
      case 'wallet_switchEthereumChain': control.chainId = Number(BigInt(params[0].chainId)); return { result: null };
      case 'eth_sendTransaction': {
        control.sends.push(params[0]);
        if (control.delay) await new Promise(r => setTimeout(r, control.delay));
        await control.beforeSend?.(params[0]);
        try { return { result: await w.chain.submit(params[0].from, params[0]) }; }
        catch (e) { return { error: { code: e.code ?? -32000, message: e.message } }; }
      }
      default: return { error: { code: 4200, message: 'Unsupported test wallet method' } };
    }
  };
  return control;
}
export async function browserPage(browser, url, wallet = null, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport, locale: 'en-US', timezoneId: 'UTC' });
  if (wallet) {
    await context.exposeBinding('__testWallet', (_, request) => wallet.answer(request));
    await context.addInitScript(() => {
      const listeners = {};
      window.__testEmit = (event, value) => { for (const f of listeners[event] || []) f(value); };
      window.ethereum = {
        async request(request) {
          const r = await window.__testWallet(request);
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
          if (request.method === 'eth_requestAccounts') window.__testEmit('accountsChanged', r.result);
          return r.result;
        },
        on(event, f) { (listeners[event] ??= []).push(f); },
        removeListener(event, f) { listeners[event] = (listeners[event] || []).filter(x => x !== f); },
      };
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(url);
  return { page, context };
}
export { chromium };
