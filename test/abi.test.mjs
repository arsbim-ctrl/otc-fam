// web/eth.js writes its ABI by hand: each selector next to the signature it stands for. They must be what the
// compiled OtcDeals says, and every error the contract can revert with must have words on the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { id, Interface } from "ethers";
import { artifacts } from "../.launchpad/checks/round-1/world.mjs";
import { explain } from "../web/eth.js";

const source = readFileSync("web/eth.js", "utf8");
const contract = new Interface(artifacts().entry.abi);

test("each selector and topic in web/eth.js is the keccak of the signature written next to it", () => {
  const pairs = [...source.matchAll(/"(0x[0-9a-f]{8}|0x[0-9a-f]{64})"[,:;].*\/\/ (\w+\([\w,]*\))/g)];
  assert.ok(pairs.length >= 21, `found ${pairs.length} selectors: the 9 calls, the DealCreated topic and the 11 errors`);
  for (const [, hex, signature] of pairs) assert.equal(hex, id(signature).slice(0, hex.length), signature);
});

test("every error of OtcDeals has words on the page, and the words carry its arguments", () => {
  contract.forEachError((error) => assert.ok(source.includes(`"${error.selector}": `), `${error.format()} has no reason in web/eth.js`));
  const taker = "0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
  const data = contract.encodeErrorResult("NotYourDeal", [7n, taker]);
  assert.equal(explain({ code: -32000, data: { data } }), `This deal is reserved for ${taker}: only that address can fill it.`);
  assert.equal(explain({ code: 3, data: contract.encodeErrorResult("DealExpired", [7n]) }), "This deal has expired: it can no longer be filled.");
  assert.equal(explain({ code: 4001, message: "User rejected the request." }), "You declined in your wallet. Nothing was sent.");
});
