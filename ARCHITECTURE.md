# otc.fam architecture

The site serves one private funded deal per link. Static JavaScript reads contract state over JSON-RPC without signing in; EIP-1193 handles wallet connection and transactions. `npm run build` copies `web/` to `dist/` without a bundler or runtime dependency.

## Version boundary

`IOtcDeals.sol` and `OtcDeals.sol` preserve the original no-fee interface, constructor and behavior. `/#/new` and `/#/d/<id>` use that ABI and the `contract` config key. Their test handles remain unchanged.

`IOtcDealsV2.sol` and `OtcDealsV2.sol` add an explicitly versioned API and one constructor argument, immutable `treasury`. `/#/v2/new` and `/#/v2/d/<id>` require the optional `contractV2` key. `app.js` creates a separate `ChainV2` for these routes. Old configuration shapes remain valid.

| Module | Responsibility |
| --- | --- |
| `eth.js` | Legacy ABI, token reads, wallet state, exact approvals, transaction simulation and receipts, shared error text |
| `eth-v2.js` | V2 tuple encoding, deal/grant decoding, event id and V2 errors |
| `vesting.js` | Pure BigInt fee, vesting and schedule calculations |
| `v2-new-deal-page.js` | Persistent form, token lookup, explicit delivery, exact economic preview, funding and private link |
| `v2-deal-page.js` | Read-only terms, settlement, grant timeline, permissionless beneficiary claims and receipts |
| `v2-ui.js` | UTC strings, fee facts, token warning and stable action updates |
| `units.js`, `ui.js` | Exact amount parsing/formatting and text-only DOM construction |

The legacy expiry node updates in place before comparing the rest of its card. The V2 grant shell stays mounted; polling writes its amount text and progress value directly. Claim button labels are stable while claimable amounts change. Actions read current page state, disable synchronously on a press and use a busy guard to prevent duplicate requests. On-chain checks remain authoritative across two tabs.

## V2 state and asset accounting

Deal ids and grant ids start at 1. Terms are immutable: seller, two tokens, explicit buyer, allocation A, payment Q, expiry, delivery mode and schedule. Deals transition `Funded → Settled` or `Funded → Cancelled`; neither terminal state can be replayed. Each vesting deal has at most one grant; immediate deals have grantId zero.

1. Creation pulls exactly A into the contract and records funded terms. No fees.
2. Settlement pulls Q plus floor(Q/200), pays the seller Q minus floor(Q/200), and pays the immutable treasury twice floor(Q/200). Immediate delivery transfers A to the buyer. New vesting assigns A already in the vault to a grant for that buyer.
3. Cancellation sends A back to the seller. Expiry prevents settlement, not refund.
4. Claims update total claimed before paying the beneficiary. Callers cannot choose another recipient.

All state-changing calls share a transient reentrancy lock. State and events are written before external token calls; any failure rolls back every effect, including allowance consumption, grant creation and fees. Pulls and pushes check sender and recipient balance deltas. The contract accepts ERC-20 calls returning true or no data. No external factory, arbitrary call path or administrator can remove grants.

The vault balance covers funded allocations plus unclaimed grant allocations. Grant creation needs no external transfer: custody stays in the same contract. A reverting seller or treasury payment cancels the entire settlement and leaves a funded allocation retryable or refundable. A failed claim leaves claimed and balances unchanged.

## Vesting arithmetic

Time is block.timestamp in seconds. A zero fixed start binds to the settlement block. Nonzero fixed starts must be future timestamps at both creation and settlement. Immediate schedules contain only zeros. Vesting requires duration > 0, cliffSeconds < durationSeconds and a representable uint64 end.

Before cliff, vested = 0. At/after cliff and before end, vested = floor(A×(t−start)/(end−start)); at/after end, vested = A. Claimable = vested−claimed and locked = A−vested. Accrual starts at start and the cliff releases that accrual.

`_mulDivTime` specializes overflow-safe multiplication/division to the bounded schedule. With n=t−start and d=end−start, 0≤n<d≤uint64.max. It computes `(A/d)*n + ((A%d)*n)/d`. The first product and total are at most A; the remainder product is below 2^128. Thus A can occupy all 256 bits without overflowing an intermediate product. Contract tests compare this decomposition with an independent unbounded BigInt product oracle.

## Runtime and boundaries

Solc 0.8.38, optimization with 200 runs, Cancun EVM. The browser has no private keys or backend. Deployment scripts read secrets from the environment only. Tests use a process-local EDR chain, local ERC-20 fixtures and Chromium. Browser screenshots are generated under ignored `screens/`.

Read polling pins V2 deal terms, grant accounting and on-chain time to one block, including during concurrent claims. Token metadata is untrusted and inserted as text. Exact decimals retain every raw unit. Existing positions, revocable rights, screenshots and URLs are refused before wallet approval. External adapters and broker shares are absent; the single treasury payout is the fee path for later extension.

Tokens that rebase, freeze accounts, lie about balances or change implementation remain unsupported risks. No rescue, upgrade or finality mechanism is provided. This is a local/testnet implementation, without an independent audit or production approval. A future broker-deal extension will need separately specified signed terms and receipts; it is not part of this API.
