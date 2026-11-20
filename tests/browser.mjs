import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { world, STATUS } from '../.launchpad/checks/round-1/world.mjs';
import { compile } from '../.launchpad/checks/round-1/compile.mjs';
import { deploy } from '../.launchpad/checks/round-1/chain.mjs';
import { site, testWallet, browserPage, chromium } from './site.mjs';

const folder = process.env.SCREEN_DIR;
if (folder) mkdirSync(folder, { recursive: true });
const browser = await chromium.launch();
let count = 0;
const selected = new RegExp(process.argv[2] || '');
const test = async (name, fn) => { if (!selected.test(name)) return; try { await fn(); console.log(`PASS ${++count}: ${name}`); } catch (e) { console.error(`FAIL: ${name}`); throw e; } };
const button = p => p.getByTestId('primary-action');
async function ready(p, text) { await p.waitForFunction(t => { const b = document.querySelector('[data-testid="primary-action"]'); return b && !b.disabled && b.textContent.includes(t); }, text); }
async function click(p, text) { await ready(p, text); await button(p).click(); }
async function status(p, value) { await p.waitForFunction(v => document.querySelector('[data-testid="deal-status"]')?.dataset.status === v, value); }
async function notice(p, text) { await p.waitForFunction(t => document.querySelector('[data-testid="notice"]')?.textContent.toLowerCase().includes(t.toLowerCase()), text); }
const screenshot = async (p, name) => { if (folder) await p.screenshot({ path: join(folder, name + '.png'), fullPage: true }); };
async function withDeal(fn, { reserved = false, serverOptions = {}, walletAccount, wallet: wantsWallet = true } = {}) {
  const w = await world(), id = await w.offer({ taker: reserved ? w.taker : '0x' + '0'.repeat(40) });
  const wallet = wantsWallet ? testWallet(w, walletAccount ? w[walletAccount] : w.taker) : null;
  const server = await site(w, serverOptions);
  const { page, context } = await browserPage(browser, server.url + `#/d/${id}`, wallet);
  try { await fn({ w, id, wallet, page, server }); } finally { await context.close(); await server.close(); }
}
const artifact = compile(process.cwd(), 'tests/AdversarialToken.sol').AdversarialToken;
async function extraToken(w, symbol = 'EDGE', decimals = 6) {
  const t = await deploy(w.chain, w.deployer, artifact);
  await t.as(w.deployer).setMetadata(symbol, decimals);
  for (const who of [w.maker, w.taker]) await t.as(w.deployer).mint(who, 1000000000000n);
  return t;
}

