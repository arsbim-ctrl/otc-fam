# OTC V2 local evidence

Run `OTC_SCREENSHOTS=evidence/v2 node --test test/v2-browser.test.mjs` after installing the locked
dependencies and the matching Chromium. The fixture uses an in-process EVM and mock ALFA (18 decimals)
and USDC (6 decimals). Each scenario creates a new chain and fresh browser contexts. The test advances
block timestamps directly for the vesting boundaries.

| Scenario | Captures |
| --- | --- |
| Seller reviews the exact allocation, quote, fees and schedule | [390px](390-seller-review.png), [1440px fixed UTC start](1440-seller-review.png) |
| Fresh buyer verifies escrow before connecting | [1440px](1440-fresh-buyer.png) |
| Existing-position refusal and mined revert | [Unsupported position](390-unsupported.png), [Reverted settlement](390-reverted-settlement.png) |
| Vesting and receipts | [Day 29](390-day-29.png), [Cliff](1440-cliff.png), [Day 45 after a prior claim](390-day-45.png), [Final claim receipt](1440-final-claim.png) |
| Immediate delivery through a replacement transaction | [1440px](1440-immediate-settled.png) |

At a quote of **123.456789 USDC**, the tests assert raw payment deltas of **−124,074,072** for the buyer,
**+122,839,506** for the seller, **+1,234,566** for the treasury and **0** for the deal contract.
Each 0.5% fee rounds down to **617,283** raw units. Immediate settlement sends the full ALFA allocation
to the buyer. Vesting settlement moves it from escrow into the grant vault and leaves the buyer’s
ALFA balance at zero. A reverted settlement leaves escrow and all payment balances unchanged.

For the 1,000,000 ALFA grant, the test observes zero claimable on day 29. Exactly at the cliff,
`333333333333333333333333` raw units are claimable. The first claim pays those units to the buyer and
reduces vault backing by the same amount. At day 45, the buyer has `166666666666666666666667` additional
raw units claimable. The final claim takes the buyer’s cumulative payout to the full allocation and
reduces the vault balance to zero. Treasury and seller balances stay at their settlement values during
claims.
