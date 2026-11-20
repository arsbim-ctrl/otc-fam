# Settlement and trust boundaries

## State and authority

Only `createDeal`, `fill` and `cancel` mutate contract state. There is no administrator, owner, upgrade,
pause, rescue, fee recipient, fallback or payable function. The interface is unchanged. Deal ids begin
at 1 and only successful creation consumes an id. Terms cannot be edited. Unknown ids return `None`.

The maker is the creation caller. Cancellation requires that maker and an `Open` offer, even after
expiry. Fill requires an `Open` offer, `block.timestamp < expiry`, and the named taker when one exists.
The actual caller pays and receives; no input can substitute another payer or recipient. An open offer
has the transitions `Open → Filled` and `Open → Cancelled`; terminal states never reopen.

## Non-custodial settlement

Creation and cancellation transfer nothing and do not call the tokens. Funds and allowances are not
reserved. The page checks readiness, but balances, approvals and offer state may change before mining.
The contract remains the authority: a failed fill reverts all its state, token movements, allowance
changes and logs. The sender may still spend network gas.

All three mutators share OpenZeppelin's conventional storage reentrancy guard. Fill sets its terminal
state before external token interactions. It snapshots both participants' balances in both tokens and
the deal contract's balances, transfers buy tokens to the maker and sell tokens to the caller, then
checks the complete final balance vector. Checking after both legs also detects a second token
modifying the first leg's balances. Sender debit and recipient credit must both equal the stated
amount. The contract's balances must be unchanged, including pre-existing unsolicited donations.

For maker self-fill, the two parties alias. The two transfers and allowance checks still run; expected
net balances are zero for each token. The frontend offers the maker sharing and cancellation instead
of a pointless self-swap. A token contract may itself be a maker or taker; roles are address-based,
not determined by whether the address has code.

## Token policy

Use ordinary ERC-20 tokens with truthful `balanceOf`. Successful no-return transfers are supported by
the pinned OpenZeppelin `SafeERC20`; false returns, failed calls and invalid return values revert.
Positive returns without the required balance movements cannot settle a two-party exchange.
Transfer taxes, extra sender fees and rebases that alter the expected balance changes are refused.
Zero/EOA token addresses are refused at creation. No token metadata is required by the contract.

The contract cannot establish the economic value of a token or verify a malicious token's internal
ledger. A hostile token can fabricate `balanceOf`, change its behavior, blacklist holders or expose
unrelated ways to spend its holders' funds. Tokens may also be upgradeable independently of OtcDeals.
Exact delta checks and the absence of custody do not turn such a token into a trustworthy asset.
Reentrant calls to this contract are blocked; that does not prevent a token from exercising authority
it has over an unrelated contract. Review both tokens before trading.

An ERC-20 approval authorizes a spender at the token level; it is not reserved to a particular deal.
The UI requests exact amounts and supports a zero reset before a nonzero approval. Creating another
offer, filling one, or changing allowances elsewhere can affect other offers. Cancelling does not
remove an ERC-20 approval. Review/revoke unused approvals in your wallet. Never send tokens directly
to OtcDeals: unsolicited deposits have no recovery function.

## Browser and deployment

The static site gets its chain, contract and RPC endpoint from runtime config. It checks the RPC chain
and deployed code; it cannot prove that an untrusted RPC or compromised host reports truthful data.
Wallet account and chain are checked before each transaction. Transactions are simulated first, but
simulation is a readiness check rather than a guarantee of later execution.

Token metadata is rendered as text, never HTML. Amounts use bigint and strings, not floating point.
Missing decimals block actions rather than guessing precision. Zero decimals work; excess fractional
digits, nondecimal notation, overflow and nonpositive amounts are rejected. The creation form accepts
durations from one minute to 365 days; the contract itself accepts any valid future uint64 expiry.
The deadline is calculated from fresh chain time just before submission. Mining delay consumes some
of that duration; the confirmed deadline is shown after creation.

The action lock is set before awaiting anything. Account, network, route and form changes invalidate
preparation. Success requires a successful receipt; new deal ids come from this contract's creation
event. The page journals the account, operation and calldata in session storage before requesting
a chain-bound transaction. It retains confirmed creation IDs and hashes across navigation in the tab.
An uncertain send blocks the affected action until reconciliation. A supplied recovery hash must
match the sender, destination and calldata, and the original nonce when known. Clearing an unseen
or replaced transaction requires explicit verification in the wallet. These checks trust the configured RPC's
canonical state. Chain reorganizations remain possible after a first confirmation.

The deployment script reads environment values without persisting or printing them. Tests generate
an ephemeral local-only key in memory. The implementation has not received an independent audit.

## Verification map

`tests/contracts.mjs` covers exact movement, malformed/false/no-return tokens, fees, second-leg rollback,
cross-leg mutation, cross-deal and cross-function callbacks, contract-address participants, self-fill,
approval revocation, depleted funds, shared allowances, terminal states, expiry boundaries and a seeded
state-machine exercise. Failures compare balances, allowances, deal fields and empty reverted logs.

`tests/browser.mjs` covers the read/create/fill journeys, readiness recovery, precision, account and
network changes, wallet rejection, duplicate clicks, revert receipts, pending/replaced transactions,
unresponsive wallets, hostile/missing metadata, nested hosting, runtime configuration, keyboard use,
responsive layouts and external-asset absence. `tests/amounts.mjs` checks integer parsing/formatting and
routes. `tests/deploy.mjs` checks local deployment, error outcomes and environment-value redaction.
