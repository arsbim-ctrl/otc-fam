import { Chain, loadConfig, dealsABI, tokenABI, ZERO, same, address } from './chain.mjs';
import { parseAmount, formatAmount, durationSeconds, dealRoute } from './amounts.mjs';

const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const network = (id) => ({ 1: 'Ethereum', 8453: 'Base', 84532: 'Base Sepolia', 31337: 'Local network' }[id] ?? `Network ${id}`);
const fields = ['sell-token', 'sell-amount', 'buy-token', 'buy-amount', 'taker', 'expiry-hours'];
const state = { account: null, walletChain: null, busy: false, refreshing: false, epoch: 0, revision: 0,
  message: '', error: '', step: '', mode: 'wait', prepared: null, created: null };
const transactions = new Map(), creations = new Map(), receiptChecks = new Map();
let chain, config, timer, debounce;
const custody = '<div class="noncustody"><span class="shield" aria-hidden="true">◇</span><div><strong>Open offers do not reserve funds.</strong><br>Tokens stay in the maker’s wallet until the swap. Funds and approval must still be available.</div></div>';
const intro = (title, subtitle) => `<div class="intro"><p class="eyebrow">DIRECT WALLET-TO-WALLET TRADES</p><h1>${title}</h1><p>${subtitle}</p></div>`;
const actionArea = '<div id="notice" data-testid="notice" class="notice" role="status" aria-live="polite"></div><button id="primary" data-testid="primary-action" class="primary" disabled>Loading…</button><p id="hint" class="step-hint"></p><div id="secondary" class="actions-row"></div><div id="receipt" class="receipt"></div><div id="wallet" class="wallet-line"></div>';
const expiryText = (expiry) => expiry > 8640000000000n ? `Unix timestamp ${expiry}` : new Date(Number(expiry) * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
function timeLeft(expiry) {
  const seconds = expiry - BigInt(Math.max(Number(state.blockTime ?? 0), Math.floor(Date.now() / 1000)));
  if (seconds <= 0n) return 'Expired';
  if (seconds < 60n) return 'Less than a minute left';
  if (seconds < 3600n) { const n = seconds / 60n; return `${n} minute${n === 1n ? '' : 's'} left`; }
  if (seconds < 86400n) { const n = seconds / 3600n; return `${n} hour${n === 1n ? '' : 's'} left`; }
  const n = seconds / 86400n; return `${n} day${n === 1n ? '' : 's'} left`;
}
function dealState(d) {
  if (Number(d.status) === 0) return 'not-found';
  if (Number(d.status) === 2) return 'filled';
  if (Number(d.status) === 3) return 'cancelled';
  return BigInt(Math.max(Number(state.blockTime ?? 0), Math.floor(Date.now() / 1000))) >= d.expiry ? 'expired' : 'open';
}
function tokenPanel(label, amount, token, prefix, receive = false) {
  return `<div class="token-panel ${receive ? 'receive' : ''}"><p class="panel-label">${label}</p><div class="token-row"><span class="amount" data-testid="${prefix}-amount">${escape(formatAmount(amount, token.decimals))}</span><span class="symbol"><span class="coin" aria-hidden="true">${escape(token.symbol.slice(0, 1))}</span><span data-testid="${prefix}-symbol">${escape(token.symbol)}</span></span></div></div>`;
}
function details(d) {
  return `<dl class="details"><div class="detail"><dt>From</dt><dd class="address" data-testid="maker">${escape(d.maker)}</dd></div><div class="detail"><dt>For</dt><dd>${same(d.taker, ZERO) ? 'Anyone with this link' : `<span class="address">${escape(d.taker)}</span>`}</dd></div><div class="detail"><dt>Expires</dt><dd data-testid="expires" data-expiry="${d.expiry}">${escape(expiryText(d.expiry))}<br><span class="subtle">${escape(timeLeft(d.expiry))}</span></dd></div></dl>`;
}
function technical(d) {
  return `<details class="technical"><summary>Token & network details</summary><p>Symbols are not proof of identity. Verify these token addresses with the other person. Transfer-tax and rebasing transfers are not supported.</p><p>Sell token</p><div class="address">${escape(d.sellToken)}</div><p>Buy token</p><div class="address">${escape(d.buyToken)}</div><p>${escape(network(config.chainId))} · Chain ${config.chainId}</p><div class="address">Deal contract: ${escape(config.contract)}</div><p>Do not send tokens to the deal contract. There is no recovery administrator.</p></details>`;
}
function renderDeal() {
  const detailsOpen = $('.technical')?.open;
  const focused = document.activeElement?.id;
  const d = state.deal, status = dealState(d);
  const title = { open: 'Review your swap', filled: 'Deal completed', cancelled: 'Deal cancelled', expired: 'Deal expired', 'not-found': 'Deal not found' }[status];
  const description = { open: 'Exact amounts. Both sides swap together.', filled: 'The swap has been completed.', cancelled: 'The maker withdrew this offer.', expired: 'The time to accept this offer has passed.', 'not-found': 'Check the link with the person who sent it.' }[status];
  $('#app').innerHTML = intro(title, description) + `<section class="card"><div class="card-head"><h2>Deal #${escape(state.route.id ?? '—')}</h2><span data-testid="deal-status" data-status="${status}" class="badge ${status === 'open' || status === 'filled' ? '' : 'neutral'}">${{ open: 'Open', filled: 'Completed', cancelled: 'Cancelled', expired: 'Expired', 'not-found': 'Not found' }[status]}</span></div>` +
    (status === 'not-found' ? '<div class="empty"><p>There is no deal at this address.<br>Ask the maker for the complete link.</p><a href="#/new">Create a new deal</a></div>' :
      (state.buy && state.sell ? tokenPanel('You pay', d.buyAmount, state.buy, 'pay') + '<div class="exchange" aria-hidden="true"><span>↓</span></div>' + tokenPanel('You receive', d.sellAmount, state.sell, 'receive', true) : '<p>Token amounts are unavailable.</p>') + details(d) +
      (status === 'open' ? custody : `<p class="status-message">${status === 'filled' ? 'This deal is finished and cannot be filled again.' : status === 'cancelled' ? 'This offer is no longer available. Cancelling did not transfer or lock any tokens.' : 'This offer can no longer be filled. The maker’s tokens were never locked.'}</p>`)) + actionArea + (status === 'not-found' ? '' : technical(d)) + '</section>';
  bindActions();
  if ($('.technical')) $('.technical').open = Boolean(detailsOpen);
  if (focused && document.getElementById(focused)) document.getElementById(focused).focus({ preventScroll: true });
}
function renderForm() {
  const panel = (side, title, placeholder) => `<div class="token-panel ${side === 'buy' ? 'receive' : ''}"><div class="field"><label for="${side}-amount" class="panel-label">${title}</label><input id="${side}-amount" class="amount-input" data-testid="${side}-amount" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-describedby="${side}-meta"></div><div class="field"><label for="${side}-token" class="subtle">Token contract address</label><input id="${side}-token" class="token-input" data-testid="${side}-token" autocomplete="off" spellcheck="false" placeholder="${placeholder}"></div><div id="${side}-meta" class="form-meta">Enter a token address to load its details.</div></div>`;
  $('#app').innerHTML = intro('Make it a deal.', 'Set your terms. Share a link. Swap directly.') + `<section class="card"><div class="card-head"><h2>New deal</h2><span class="badge neutral">No platform fee</span></div><form id="deal-form" novalidate>${panel('sell', 'You give', '0x… sell token')}<div class="exchange" aria-hidden="true"><span>↓</span></div>${panel('buy', 'You receive', '0x… buy token')}<div class="form-options"><div class="field"><label for="taker">Who can accept? <span class="subtle">Optional</span></label><input id="taker" data-testid="taker" placeholder="Anyone, or enter a wallet address" autocomplete="off" spellcheck="false"><p class="help">Leave empty for anyone. A reserved address limits who can fill; the terms are still public.</p></div><div class="field"><label for="expiry-hours">Offer expires in</label><input id="expiry-hours" data-testid="expiry-hours" inputmode="decimal" value="24" aria-describedby="expiry-help"><p id="expiry-help" class="help">Hours from creation. Cancel at any time before it is filled.</p></div></div></form>${custody}${actionArea}</section>`;
  $('#deal-form').addEventListener('submit', e => e.preventDefault());
  $('#deal-form').addEventListener('input', (event) => {
    state.revision++; state.prepared = null; state.error = ''; state.message = ''; state.mode = 'wait';
    if (event.target.id.endsWith('-token')) $(`#${event.target.id.split('-')[0]}-meta`).textContent = 'Checking token details…';
    event.target.removeAttribute('aria-invalid'); event.target.classList.remove('invalid');
    if (document.getElementById(event.target.id + '-error')) document.getElementById(event.target.id + '-error').hidden = true;
    updateActions(); clearTimeout(debounce); debounce = setTimeout(() => refresh(), 300);
  });
  bindActions();
}
function renderCreated() {
  const { id, deal, sell, buy } = state.created;
  const link = new URL(location.href); link.hash = `/d/${id}`;
  $('#app').innerHTML = intro('Ready to share.', 'Your terms are on-chain. Send the link.') + `<section class="card"><div class="success-icon" aria-hidden="true">✓</div><h2 class="success-title">Your deal is live</h2><p class="step-hint">Share this link with the person you want to trade with.</p><a class="share-link" data-testid="deal-link" href="${escape(link.href)}">${escape(link.href)}</a><div class="actions-row"><button id="copy" class="secondary">Copy link</button><a class="secondary" href="${escape(link.href)}">Open deal</a></div><dl class="details"><div class="detail"><dt>You give</dt><dd>${escape(formatAmount(deal.sellAmount, sell.decimals))} ${escape(sell.symbol)}</dd></div><div class="detail"><dt>You receive</dt><dd>${escape(formatAmount(deal.buyAmount, buy.decimals))} ${escape(buy.symbol)}</dd></div><div class="detail"><dt>Expires</dt><dd>${escape(expiryText(deal.expiry))}</dd></div></dl>${custody}<p class="subtle">Keep the sell tokens and approval available until the deal is filled. Other offers use the same wallet balance and allowance.</p><p id="copy-feedback" class="step-hint" role="status" aria-live="polite"></p></section>`;
  $('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText(link.href); $('#copy-feedback').textContent = 'Link copied. Ready to send.'; }
    catch { $('#copy-feedback').textContent = 'Copy the full link above to share your deal.'; }
  };
}
function bindActions() {
  $('#primary').onclick = () => act();
}
function setMode(mode, label, hint = '') { state.mode = mode; state.label = label; state.hint = hint; }
function updateActions() {
  if (!$('#primary')) return;
  const primary = $('#primary');
  primary.disabled = state.busy || state.refreshing || ['wait', 'blocked', 'terminal'].includes(state.mode);
  primary.textContent = state.busy ? state.step || 'Please wait…' : state.refreshing ? 'Checking the latest state…' : state.label || 'Complete deal details';
  $('#hint').textContent = state.hint || '';
  const notice = $('#notice');
  notice.textContent = state.error || state.message;
  notice.className = `notice${state.error ? ' error' : ''}`;
  $('#wallet').textContent = state.account ? `${short(state.account)} · ${network(state.walletChain)}${state.walletChain !== config.chainId ? ' (wrong network)' : ''}` : '';
  const pending = currentPending();
  if (pending) $('#receipt').textContent = pending.hash ? `Transaction: ${pending.hash}` : 'Wallet submission outcome unknown. Verify the transaction in your wallet.';
  else if (state.lastReceipt && matchesPage(state.lastReceipt)) $('#receipt').innerHTML = `<details><summary>${escape({ approve: 'Approval', reset: 'Approval reset', fill: 'Swap', cancel: 'Cancellation', create: 'Deal creation' }[state.lastReceipt.kind])} confirmed · details</summary><p>${escape(state.lastReceipt.hash)}</p></details>`;
  else $('#receipt').replaceChildren();
  if (state.route.kind === 'new') {
    const saved = [...creations.values()].filter(r => same(r.account, state.account));
    for (const receipt of saved) {
      const link = document.createElement('a'), url = new URL(location.href);
      url.hash = '/d/' + receipt.id; link.href = url.href;
      if (receipt === saved.at(-1)) link.dataset.testid = 'deal-link';
      link.textContent = `Created deal #${receipt.id} · share link`;
      const row = document.createElement('p'); row.append(link); $('#receipt').append(row);
    }
  }
  const secondary = $('#secondary'); secondary.replaceChildren();
  if (!state.busy && !state.refreshing) {
    if (pending?.kind !== 'cancel' && state.deal && same(state.account, state.deal.maker) && Number(state.deal.status) === 1) {
      const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = state.walletChain !== config.chainId ? 'Switch network to cancel' : 'Cancel offer';
      cancel.onclick = () => { if (state.walletChain !== config.chainId) act('switch'); else if (window.confirm('Cancel this offer? It will no longer be fillable. Your funds stay in your wallet; token approvals are unchanged.')) act('cancel'); };
      secondary.append(cancel);
    }
    if (window.ethereum && !state.account && state.deal && Number(state.deal.status) === 1 && (dealState(state.deal) === 'expired' || !state.sell || !state.buy)) {
      const connect = document.createElement('button'); connect.className = 'secondary'; connect.textContent = 'Connect to manage offer'; connect.onclick = () => act('connect'); secondary.append(connect);
    }
    if (state.error || (state.mode === 'blocked' && window.ethereum) || pending) {
      const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = 'Refresh status'; retry.onclick = () => refresh(); secondary.append(retry);
    }
    if (!window.ethereum && state.deal && Number(state.deal.status) === 1 && dealState(state.deal) === 'open') {
      const copy = document.createElement('button'); copy.className = 'secondary'; copy.textContent = 'Copy link for your wallet';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(location.href); state.message = 'Link copied. Open it in your wallet app’s browser.'; } catch { state.message = 'Copy this page’s address from your browser, then open it in your wallet app’s browser.'; } updateActions(); }; secondary.append(copy);
    }
    if (pending && state.mode === 'terminal') {
      const check = document.createElement('button'); check.className = 'secondary'; check.textContent = 'Check pending transaction'; check.onclick = () => act('pending'); secondary.append(check);
    }
    if (pending && !pending.confirmed && (pending.unseen || !pending.hash || pending.replaced) && !pending.sending && !receiptChecks.has(pending)) {
      const recover = document.createElement('button'); recover.className = 'secondary'; recover.textContent = 'Recover with wallet transaction hash';
      recover.onclick = () => act('recover'); secondary.append(recover);
      const clear = document.createElement('button'); clear.className = 'secondary'; clear.textContent = pending.replaced ? 'Clear replaced transaction' : 'Resolve from wallet activity';
      clear.onclick = () => { if (window.confirm('Check this account’s activity on the deal network. Only continue if the wallet confirms the request was never sent, failed, or was permanently cancelled. A missing transaction is inconclusive. If it succeeded, recover with its hash. Have you verified that it cannot complete?')) { forgetPending(pending); refresh(); } };
      secondary.append(clear);
    }
  }
  for (const id of fields) if ($(`#${id}`)) $(`#${id}`).disabled = Boolean(state.busy || (pending && matchesPage(pending)));
}
async function walletState() {
  if (!window.ethereum) return { account: null, walletChain: null };
  let timeout;
  try {
    const [accounts, id] = await Promise.race([
      Promise.all([window.ethereum.request({ method: 'eth_accounts' }), window.ethereum.request({ method: 'eth_chainId' })]),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Wallet unavailable')), 2000); }),
    ]);
    return { account: accounts[0] ? address(accounts[0]) : null, walletChain: Number(BigInt(id)) };
  } catch { return { account: null, walletChain: null }; }
  finally { clearTimeout(timeout); }
}
async function prepareForm() {
  const values = Object.fromEntries(fields.map(id => [id, $(`#${id}`).value.trim()]));
  if (!values['sell-token'] || !values['buy-token'] || !values['sell-amount'] || !values['buy-amount']) return null;
  let sellToken, buyToken, taker;
  try { sellToken = address(values['sell-token']); buyToken = address(values['buy-token']); taker = values.taker ? address(values.taker) : ZERO; }
  catch { throw new Error('Enter complete 0x token and wallet addresses. Check mixed-case address spelling.'); }
  if (same(sellToken, buyToken)) throw new Error('Choose two different tokens for this deal.');
  if (same(taker, config.contract)) throw new Error('The deal contract cannot accept your offer. Enter the other person’s wallet address.');
  const [sell, buy] = await Promise.all([chain.token(sellToken), chain.token(buyToken)]);
  const validated = (field, parse) => { try { return parse(); } catch (e) { throw Object.assign(e, { field }); } };
  return { sellToken, buyToken, sell, buy, sellAmount: validated('sell-amount', () => parseAmount(values['sell-amount'], sell.decimals)),
    buyAmount: validated('buy-amount', () => parseAmount(values['buy-amount'], buy.decimals)), taker,
    duration: validated('expiry-hours', () => durationSeconds(values['expiry-hours'])) };
}
async function refresh() {
  if (!chain || state.busy) return;
  const revision = state.revision, epoch = state.epoch;
  state.refreshing = true; updateActions();
  try {
    const wallet = await walletState();
    if (epoch !== state.epoch || revision !== state.revision) return;
    Object.assign(state, wallet);
    let prepared, d, sell, buy, blockTime, metadataError;
    if (state.route.kind === 'deal') {
      [d, blockTime] = await Promise.all([chain.deal(state.route.id), chain.now()]);
      if (Number(d.status) !== 0) {
        try { [sell, buy] = await Promise.all([chain.token(d.sellToken), chain.token(d.buyToken)]); }
        catch (error) { metadataError = friendly(error); }
      }
    } else if (state.route.kind === 'new' && !state.created && ![...transactions.values()].some(matchesPage)) prepared = await prepareForm();
    else if (state.route.kind === 'missing') d = { status: 0n };
    if (epoch !== state.epoch || revision !== state.revision) return;
    if (blockTime !== undefined) state.blockTime = blockTime;
    state.error = metadataError || ''; state.message = '';
    if (d) { state.deal = d; state.sell = sell; state.buy = buy; renderDeal(); }
    if (state.created) return;
    state.prepared = prepared;
    if (prepared) {
      for (const side of ['sell', 'buy']) $(`#${side}-meta`).textContent = `${prepared[side].symbol} · ${prepared[side].decimals} decimals`;
      for (const id of fields) { $(`#${id}`).removeAttribute('aria-invalid'); $(`#${id}`).classList.remove('invalid'); if (document.getElementById(id + '-error')) document.getElementById(id + '-error').hidden = true; }
    }
    if (d && dealState(d) !== 'open') { setMode('terminal', { filled: 'Deal completed', cancelled: 'Offer cancelled', expired: 'Offer expired', 'not-found': 'Deal not found' }[dealState(d)]); return; }
    if (currentPending()) {
      setMode('pending', 'Check transaction', 'Check this transaction in your wallet before repeating it.'); return;
    }
    if (metadataError) { setMode('blocked', 'Token details unavailable'); return; }
    if (!window.ethereum) { setMode('blocked', 'Open in a wallet browser', 'You can read this deal without a wallet. To transact, open this link in a browser with an Ethereum wallet.'); return; }
    if (!state.account) { setMode('connect', 'Connect wallet', 'Connecting lets you check your balance. It does not move tokens.'); return; }
    if (d && !same(d.taker, ZERO) && !same(d.taker, state.account)) {
      state.message = `This deal is reserved for ${d.taker}. Switch to that wallet to accept it.`; setMode('blocked', 'Reserved for another wallet'); return;
    }
    if (state.walletChain !== config.chainId) { setMode('switch', `Switch to ${network(config.chainId)}`, 'Your wallet must be on the same network as this deal.'); return; }
    if (d && same(d.maker, state.account)) {
      state.message = 'You made this offer. Share the link with the other side, or cancel it below.'; setMode('blocked', 'Your offer'); return;
    }
    if (!d && !prepared) { setMode('wait', 'Complete deal details', 'Enter both token addresses and exact amounts.'); return; }
    if (d) {
      const [balance, allowance] = await Promise.all([chain.balance(d.sellToken, d.maker), chain.allowance(d.sellToken, d.maker)]);
      if (balance < d.sellAmount || allowance < d.sellAmount) { state.message = 'The maker needs to restore their token balance or approval. Open offers do not reserve funds. Refresh after they update their wallet.'; setMode('blocked', 'Waiting for the maker'); return; }
    }
    const token = d ? buy : prepared.sell, amount = d ? d.buyAmount : prepared.sellAmount;
    const [balance, allowance] = await Promise.all([chain.balance(token.address, state.account), chain.allowance(token.address, state.account)]);
    if (epoch !== state.epoch || revision !== state.revision) return;
    if (balance < amount) { state.message = `You need ${formatAmount(amount, token.decimals)} ${token.symbol}. Your balance is ${formatAmount(balance, token.decimals)}. Add funds to this wallet, then refresh.`; setMode('blocked', 'Insufficient token balance'); return; }
    state.approval = { token, amount, allowance };
    if (allowance < amount) {
      setMode(allowance > 0n ? 'reset' : 'approve', allowance > 0n ? `Reset ${token.symbol} approval` : `Approve ${formatAmount(amount, token.decimals)} ${token.symbol}`,
        allowance > 0n ? 'First reset the old limit to zero. Next, approve only the amount this deal needs.' : 'Approve only this amount. The swap or creation is a separate transaction.');
    } else if (d) setMode('fill', `Swap ${formatAmount(d.buyAmount, buy.decimals)} ${buy.symbol}`, `You receive ${formatAmount(d.sellAmount, sell.decimals)} ${sell.symbol}. Both transfers complete together, or neither does.`);
    else setMode('create', 'Create deal & get link', 'Your tokens stay in your wallet. Keep funds and approval available until someone fills.');
  } catch (error) {
    if (epoch !== state.epoch || revision !== state.revision) return;
    state.error = friendly(error); setMode('blocked', 'Review the details');
    const field = error.field && document.getElementById(error.field);
    if (field) {
      field.setAttribute('aria-invalid', 'true'); field.classList.add('invalid');
      const id = error.field + '-error'; let message = document.getElementById(id);
      if (!message) { message = document.createElement('p'); message.id = id; message.className = 'field-error'; field.after(message); field.setAttribute('aria-describedby', `${field.getAttribute('aria-describedby') || ''} ${id}`.trim()); }
      message.textContent = state.error; message.hidden = false;
    }
    if (!$('#primary')) {
      $('#app').innerHTML = intro('Let’s try that again.', 'Your wallet has not been charged by this page.') + `<section class="card">${actionArea}</section>`; bindActions();
    }
  } finally {
    if (epoch === state.epoch && revision === state.revision) { state.refreshing = false; $('#app').setAttribute('aria-busy', 'false'); updateActions(); }
  }
}
function friendly(error) {
  if (Number(error.code) === 4001 || error.code === 'ACTION_REJECTED') return 'You declined the wallet request. Nothing new was submitted. Review the details and try again when ready.';
  if (Number(error.code) === 4902) return `Add ${network(config.chainId)} (chain ${config.chainId}) in your wallet, then try switching again.`;
  if (error.message?.startsWith('The transaction reverted.')) return error.message;
  if (error.rpcError) return 'The network could not confirm this request. Refresh to check balances, approvals and whether the offer is still open.';
  if (/revert|insufficient funds|estimateGas/i.test(error.message ?? '')) return 'The transaction could not complete. Check gas funds, token balances, approvals and whether the offer is still open, then refresh. No partial swap is kept.';
  if (error.code === 'BAD_DATA' || error.code === 'INVALID_ARGUMENT') return 'Token data could not be read. Check the token address and network. Amounts will not be guessed.';
  return String(error.message || 'Something went wrong. Refresh and try again.').slice(0, 350);
}
function storageKey() { return `otc-pending:${config.chainId}:${config.contract.toLowerCase()}`; }
function historyKey() { return `otc-created:${config.chainId}:${config.contract.toLowerCase()}`; }
function matchesPage(tx) {
  return same(tx.account, state.account) && (tx.deal === undefined
    ? state.route.kind === 'new' : state.route.kind === 'deal' && tx.deal === String(state.route.id));
}
function currentPending() {
  const own = [...transactions.values()].find(matchesPage);
  if (own) return own;
  const token = state.route.kind === 'deal' ? state.deal?.buyToken : state.prepared?.sellToken;
  for (const tx of transactions.values()) {
    if (token && same(tx.account, state.account) && ['approve', 'reset'].includes(tx.kind) && same(tx.to, token)) return tx;
  }
}
function savePending(tx) {
  const { sending, ...record } = tx;
  sessionStorage.setItem(tx.key, JSON.stringify(record));
  transactions.set(tx.key, tx);
}
function forgetPending(tx) { sessionStorage.removeItem(tx.key); transactions.delete(tx.key); }
function loadTransactions() {
  const prefix = storageKey();
  for (const key of Object.keys(sessionStorage)) {
    if (key !== prefix && !key.startsWith(prefix + ':')) continue;
    try {
      const tx = JSON.parse(sessionStorage.getItem(key));
      if (tx?.account && ['approve', 'reset', 'fill', 'cancel', 'create'].includes(tx.kind)) transactions.set(key, { ...tx, key });
    } catch { /* Ignore an unreadable record. */ }
  }
  for (const receipt of JSON.parse(sessionStorage.getItem(historyKey()) || '[]')) creations.set(receipt.hash, receipt);
}
async function checkContext(account, epoch) {
  const [accounts, id] = await Promise.all([window.ethereum.request({ method: 'eth_accounts' }), window.ethereum.request({ method: 'eth_chainId' })]);
  if (epoch !== state.epoch || !same(accounts[0], account) || Number(BigInt(id)) !== config.chainId) throw new Error('The wallet, network or page changed. Review the current details before trying again.');
}
async function recoverHash(pending) {
  const input = window.prompt('Paste the confirmed transaction hash from this account’s wallet activity on the deal network.');
  if (input === null) return false;
  const hash = input.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Enter the full transaction hash from your wallet.');
  const tx = await chain.rpc('eth_getTransactionByHash', [hash]);
  const matchesCall = pending.data ? tx && same(tx.to, pending.to) && same(tx.input, pending.data) : same(hash, pending.hash);
  if (!tx?.blockHash || !same(tx.from, pending.account) || !matchesCall ||
      (pending.nonce !== undefined && BigInt(tx.nonce) !== BigInt(pending.nonce))) {
    throw new Error('This hash does not identify the confirmed wallet transaction for this action.');
  }
  pending.hash = hash; pending.nonce = tx.nonce; pending.replaced = false;
  savePending(pending);
  return true;
}
async function waitForReceipt(pending) {
  if (!pending.hash) throw new Error('Check your wallet activity. Recover a confirmed transaction with its hash.');
  if (!receiptChecks.has(pending)) {
    receiptChecks.set(pending, pollReceipt(pending).finally(() => receiptChecks.delete(pending)));
  }
  return receiptChecks.get(pending);
}
async function pollReceipt(pending) {
  const until = Date.now() + 90_000;
  while (transactions.has(pending.key) && Date.now() < until) {
    const receipt = await chain.rpc('eth_getTransactionReceipt', [pending.hash]);
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) {
        forgetPending(pending);
        throw new Error('The transaction reverted. No partial swap was kept. Network gas may have been spent. Refresh the offer and try again.');
      }
      state.lastReceipt = pending;
      if (pending.kind === 'create') {
        pending.confirmed = true; savePending(pending);
        const event = receipt.logs.filter(l => same(l.address, config.contract)).map(l => { try { return dealsABI.parseLog(l); } catch { return null; } }).find(e => e?.name === 'DealCreated' && same(e.args.maker, pending.account));
        if (!event) throw new Error('The transaction confirmed, but its deal could not be identified. Check the transaction in your wallet before creating another.');
        const id = event.args.id.toString();
        creations.set(pending.hash, { id, account: pending.account, hash: pending.hash });
        sessionStorage.setItem(historyKey(), JSON.stringify([...creations.values()]));
        if (matchesPage(pending)) {
          const deal = await chain.deal(id);
          const [sell, buy] = await Promise.all([chain.token(deal.sellToken), chain.token(deal.buyToken)]);
          if (matchesPage(pending)) { state.created = { id, deal, sell, buy }; renderCreated(); }
        }
      }
      forgetPending(pending);
      return;
    }
    const transaction = await chain.rpc('eth_getTransactionByHash', [pending.hash]);
    if (transaction?.nonce && same(transaction.from, pending.account)) { pending.nonce = transaction.nonce; savePending(pending); }
    if (!transaction) {
      pending.unseen = true; savePending(pending);
      if (pending.nonce === undefined) throw new Error('The network cannot find this transaction. Check its outcome in your wallet.');
      const used = await chain.rpc('eth_getTransactionCount', [pending.account, 'latest']);
      if (BigInt(used) > BigInt(pending.nonce)) {
        pending.replaced = true; savePending(pending);
        throw new Error('The original transaction is unavailable and its nonce was used. Check the replacement or cancellation in your wallet.');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw new Error('Still waiting for confirmation. Check its status or inspect it in your wallet.');
}
async function act(forced) {
  if (state.busy || state.refreshing || (!forced && ['wait', 'blocked', 'terminal'].includes(state.mode))) return;
  const mode = forced || state.mode, epoch = state.epoch, account = state.account;
  const prepared = state.prepared, approval = state.approval, route = state.route;
  const action = {}; state.busy = action; state.error = ''; state.message = ''; state.step = 'Confirm in your wallet…'; updateActions();
  let failure, pending = currentPending();
  try {
    if (mode === 'connect') { await window.ethereum.request({ method: 'eth_requestAccounts' }); return; }
    if (mode === 'switch') { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + config.chainId.toString(16) }] }); return; }
    if (mode === 'recover' && !await recoverHash(pending)) return;
    if (mode === 'pending' || mode === 'recover') { state.step = 'Checking confirmation…'; updateActions(); await waitForReceipt(pending); return; }
    if (pending && (mode !== 'cancel' || pending.kind === 'cancel')) throw new Error('Check your pending transaction before sending another.');
    await checkContext(account, epoch);
    let to = config.contract, data;
    if (mode === 'approve' || mode === 'reset') { to = approval.token.address; data = tokenABI.encodeFunctionData('approve', [config.contract, mode === 'reset' ? 0n : approval.amount]); }
    else if (mode === 'create') {
      const expiry = await chain.now() + prepared.duration;
      data = dealsABI.encodeFunctionData('createDeal', [prepared.sellToken, prepared.sellAmount, prepared.buyToken, prepared.buyAmount, prepared.taker, expiry]);
    } else if (mode === 'fill' || mode === 'cancel') data = dealsABI.encodeFunctionData(mode, [route.id]);
    else return;
    const tx = { from: account, to, data };
    // Simulate the exact call. State can still change before mining; the contract is authoritative.
    const result = await chain.rpc('eth_call', [tx, 'latest']);
    if ((mode === 'approve' || mode === 'reset') && result !== '0x' && !tokenABI.decodeFunctionResult('approve', result)[0]) throw new Error('This token refused the approval. Check the token with the maker.');
    await checkContext(account, epoch);
    const key = `${storageKey()}:${account.toLowerCase()}:${route.id ?? 'new'}:${mode}`;
    if (transactions.has(key)) throw new Error('Check the existing transaction for this action in your wallet.');
    pending = { key, kind: mode, account, deal: route.id?.toString(), to, data, sending: true };
    // Write before handing control to the wallet. A reload or lost response must retain this intent.
    savePending(pending);
    try {
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ ...tx, chainId: '0x' + config.chainId.toString(16) }] });
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('The wallet did not return a transaction id. Check its activity.');
      pending.hash = hash; savePending(pending);
    } catch (error) {
      if (Number(error.code) === 4001 || error.code === 'ACTION_REJECTED') forgetPending(pending);
      throw error;
    } finally { pending.sending = false; }
    if (state.busy === action) { state.step = 'Waiting for confirmation…'; updateActions(); }
    await waitForReceipt(pending);
  } catch (error) {
    failure = pending?.confirmed ? 'The transaction confirmed, but its deal could not be loaded yet. Check transaction to recover the link; do not create another offer.'
      : mode !== 'recover' && pending && transactions.has(pending.key) && !pending.replaced
      ? 'Confirmation is not yet known. This transaction may still complete. Check its status or activity in your wallet before sending another.'
      : friendly(error);
  }
  finally {
    if (state.busy === action) {
      state.busy = false; state.step = ''; state.refreshing = false;
      if (!state.created) await refresh();
      if (failure && epoch === state.epoch) { state.error = failure; updateActions(); }
    } else if (!state.busy && !state.created) await refresh();
  }
}
async function routeChanged() {
  clearTimeout(debounce); state.epoch++; state.revision++; state.busy = false; state.refreshing = false;
  state.route = dealRoute(location.hash); state.deal = null; state.created = null; state.prepared = null; state.error = ''; state.message = ''; state.mode = 'wait';
  if (state.route.kind === 'new') renderForm();
  else $('#app').innerHTML = intro('One deal. One link.', 'A simple way to agree, share and swap.') + '<section class="card loading"><span class="spinner"></span><p>Reading the deal from the chain…</p></section>';
  await refresh();
}
const changed = () => { state.epoch++; state.busy = false; state.refreshing = false; state.account = null; state.prepared = null; state.approval = null; if (state.created) { state.created = null; renderForm(); } refresh(); };
async function start() {
  try {
    config = await loadConfig(); chain = new Chain(config);
    if (Number(BigInt(await chain.rpc('eth_chainId'))) !== config.chainId) throw new Error('The configured RPC is on a different network. Ask the site operator to correct config.json.');
    if (await chain.rpc('eth_getCode', [config.contract, 'latest']) === '0x') throw new Error('No deal contract is deployed at the configured address.');
    try { loadTransactions(); } catch { /* Public deal reading also works without session storage. */ }
    window.addEventListener('hashchange', routeChanged);
    window.ethereum?.on?.('accountsChanged', changed); window.ethereum?.on?.('chainChanged', changed); window.ethereum?.on?.('disconnect', changed);
    await routeChanged();
    timer = setInterval(() => { if (!state.busy && !state.refreshing && state.route.kind === 'deal' && !currentPending()) refresh(); }, 10_000);
  } catch (error) {
    $('#app').innerHTML = intro('A little connection trouble.', 'Your funds stay in your wallet.') + `<section class="card"><p class="notice error" role="alert">${escape(friendly(error))}</p><button class="primary" id="reload">Try again</button></section>`;
    $('#reload').onclick = () => location.reload(); $('#app').setAttribute('aria-busy', 'false');
  }
}
window.addEventListener('pagehide', () => { clearInterval(timer); clearTimeout(debounce); for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) window.ethereum?.removeListener?.(event, changed); });
start();