try {
await test('mobile wallet-free read, exact figures, unique handles and no remote assets', async () => {
  await withDeal(async ({ page, server }) => {
    await status(page, 'open');
    assert.equal(await page.getByTestId('receive-amount').innerText(), '1500.25');
    assert.equal(await page.getByTestId('pay-amount').innerText(), '0.75');
    assert.match(await page.locator('.noncustody').innerText(), /do not reserve funds/);
    const duplicates = await page.locator('[data-testid]').evaluateAll(es => es.map(e => e.dataset.testid).filter((id, i, a) => a.indexOf(id) !== i));
    assert.deepEqual(duplicates, []);
    const remote = await page.evaluate(origin => performance.getEntriesByType('resource').map(r => r.name).filter(n => !n.startsWith(origin) && !n.startsWith('data:')), new URL(server.url).origin);
    assert.deepEqual(remote, []);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await screenshot(page, `responsive-${width}`);
    }
  }, { wallet: false });
});
await test('complete fill with actual receipts, exact approvals and three presses', async () => {
  await withDeal(async ({ w, id, page, wallet }) => {
    await screenshot(page, 'fill-loading');
    await click(page, 'Connect'); await ready(page, 'Approve'); await screenshot(page, 'fill-1-approve');
    await click(page, 'Approve'); await ready(page, 'Swap'); await screenshot(page, 'fill-2-ready');
    await click(page, 'Swap'); await status(page, 'filled'); await screenshot(page, 'fill-3-complete');
    assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Filled);
    assert.equal(wallet.sends.length, 2);
    assert(wallet.sends.every(tx => tx.chainId === '0x7a69'));
    const approval = w.bravo.interface.decodeFunctionData('approve', wallet.sends[0].data);
    assert.equal(approval[1], w.BUY);
  });
});
await test('official shared-offer scenario: exhausted maker approval blocks, then restores and fills', async () => {
  await withDeal(async ({ w, id, page }) => {
    const other = await w.offer(); await w.accept(other);
    await click(page, 'Connect'); await notice(page, 'maker needs to restore');
    assert.equal(await button(page).isDisabled(), true); await screenshot(page, 'maker-approval-missing');
    await w.approve(w.maker, w.alfa, w.SELL); await page.getByRole('button', { name: 'Refresh status' }).click();
    await click(page, 'Approve'); await click(page, 'Swap'); await status(page, 'filled');
    assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Filled);
    await screenshot(page, 'maker-approval-restored-complete');
  });
});
await test('wallet connection rejection can recover without automatic transactions', async () => {
  await withDeal(async ({ page, wallet }) => {
    wallet.reject = 'eth_requestAccounts'; await click(page, 'Connect'); await notice(page, 'declined');
    assert.equal(wallet.sends.length, 0); wallet.reject = null; await click(page, 'Connect'); await ready(page, 'Approve');
  });
});
await test('approval rejection retains a usable action and sends no transaction', async () => {
  await withDeal(async ({ page, wallet }) => {
    await click(page, 'Connect'); wallet.reject = 'eth_sendTransaction'; await click(page, 'Approve'); await notice(page, 'declined');
    assert.equal(wallet.sends.length, 0); wallet.reject = null; await click(page, 'Approve'); await ready(page, 'Swap');
  });
});
await test('wrong chain must switch before any approval or fill', async () => {
  await withDeal(async ({ page, wallet }) => {
    wallet.chainId = 1; await click(page, 'Connect'); await ready(page, 'Switch'); assert.equal(wallet.sends.length, 0);
    await click(page, 'Switch'); await ready(page, 'Approve'); assert.equal(wallet.chainId, 31337);
  });
});
await test('reserved wallet switch invalidates fill readiness and names full authorized address', async () => {
  await withDeal(async ({ w, page, wallet }) => {
    await click(page, 'Connect'); await ready(page, 'Approve');
    wallet.account = w.other; await page.evaluate(a => window.__testEmit('accountsChanged', [a]), w.other);
    await notice(page, w.taker); assert.equal(await button(page).isDisabled(), true); assert.equal(wallet.sends.length, 0);
    await screenshot(page, 'wrong-wallet');
  }, { reserved: true });
});
await test('network change during preflight prevents send', async () => {
  let flip = false, walletControl;
  await withDeal(async ({ page, wallet }) => {
    walletControl = wallet; await click(page, 'Connect'); await ready(page, 'Approve'); flip = true;
    await button(page).click(); await notice(page, 'changed'); assert.equal(wallet.sends.length, 0);
  }, { serverOptions: { rpcHook: async q => {
    if (flip && q.method === 'eth_call' && q.params[0].data.startsWith('0x095ea7b3')) { walletControl.chainId = 1; }
  } } });
});
await test('rapid repeated clicks send only one transaction while wallet is pending', async () => {
  await withDeal(async ({ page, wallet }) => {
    await click(page, 'Connect'); await ready(page, 'Approve'); wallet.delay = 700;
    await page.evaluate(() => { const b = document.querySelector('[data-testid="primary-action"]'); b.click(); b.click(); b.click(); });
    await ready(page, 'Swap'); assert.equal(wallet.sends.length, 1);
  });
});
await test('receipt status zero never reports completion; race outcome refreshes', async () => {
  await withDeal(async ({ w, id, page, wallet }) => {
    await click(page, 'Connect'); await click(page, 'Approve'); await ready(page, 'Swap');
    wallet.beforeSend = async () => { await w.deals.as(w.maker).cancel(id); };
    await click(page, 'Swap'); await status(page, 'cancelled'); await notice(page, 'reverted');
    assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Cancelled); await screenshot(page, 'race-recovery');
  });
});
await test('delayed receipt blocks resubmission and survives page reload', async () => {
  let hold = true;
  await withDeal(async ({ page, wallet }) => {
    await click(page, 'Connect'); await click(page, 'Approve');
    await page.waitForFunction(() => document.querySelector('#receipt')?.textContent.includes('Transaction:'));
    assert.equal(await button(page).isDisabled(), true); await page.reload(); await ready(page, 'Check transaction');
    assert.equal(wallet.sends.length, 1); hold = false;
    await click(page, 'Check transaction'); await ready(page, 'Swap'); assert.equal(wallet.sends.length, 1);
  }, { serverOptions: { rpcHook: async q => hold && q.method === 'eth_getTransactionReceipt' ? { jsonrpc: '2.0', id: q.id, result: null } : undefined } });
});
await test('maker cancels after expiry through secondary action', async () => {
  await withDeal(async ({ w, id, page }) => {
    const d = await w.deals.read.getDeal(id); await w.chain.setNextTime(Number(d.expiry)); await w.chain.mine();
    await page.reload(); await status(page, 'expired');
    // Terminal primary remains disabled; the secondary control allows maker management.
    await page.getByRole('button', { name: 'Connect to manage offer' }).click();
    await page.getByRole('button', { name: 'Cancel offer' }).waitFor();
    page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Cancel offer' }).click();
    await status(page, 'cancelled'); assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Cancelled);
  }, { walletAccount: 'maker' });
});
await test('runtime config is relative, nested links preserve folder, malformed ids do not throw', async () => {
  await withDeal(async ({ page, server }) => {
    await status(page, 'open'); await page.goto(server.url + '#/d/1e99'); await status(page, 'not-found');
  }, { serverOptions: { prefix: '/nested/app/' } });
});
await test('configuration/RPC chain mismatch fails closed', async () => {
  await withDeal(async ({ page, wallet }) => {
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    assert.match(await page.locator('.notice').innerText(), /different network/); assert.equal(wallet.sends.length, 0);
  }, { serverOptions: { config: { chainId: 1 } } });
});
await test('metadata injection is rendered as text with zero-decimal amounts', async () => {
  const w = await world(), t = await extraToken(w, '<img src=x onerror=alert(1)>', 0);
  await t.as(w.maker).approve(w.deals.address, 123n);
  await w.create(w.maker, await w.terms({ sellToken: t.address, sellAmount: 123n }));
  const server = await site(w), { page, context } = await browserPage(browser, server.url + '#/d/1');
  try {
    await status(page, 'open'); assert.equal(await page.getByTestId('receive-amount').innerText(), '123');
    assert.equal(await page.locator('img').count(), 0); assert.match(await page.getByTestId('receive-symbol').innerText(), /<img/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await context.close(); await server.close(); }
});
await test('zero-reset approval supports four-click fill and no-return token', async () => {
  const w = await world(), t = await extraToken(w);
  await w.create(w.maker, await w.terms({ buyToken: t.address, buyAmount: 500n })); await w.approve(w.maker, w.alfa, w.SELL);
  await t.as(w.taker).approve(w.deals.address, 1n); await t.as(w.deployer).setMode(11);
  const server = await site(w), wallet = testWallet(w), { page, context } = await browserPage(browser, server.url + '#/d/1', wallet);
  try {
    await click(page, 'Connect'); await click(page, 'Reset'); await click(page, 'Approve'); await ready(page, 'Swap');
    await t.as(w.deployer).setMode(2); await click(page, 'Swap'); await status(page, 'filled'); assert.equal(wallet.sends.length, 3);
  } finally { await context.close(); await server.close(); }
});
await test('new form validates precision, keeps inputs, creates nested link and supports copy fallback', async () => {
  const w = await world(), server = await site(w, { prefix: '/nested/app/' }), wallet = testWallet(w, w.maker);
  const { page, context } = await browserPage(browser, server.url + '#/new', wallet);
  try {
    const input = { 'sell-token': w.alfa.address, 'buy-token': w.bravo.address, 'sell-amount': '1.0000001', 'buy-amount': '0.125', taker: w.taker, 'expiry-hours': '48' };
    for (const [id, value] of Object.entries(input)) await page.getByTestId(id).fill(value);
    await notice(page, 'decimal places'); assert.equal(await button(page).isDisabled(), true);
    assert.equal(await page.getByTestId('sell-amount').inputValue(), '1.0000001');
    await page.getByTestId('sell-amount').fill('250.5'); await click(page, 'Connect'); await click(page, 'Approve'); await click(page, 'Create');
    const link = page.getByTestId('deal-link'); await link.waitFor(); assert.equal(await link.getAttribute('href'), server.url + '#/d/1');
    const d = await w.deals.read.getDeal(1); assert.equal(d.sellAmount, 250500000n); assert.equal(d.taker.toLowerCase(), w.taker);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true }));
    await page.getByRole('button', { name: 'Copy link' }).click(); assert.match(await page.locator('#copy-feedback').innerText(), /Copy the full link/);
    await screenshot(page, 'create-share');
  } finally { await context.close(); await server.close(); }
});
await test('transient RPC failure offers recovery without misreporting not-found', async () => {
  let fail = false;
  await withDeal(async ({ page }) => {
    await status(page, 'open'); fail = true; await click(page, 'Connect'); await notice(page, 'could not confirm');
    assert.equal(await page.getByTestId('deal-status').getAttribute('data-status'), 'open');
    fail = false; await page.getByRole('button', { name: 'Refresh status' }).click(); await ready(page, 'Approve');
  }, { serverOptions: { rpcHook: async q => fail ? { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'unavailable' } } : undefined } });
});
await test('unresponsive injected wallet does not prevent public deal reading', async () => {
  await withDeal(async ({ page, wallet }) => {
    const original = wallet.answer; wallet.answer = request => request.method === 'eth_accounts' ? new Promise(() => {}) : original(request);
    await page.reload(); await status(page, 'open');
    assert.equal(await page.getByTestId('pay-amount').innerText(), '0.75');
  });
});
await test('missing decimals never silently uses 18 or enables transactions', async () => {
  await withDeal(async ({ page, wallet }) => {
    await notice(page, 'Amounts will not be guessed'); assert.equal(wallet.sends.length, 0);
    assert.equal(await page.getByTestId('pay-amount').count(), 0); assert.equal(await button(page).isDisabled(), true);
  }, { serverOptions: { rpcHook: async q => q.method === 'eth_call' && q.params[0].data === '0x313ce567' ? { jsonrpc: '2.0', id: q.id, result: '0x' } : undefined } });
});
await test('false approval simulation prevents sending an approval transaction', async () => {
  const w = await world(), t = await extraToken(w);
  await w.create(w.maker, await w.terms({ buyToken: t.address, buyAmount: 500n })); await w.approve(w.maker, w.alfa, w.SELL);
  await t.as(w.deployer).setMode(13);
  const server = await site(w), wallet = testWallet(w), { page, context } = await browserPage(browser, server.url + '#/d/1', wallet);
  try { await click(page, 'Connect'); await click(page, 'Approve'); await notice(page, 'refused the approval'); assert.equal(wallet.sends.length, 0); }
  finally { await context.close(); await server.close(); }
});
await test('dropped transaction stays blocked; consumed nonce allows explicit replacement recovery', async () => {
  let phase = 'delay';
  await withDeal(async ({ page, wallet }) => {
    await click(page, 'Connect'); await click(page, 'Approve');
    await page.waitForFunction(() => Object.keys(sessionStorage).some(k => k.startsWith('otc-pending:') && JSON.parse(sessionStorage.getItem(k)).nonce !== undefined));
    phase = 'dropped'; await page.reload(); await ready(page, 'Check transaction');
    assert.equal(wallet.sends.length, 1); assert.equal(await page.getByRole('button', { name: 'Clear replaced transaction' }).count(), 0);
    phase = 'replaced'; await click(page, 'Check transaction'); await notice(page, 'nonce was used');
    page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Clear replaced transaction' }).click();
    await ready(page, 'Swap'); assert.equal(wallet.sends.length, 1);
  }, { serverOptions: { rpcHook: async q => {
    if (q.method === 'eth_getTransactionReceipt') return { jsonrpc: '2.0', id: q.id, result: null };
    if (phase !== 'delay' && q.method === 'eth_getTransactionByHash') return { jsonrpc: '2.0', id: q.id, result: null };
    if (q.method === 'eth_getTransactionCount') return { jsonrpc: '2.0', id: q.id, result: phase === 'replaced' ? '0x1' : '0x0' };
  } } });
});
await test('zero-decimal no-return creation, keyboard labels and mobile touch targets', async () => {
  const w = await world(), t = await extraToken(w, 'ZERO', 0); await t.as(w.deployer).setMode(2);
  const server = await site(w), wallet = testWallet(w, w.maker), { page, context } = await browserPage(browser, server.url + '#/new', wallet);
  try {
    const values = { 'sell-token': t.address, 'sell-amount': '123', 'buy-token': w.bravo.address, 'buy-amount': '0.125', taker: '', 'expiry-hours': '24' };
    for (const [id, value] of Object.entries(values)) { await page.getByTestId(id).fill(value); assert.equal(await page.locator(`label[for="${id}"]`).count(), 1); }
    await click(page, 'Connect'); await ready(page, 'Approve');
    await button(page).focus(); assert.equal(await button(page).evaluate(e => e === document.activeElement), true);
    assert((await button(page).boundingBox()).height >= 44);
    await page.keyboard.press('Enter'); await click(page, 'Create'); await page.getByTestId('deal-link').waitFor();
    assert.equal((await w.deals.read.getDeal(1)).sellAmount, 123n);
  } finally { await context.close(); await server.close(); }
});
await test('confirmed creation survives a failed follow-up read without creating a second offer', async () => {
  const w = await world(); let loseRead = false;
  const server = await site(w, { rpcHook: async q => loseRead && q.method === 'eth_call' && q.params[0].data.startsWith(w.deals.interface.getFunction('getDeal').selector) ? { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'temporary outage' } } : undefined });
  const wallet = testWallet(w, w.maker);
  wallet.beforeSend = async tx => { if (tx.data.startsWith(w.deals.interface.getFunction('createDeal').selector)) loseRead = true; };
  const { page, context } = await browserPage(browser, server.url + '#/new', wallet);
  try {
    for (const [id, value] of Object.entries({ 'sell-token': w.alfa.address, 'sell-amount': '250.5', 'buy-token': w.bravo.address, 'buy-amount': '0.125', taker: '', 'expiry-hours': '24' })) await page.getByTestId(id).fill(value);
    await click(page, 'Connect'); await click(page, 'Approve'); await click(page, 'Create'); await notice(page, 'transaction confirmed');
    assert.equal(wallet.sends.length, 2); await ready(page, 'Check transaction');
    loseRead = false; await page.reload(); await click(page, 'Check transaction'); await page.getByTestId('deal-link').waitFor();
    assert.equal(wallet.sends.length, 2); assert.equal((await w.deals.read.getDeal(2)).status, STATUS.None);
  } finally { await context.close(); await server.close(); }
});
await test('very large ids and uint64 expiry render without numeric rounding or overflow', async () => {
  const w = await world(); await w.offer({ expiry: (1n << 64n) - 1n });
  const server = await site(w), { page, context } = await browserPage(browser, server.url + '#/d/1');
  try {
    await status(page, 'open'); assert.match(await page.getByTestId('expires').innerText(), /18446744073709551615/);
    await page.goto(server.url + '#/d/' + ((1n << 256n) - 1n)); await status(page, 'not-found');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await context.close(); await server.close(); }
});
async function enterOffer(w, page) {
  for (const [field, value] of Object.entries({ 'sell-token': w.alfa.address, 'sell-amount': '1', 'buy-token': w.bravo.address, 'buy-amount': '2' })) {
    await page.getByTestId(field).fill(value);
  }
}

