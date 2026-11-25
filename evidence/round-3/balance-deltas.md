# Measured Round 3 balance deltas

Local EDR fixture. USDC uses six decimals and FAM uses 18. Positive values are credits and negative values are debits. Escrow is the V3 contract. Each row subtracts balances immediately before the named action.

| Action | Quote raw | Broker bps | buyer USDC | seller USDC | broker USDC | treasury USDC | escrow USDC | buyer FAM | seller FAM | broker FAM | treasury FAM | escrow FAM |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fund | 100000000000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | -7000000000000000000 | 0 | 0 | 7000000000000000000 |
| Settle | 100000000000 | 0 | -100500000000 | 99500000000 | 0 | 1000000000 | 0 | 7000000000000000000 | 0 | 0 | 0 | -7000000000000000000 |
| Fund | 100000000000 | 2000 | 0 | 0 | 0 | 0 | 0 | 0 | -7000000000000000000 | 0 | 0 | 7000000000000000000 |
| Settle | 100000000000 | 2000 | -100500000000 | 99500000000 | 200000000 | 800000000 | 0 | 7000000000000000000 | 0 | 0 | 0 | -7000000000000000000 |
| Fund | 123456789 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | -7000000000000000000 | 0 | 0 | 7000000000000000000 |
| Settle | 123456789 | 0 | -124074072 | 122839506 | 0 | 1234566 | 0 | 7000000000000000000 | 0 | 0 | 0 | -7000000000000000000 |
| Fund | 123456789 | 2000 | 0 | 0 | 0 | 0 | 0 | 0 | -7000000000000000000 | 0 | 0 | 7000000000000000000 |
| Settle | 123456789 | 2000 | -124074072 | 122839506 | 246913 | 987653 | 0 | 7000000000000000000 | 0 | 0 | 0 | -7000000000000000000 |
| Expired settlement rejected | 123456789 | 2000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Refund expired escrow | 123456789 | 2000 | 0 | 0 | 0 | 0 | 0 | 0 | 7000000000000000000 | 0 | 0 | -7000000000000000000 |
