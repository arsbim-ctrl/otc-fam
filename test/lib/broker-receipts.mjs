import assert from "node:assert/strict";
import { Interface, formatUnits, getAddress } from "ethers";

const events = new Interface([
  "event BrokerDealFunded(bytes32 indexed dealId,address indexed seller,address indexed broker)",
  "event BrokerDealSettled(bytes32 indexed dealId,address indexed buyer,uint256 buyerFee,uint256 sellerFee,uint256 brokerFee,uint256 treasuryFee,uint256 grantId)",
  "event BrokerDealRefunded(bytes32 indexed dealId)",
  "event BrokerGrantClaimed(uint256 indexed grantId,address indexed beneficiary,uint256 amount)",
]);

export async function rpc(world, method, params) {
  const response = await fetch(world.url + "rpc", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const { result, error } = await response.json();
  assert.ifError(error);
  return result;
}

export async function receiptEvent(page, world, label, eventName) {
  const row = page.locator('[data-kind="' + label + '"]');
  const hash = await row.getAttribute("data-tx");
  const receipt = await rpc(world, "eth_getTransactionReceipt", [hash]);
  assert.equal(receipt.status, "0x1");
  assert.equal(getAddress(receipt.to), getAddress(world.contract));
  assert.equal(receipt.transactionHash, hash);
  const logs = receipt.logs.filter((log) => getAddress(log.address) === getAddress(world.contract)
    && log.topics[0] === events.getEvent(eventName).topicHash);
  assert.equal(logs.length, 1);
  const args = events.parseLog(logs[0]).args;
  await row.getByText(hash, { exact: true }).waitFor();
  assert.match(await row.innerText(), new RegExp("Confirmed · block " + Number(receipt.blockNumber) + " · [1-9][0-9]* confirmation"));
  return { row, hash, args };
}

export function checkSettlementText(text, args, quote, allocation) {
  const usdc = (units) => formatUnits(units, 6).replace(/\.0$/, "") + " USDC";
  const expected = [
    "Buyer paid " + usdc(quote + args.buyerFee), "seller received " + usdc(quote - args.sellerFee),
    "Buyer fee " + usdc(args.buyerFee), "seller fee " + usdc(args.sellerFee),
    "broker " + usdc(args.brokerFee), "treasury " + usdc(args.treasuryFee),
    args.grantId ? "Fully backed grant #" + args.grantId : "Delivered " + allocation,
  ];
  for (const field of expected) assert.ok(text.includes(field), field + " in settlement receipt");
}
