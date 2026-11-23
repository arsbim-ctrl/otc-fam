# otc.fam

One private link for one funded OTC token deal. A seller escrows an allocation, shares its link, and the buyer checks the terms before settling from a wallet. This repository is for local and testnet use. No contract is deployed by default; the contracts have not been independently audited.

## Setup

Node.js 22 or later, on an EVM supporting Cancun (EIP-1153 transient storage).

```sh
npm ci
npx playwright install chromium
npm test
node .launchpad/checks/round-1/run.mjs
npm run build
python3 -m http.server -d dist 8080
```

`npm run build` copies the dependency-free static files from `web/` into `dist/`. The compiler, local EDR chain and browser tests use pinned development dependencies in `package-lock.json`. After installing dependencies and Chromium, tests and builds need no external service. The browser reads JSON-RPC directly and writes through an EIP-1193 wallet.

Edit `web/config.json`, then rebuild:

```json
{
  "chainId": 84532,
  "contract": "0x0000000000000000000000000000000000000000",
  "contractV2": "0x0000000000000000000000000000000000000000",
  "rpcUrl": "https://sepolia.base.org"
}
```

Use deployed addresses for your selected test network and a public RPC endpoint without credentials. `contractV2` is optional; the original `{ chainId, contract, rpcUrl }` configuration still supports legacy pages. Zero addresses are unconfigured placeholders. No deployment or network switching happens automatically.

## Versions and links

| Version | Create | Private deal | Contract |
| --- | --- | --- | --- |
| Legacy v1 | `/#/new` | `/#/d/<id>` | `OtcDeals`, unchanged, no fee |
| v2 | `/#/v2/new` | `/#/v2/d/<id>` | `OtcDealsV2`, immediate or new vesting, explicit buyer |

A link carries only its version and id. All economic terms come from the configured on-chain contract, without a wallet. There is no listing or order book. Links identify deals, not authorization secrets: only the designated wallet can settle a V2 deal. Anyone who knows a link can inspect it.

Amounts are raw integers in the contracts and exact decimal strings in the page. Token symbols are untrusted; compare the complete token addresses. The seller approves exactly the allocation; the buyer approves exactly the payment including the buyer fee. The form requires at least one minute to expiry and permits up to 8760 hours. Expiry is computed from the latest block when funding is requested.

## V2 fees and delivery

For raw quote amount `Q`, buyer and seller fees each equal `floor(Q*50/10000)` (0.5%, rounded down independently). Buyer pays `Q+buyerFee`; seller receives `Q-sellerFee`; the immutable treasury receives both fees. The amounts conserve exactly: `buyerTotal = sellerNet + feePool`. For 123.456789 USDC (6 decimals), the buyer pays 124.074072, seller receives 122.839506 and treasury receives 1.234566. Fees are zero below 200 raw payment units.

The constructor takes one nonzero `treasury` address. `IOtcDealsV2.sol` specifies `Terms`, `Deal`, `Grant`, events and reads. `createDeal(terms)` escrows the full allocation with immutable buyer and schedule. `fill(id)` settles once, atomically paying the seller and treasury and either delivering immediately or assigning the escrowed allocation to one new grant. `cancel(id)` returns a funded allocation to its seller, including after expiry. No fees apply to creation, cancellation, failed settlement, refunds or claims.

For new vesting, `fixedStart=0` means settlement block time. A nonzero fixed start must still be in the future at creation and settlement. Duration must be positive and cliff shorter than duration. Start, cliff and end fit uint64 seconds. Immediate delivery requires all schedule fields to be zero.

Vesting accrues from start. Before cliff, vested is zero. At cliff and until end, vested is `floor(A*(t-start)/(end-start))`; at or after end, vested is exactly A. A 30-day cliff with 90-day duration releases the accrued one-third at cliff, half at day 45 and all at day 90. Claims subtract amounts already claimed and send only to the immutable buyer beneficiary. Anyone may trigger a claim. The last claim absorbs rounding dust. Settled grants can still have locked tokens.

The vault is the V2 contract itself (`custodian=address(this)`). No grant leaves an external factory partly funded. Failed transfers revert the entire transaction. V2 checks both sender and recipient balance deltas, accepting true-return and no-return ERC-20s and refusing inexact transfers. A transient lock guards create, settle, cancel and claim.

## Deploy locally or to a testnet

Set environment variables through your secret manager or a private shell environment; never put keys in the repository or command history. Legacy deployment uses `RPC_URL` and `DEPLOYER_KEY`:

```sh
npm run deploy
```

V2 deployment also requires `TREASURY`:

```sh
node scripts/deploy-v2.mjs
```

V2 prints only the deployed contract address on stdout. It never prints the environment values or raw provider errors. Place the result in `contractV2`. There is no production deployment workflow here.

## Verification and limitations

`npm test` includes legacy tests, fee and vesting arithmetic, ABI encoding/decoding, actual balance deltas, huge allocations, rounding dust, invalid schedules, rollback, reentrancy and browser workflows. V2 browser tests run seller, fresh read-only buyer, settlement and claims at 390px and 1440px; they save screenshots in ignored `screens/`. `node .launchpad/checks/round-1/run.mjs` runs the frozen legacy checks directly. This is separate from the official pinned offline gate.

Existing external positions (including Sablier), revocable rights, screenshots and URLs cannot be sold here. The form refuses those inputs before wallet approval. Grants are nontransferable. No broker share, admin rescue, upgrade, pause or beneficiary change exists.

If a treasury fee is due and the treasury refuses or is blocked from receiving the payment token, settlement reverts on every attempt while that restriction is in place. If the restriction is permanent, the seller must cancel to recover the escrowed allocation.

Rebasing, dishonest balance reporting, later token freezes or token upgrades can make a deal or grant unusable. No smart contract can prevent a token from changing its own behavior. Claims depend on on-chain seconds; the page polls latest blocks, so it may lag until the next block or refresh. A fixed start that passes before settlement requires cancellation and new terms. Accelerated transactions are followed by nonce across the latest 64 blocks; cancellations prompt a status refresh. Network receipts are subject to confirmation and reorganization; this UI does not implement a finality policy. The V2 deal page rebuilds its receipts after a reload from contract events with `eth_getLogs` from block 0; an RPC endpoint that limits log ranges shows only receipts from the current session. Use local or testnet assets only.
