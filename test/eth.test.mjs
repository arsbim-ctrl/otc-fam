import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";
import { explain } from "../web/eth.js";

test("explain preserves legacy contract messages and retains an unknown node message", () => {
  const address = `0x${"1a".repeat(20)}`;
  const legacy = [
    ["ZeroAmount()", [], "Both amounts must be more than zero."],
    ["SameToken()", [], "The token you give and the token you get must be different."],
    ["ExpiryNotInFuture()", [], "The deal must end in the future."],
    ["NotAToken(address)", [address], `${address} is not a token contract on this network.`],
    ["InexactTransfer(address)", [address], `The token ${address} does not move exactly the amount asked (it keeps a fee, or charges one on top), so deals in it cannot go through.`],
    ["NotOpen(uint256)", [1], "This deal is no longer open: it was filled or cancelled."],
    ["DealExpired(uint256)", [1], "This deal has expired: it can no longer be filled."],
    ["NotYourDeal(uint256,address)", [1, address], `This deal is reserved for ${address}: only that address can fill it.`],
    ["NotMaker(uint256)", [1], "Only the maker of this deal can cancel it."],
    ["TransferFailed(address)", [address], `The token ${address} refused the transfer: check the balance and the approval.`],
    ["Reentered()", [], "A token tried to call the deal contract back during its transfer: refused."],
  ];
  for (const [fragment, args, message] of legacy) {
    const iface = new Interface([`error ${fragment}`]);
    const data = iface.encodeErrorResult(fragment, args);
    assert.equal(explain({ data }), message);
  }
  for (const data of [undefined, "0x12345678"]) {
    const message = "RPC response exceeded the node's log limit";
    assert.equal(explain({ code: -32000, message, data }), message);
  }
  assert.equal(explain({ message: "execution reverted: Cannot trade this token" }), "execution reverted: Cannot trade this token");
  assert.equal(explain({ code: 4001 }), "You declined in your wallet. Nothing was sent.");
  assert.equal(explain({ message: "insufficient funds" }), "This wallet has too little of the network's own coin (ETH) to pay the network fee. Add some to it, then try again. Nothing was sent.");
});