await test('regression: ambiguous creation survives reload and requires a matching wallet receipt', async () => {
  const w = await world(), server = await site(w), wallet = testWallet(w, w.maker);
  const answer = wallet.answer;
  let createdHash, approvalHash;
  wallet.answer = async request => {
    const reply = await answer(request);
    if (request.method === 'eth_sendTransaction') {
      assert.equal(request.params[0].chainId, '0x7a69');
      if (request.params[0].to.toLowerCase() === w.deals.address.toLowerCase()) {
        createdHash = reply.result;
        return { error: { code: -32000, message: 'Lost wallet response' } };
      }
      approvalHash = reply.result;
    }
    return reply;
  };
  const { page, context } = await browserPage(browser, server.url + '#/new', wallet);
  try {
    await enterOffer(w, page); await click(page, 'Connect'); await click(page, 'Approve'); await click(page, 'Create');
    await ready(page, 'Check transaction'); await page.reload(); await ready(page, 'Check transaction');
    const recover = page.getByRole('button', { name: 'Recover with wallet transaction hash' });
    page.once('dialog', d => d.accept(approvalHash)); await recover.click(); await notice(page, 'does not identify');
    await ready(page, 'Check transaction');
    page.once('dialog', d => d.accept(createdHash)); await recover.click();
    await page.getByRole('heading', { name: 'Your deal is live' }).waitFor();
    assert.equal(await page.getByTestId('deal-link').getAttribute('href'), server.url + '#/d/1');
    assert.equal(wallet.sends.length, 2); assert.equal((await w.deals.read.getDeal(2)).status, STATUS.None);
  } finally { await context.close(); await server.close(); }
});

