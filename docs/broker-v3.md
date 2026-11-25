# Broker deals on OTC.fam

Open V3 from the home page or use /#/v3/new. The broker prepares an unsigned proposal and shares its link with the seller and buyer. The link puts the exact raw terms in the URL fragment. The connected wallet is only needed when a role acts. Anyone with the link can inspect it, and once funded the terms are also visible on-chain.

1. The broker names separate broker, seller and buyer wallets, enters token addresses, amounts and expiry, then previews and copies the link. The seller nonce is generated for the proposal. Use Duplicate to start with a fresh nonce and a new expiry and review the fixed start again for a vesting deal.
2. The seller reviews the terms, approves the exact allocation and signs the EIP-712 BrokerTerms message. Only the seller can fund, and the nonce is consumed when funding succeeds.
3. A fresh browser reads the escrow state. The designated buyer reviews the same terms, approves the exact payment and signs them before settling. Delivery goes to the buyer immediately or to a fully backed vault with the buyer as beneficiary.
4. Open Broker history with the broker wallet. Unfunded proposals come from browser storage. Funded deals can also be recovered from the contract’s broker-indexed logs. Each deal includes the link, a duplicate action and its receipt when available.

V3’s immutable treasury receives the fee pool after the broker share. Each side contributes floor(quote / 200); the broker receives floor(pool × brokerBps / 10,000). The 100,000 USDC case pays 100,500 from the buyer and 99,500 to the seller. A 20% broker share pays 200 USDC to the broker and 800 USDC to treasury; a zero share pays 1,000 USDC to treasury. For 123.456789 USDC the 20% broker and treasury shares are 0.246913 and 0.987653 USDC. The contract takes no fees on funding, claims or refunds. Failed transfers revert the entire settlement.

The EIP-712 domain binds the chain and verifying V3 contract. The deal ID is the typed-data digest. The seller’s and buyer’s typed signatures authorize the same exact terms. The contract also checks the transaction sender, expiry, status and seller nonce. The UI keeps signatures in memory for the corresponding request. The settlement event is the source of the fees and grant ID on receipts.

## Reproduce

Use Node.js 22 and the lockfile. These commands use a local chain with mock tokens and generated in-memory signing wallets.

    npm ci --ignore-scripts
    npx playwright install chromium
    npm run proof:v3

This command starts and stops its own local chain and Chromium. The first stage runs the five frozen contract fixtures in `.launchpad/checks/round-3/run.mjs`. They compare both token balances for the seller, buyer, broker, unrelated wallet, treasury and escrow, across both quotes and both broker rates. They also check the funded vault at the cliff and end, and rollback and refund balances. The second stage checks all fourteen EIP-712 fields against the published interface in `test/v3-terms.test.mjs` and runs `test/v3-page.test.mjs`. It passes the copied link between independent browser contexts and checks displayed receipts against the local RPC.

For the full suite run `npm run check` and `npm test`. For screenshots and transaction records from a new run, use `OTC_V3_EVIDENCE=/tmp/otc-v3-proof npm run proof:v3`. For a manual walkthrough, start `npm run dev -- --broker` in a separate terminal and open the printed URL.

The demo wallet bar selects the independent broker, seller and buyer. The browser test runs both delivery modes at 390px and 1440px, asserts balance deltas, switches from a wrong network, rejects a signing request, and checks that settled receipts reappear after reload. It also exercises an unrelated wallet, recovery of funded deals in a fresh broker browser, expiry, refund and vesting claims. The JSON records include raw settlement deltas for each token and role, plus the funding, settlement, claim and refund transaction hashes where applicable. See the [browser evidence](v3-evidence/) for local transaction hashes and screenshots. The frozen Round 3 checks verify both quote and broker-share fixtures, rollback, refund, nonce reuse, wrong domain and exact vesting delivery.

Use contractV3 and fromBlockV3 in web/config.json to configure the static build. Use a local or supported test network only. npm run deploy:v3 takes TREASURY, RPC_URL and DEPLOYER_KEY as environment variables and prints the deployed address and block. Existing V1 and V2 configs and routes continue to work.

## Limits

V3 supports externally owned wallets that sign typed data. Contract-wallet signatures and existing external vesting positions are outside this version. Unfunded proposals are local to the originating browser, while on-chain history depends on the RPC’s log retention and query limits. The explorer link is omitted for local chains with no configured explorer. All evidence uses mock assets. The production broker share, eligibility and deployment require separate review.
