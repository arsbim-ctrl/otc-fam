// web/eth.js writes its ABI by hand: each selector next to the signature it stands for. They must be what the
// compiled OtcDeals says, and every error the contract can revert with must have words on the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { id, Interface } from "ethers";
import { artifacts } from "../.launchpad/checks/round-1/world.mjs";
import { AppError, Chain, explain } from "../web/eth.js";

const source = readFileSync("web/eth.js", "utf8");
const contract = new Interface(artifacts().entry.abi);

test("each selector and topic in web/eth.js is the keccak of the signature written next to it", () => {
  const pairs = [...source.matchAll(/"(0x[0-9a-f]{8}|0x[0-9a-f]{64})"[,:;].*\/\/ (\w+\([\w,]*\))/g)];
  assert.ok(pairs.length >= 21, `found ${pairs.length} selectors: the 9 calls, the DealCreated topic and the 11 errors`);
  for (const [, hex, signature] of pairs) assert.equal(hex, id(signature).slice(0, hex.length), signature);
});

test("every error of OtcDeals has app-authored words without raw revert arguments", () => {
  contract.forEachError((error) => assert.ok(source.includes(`"${error.selector}": `), `${error.format()} has no reason in web/eth.js`));
  const taker = "0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
  const data = contract.encodeErrorResult("NotYourDeal", [7n, taker]);
  assert.equal(explain({ code: -32000, data: { data } }), "Only the reserved wallet can fill this deal. Check the address shown in the deal terms.");
  assert.equal(explain({ code: 3, data: contract.encodeErrorResult("DealExpired", [7n]) }), "This deal has expired: it can no longer be filled.");
  assert.equal(explain({ code: 4001, message: "User rejected the request." }), "You declined in your wallet. Nothing was sent.");
  assert.equal(explain({ code: 4902 }), "Your wallet does not know this network yet. Add it in your wallet, then try again.");
});

test("explain preserves app validation and gas guidance while replacing unknown provider text", () => {
  const debug = "eth_sendTransaction: account=0x1234 params=[123] in wallet.js";
  assert.equal(explain(new Error(debug)), "Something went wrong. Check the current deal and try again.");
  assert.equal(explain({ message: `insufficient funds for gas: ${debug}` }),
    "This wallet needs more of the network’s gas token. Add gas funds and try again.");
  assert.equal(explain(new AppError("The vesting start must be in the future.")), "The vesting start must be in the future.");
});

test("a token's symbol is read as an ABI string or as bytes32 (as MKR's is), without characters that change the text's direction", async () => {
  const hex = (text) => Buffer.from(text, "utf8").toString("hex");
  const word = (n) => n.toString(16).padStart(64, "0");
  const asString = (text) => `0x${word(32)}${word(Buffer.byteLength(text))}${hex(text).padEnd(64, "0")}`;
  const symbols = { "0x00000000000000000000000000000000000000aa": asString("ALFA"), "0x00000000000000000000000000000000000000bb": `0x${hex("MKR").padEnd(64, "0")}`,
    "0x00000000000000000000000000000000000000cc": asString("USD‮C") };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { body }) => {
    const [{ to, data }] = JSON.parse(body).params;
    return { ok: true, json: async () => ({ result: data === "0x313ce567" ? `0x${word(18)}` : symbols[to] }) }; // decimals(), else symbol()
  };
  try {
    const chain = new Chain("http://rpc.invalid", `0x${"0".repeat(40)}`);
    assert.deepEqual(await Promise.all(Object.keys(symbols).map(async (a) => (await chain.token(a)).symbol)), ["ALFA", "MKR", "USDC"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