await test('regression: unseen transaction allows another account and unrelated cancellation', async () => {
  let hiddenHash;
  await withDeal(async ({ page, w, wallet, id, server }) => {
    const second = await w.offer({}, w.taker);
    const answer = wallet.answer;
    wallet.answer = async request => {
      const reply = await answer(request);
      if (!hiddenHash && request.method === 'eth_sendTransaction') hiddenHash = reply.result;
      return reply;
    };
    await click(page, 'Connect'); await click(page, 'Approve'); await ready(page, 'Check transaction');
    wallet.account = w.other; await page.evaluate(a => window.__testEmit('accountsChanged', [a]), w.other);
    await ready(page, 'Approve');
    wallet.account = w.taker; await page.evaluate(a => window.__testEmit('accountsChanged', [a]), w.taker);
    await ready(page, 'Check transaction');
    await page.goto(server.url + '#/d/' + second);
    page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Cancel offer' }).click();
    await status(page, 'cancelled');
    await page.goto(server.url + '#/d/' + id); await ready(page, 'Check transaction');
    const hash = hiddenHash; hiddenHash = null;
    page.once('dialog', d => d.accept(hash));
    await page.getByRole('button', { name: 'Recover with wallet transaction hash' }).click();
    await ready(page, 'Swap');
    assert.equal(wallet.sends.length, 2);
  }, { serverOptions: { rpcHook: async q => hiddenHash && q.params[0] === hiddenHash && ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(q.method) ? { jsonrpc: '2.0', id: q.id, result: null } : undefined } });
});

