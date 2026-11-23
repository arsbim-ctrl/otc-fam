# Private OTC with vesting

V2 runs on a separate immutable contract. Use the private deal page at /#/v2/new. The V1 links at /#/d/<id> and /#/new keep their existing contract and fee behavior.

A seller enters two ERC-20 addresses, an allocation, a quote and a buyer. Immediate delivery transfers the allocation into the buyer’s wallet at settlement. New vesting keeps the same fully funded allocation in the contract as a nontransferable grant for the buyer. The schedule starts at the settlement block or a chosen UTC timestamp in the future. The cliff releases everything accrued since the start. The balance then accrues in raw units up to the end, when the beneficiary can claim the entire remainder.

The fee is floor(quote / 200) for each party. With 123.456789 USDC at six decimals, the buyer pays 124.074072, the seller receives 122.839506 and the immutable treasury receives 1.234566. No other action collects a fee. Each transfer checks both accounts’ exact balance changes. A failure rolls back the payment, escrow changes and grant creation. After expiry or a missed fixed start, the designated seller can recover the escrow. The grant ID is its source deal ID.

## Reproduce the checks and browser evidence

Use Node.js 22 or later. The harness starts a local EVM with mock ERC-20s, impersonated test accounts and a simulated wallet. It uses no live accounts or private keys.

    npm ci --ignore-scripts
    npx playwright install chromium
    LAUNCHPAD_GATE_OUT=/tmp/otc-r1.json node .launchpad/checks/round-1/run.mjs
    LAUNCHPAD_GATE_OUT=/tmp/otc-r2.json node .launchpad/checks/round-2/run.mjs
    OTC_V2_EVIDENCE=screens/vesting node --test test/vesting-page.test.mjs

The browser test runs seller, fresh read-only buyer, connected buyer and beneficiary at 390px and 1440px. It exercises both delivery modes and asserts raw account deltas after settlement, including unchanged balances after rejection, a mined revert and a replacement. The vesting scenario visits day 29, exact cliff, midpoint and end. It reloads the settled link and reads the on-chain settlement and grant receipts. The screenshots in [evidence](evidence/) show these local runs.

## Try the site with your local or testnet wallet

    OTC_TREASURY=<treasury-address> RPC_URL=<local-or-testnet-rpc> DEPLOYER_KEY=<test-key> npm run deploy -- --v2
    npm run build
    python3 -m http.server -d dist 8080

Before building, set contractV2 and v2DeploymentBlock in web/config.json from the deployment output. Set chainId and rpcUrl to the test network. Use a public read RPC that supports historical events from the deployment block. Leave contract configured with the V1 address. If the RPC caps event queries, live deal and balance reads still work. The current session also retains a pending transaction reference and displays its receipt once mined. On a reload or retry the UI reconciles the original transaction and recent replacements before offering another write.

## Limits

The link is for sharing with the buyer. Anyone who has it can read the terms. Only the designated buyer can settle. Claims may be triggered on-chain by anyone, with payment always going to the immutable beneficiary. The page offers the claim button to that beneficiary.

Existing or revocable positions, including Sablier positions, cannot be funded. Rebasing, freezing, dishonest and fee-on-transfer tokens can prevent settlement, refund or claim. The exact-delta checks do not make arbitrary tokens safe. The browser searches the most recent 24 blocks for replacement transactions and relies on wallet activity for older replacements it cannot identify. The application uses local/testnet deployments and synthetic evidence.
