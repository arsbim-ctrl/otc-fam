// web/eth.js writes its ABI by hand: each selector next to the signature it stands for. They must be what the
// compiled OtcDeals says, and every error the contract can revert with must have words on the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { id, Interface } from "ethers";
import { artifacts } from "../.launchpad/checks/round-1/world.mjs";
import { Chain, explain } from "../web/eth.js";

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

test("a refusal the page recognises is said as a plain sentence, and one it does not is shown in the node's own words, as in round 1", () => {
  // Round 1's fallback, kept: the first line of the node's message, unchanged.
  for (const message of ["Internal JSON-RPC error.", "header not found", "TypeError: Cannot read properties of undefined (reading 'gasPrice')\n    at eval (inpage.js:1:10)"]) {
    assert.equal(explain(Object.assign(new Error(message), { code: -32000 })), message.split("\n")[0]);
  }
  assert.equal(explain({ code: -32603, message: "missing trie node 0xabc" }), "missing trie node 0xabc");
  assert.equal(explain("some text"), "some text");
  const refusals = [
    ["insufficient funds for gas * price + value: address 0x5e6F708192a3B4c5D6E7f8091A2b3c4d5E6f7081 have 0 want 21000000000000", /too little of the network's own coin \(ETH\) to pay the network fee/],
    ["Sender doesn't have enough funds to send tx. The max upfront cost is: 2100000 and the sender's account only has: 0", /too little of the network's own coin \(ETH\)/],
    ["MetaMask Tx Signature: User denied transaction signature.", /^You declined in your wallet\. Nothing was sent\.$/],
    ["nonce too low: next nonce 12, tx nonce 11", /already has a transaction waiting/],
    ["replacement transaction underpriced", /already has a transaction waiting/],
    ["execution reverted", /would fail on the chain, so it was not sent/],
  ];
  for (const [message, expected] of refusals) {
    const said = explain(Object.assign(new Error(message), { code: -32000 }));
    assert.match(said, expected, message);
    assert.ok(!said.includes(message.slice(0, 20)), `a known refusal is not repeated word for word: ${said}`);
  }
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