await test('regression: metadata failure permits maker cancellation and displays terminal status', async () => {
  await withDeal(async ({ page, w, wallet, id, server }) => {
    await status(page, 'open'); await notice(page, 'Amounts will not be guessed');
    assert.equal(await page.getByTestId('pay-amount').count(), 0);
    await page.getByRole('button', { name: 'Connect to manage offer' }).click();
    page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Cancel offer' }).click();
    await status(page, 'cancelled'); await page.reload(); await status(page, 'cancelled');
    assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Cancelled);
    assert.equal(wallet.sends[0].chainId, '0x7a69');
    const filled = await w.offer(); await w.accept(filled);
    await page.goto(server.url + '#/d/' + filled); await status(page, 'filled');
    const expired = await w.offer(); await w.chain.setNextTime(Number((await w.deals.read.getDeal(expired)).expiry)); await w.chain.mine();
    await page.goto(server.url + '#/d/' + expired); await status(page, 'expired');
  }, { walletAccount: 'maker', serverOptions: { rpcHook: async q => q.method === 'eth_call' && q.params[0].data === '0x313ce567' ? { jsonrpc: '2.0', id: q.id, result: '0x' } : undefined } });
});

await test('regression: creation confirms on another route and its link survives navigation and reload', async () => {
  const w = await world(), first = await w.offer(), wallet = testWallet(w, w.maker);
  let hold = true;
  const server = await site(w, { rpcHook: async q => hold && q.method === 'eth_getTransactionReceipt' ? { jsonrpc: '2.0', id: q.id, result: null } : undefined });
  const { page, context } = await browserPage(browser, server.url + '#/new', wallet);
  try {
    await enterOffer(w, page); await click(page, 'Connect'); await click(page, 'Create');
    await page.waitForFunction(() => document.querySelector('#receipt')?.textContent.includes('Transaction:'));
    await page.goto(server.url + '#/d/' + first);
    await status(page, 'open'); await page.getByRole('button', { name: 'Cancel offer' }).waitFor();
    hold = false;
    await page.waitForFunction(() => Object.keys(sessionStorage).some(k => k.startsWith('otc-created:')));
    assert.equal(await page.getByTestId('deal-status').getAttribute('data-status'), 'open');
    await page.goto(server.url + '#/new'); await page.reload(); await page.getByTestId('deal-link').waitFor();
    assert.equal(await page.getByTestId('deal-link').getAttribute('href'), server.url + '#/d/2');
    assert.equal(wallet.sends.length, 1);
  } finally { await context.close(); await server.close(); }
});
console.log(`${count} adversarial browser tests passed.`);
} finally { await browser.close(); }
