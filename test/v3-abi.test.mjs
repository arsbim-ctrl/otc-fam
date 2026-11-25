// web/v3.js writes the broker deals contract's ABI by hand, builds the EIP-712 message a wallet signs, packs a deal's
// terms into its link, and repeats the fee arithmetic so that the page can say before a press what the chain will do.
// All of it must be what the compiled BrokerDeals says and does, and every error it can revert with must have words
// on the page. The last test holds the earlier rounds' contracts to the bytes those rounds ended with.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { id, Interface, TypedDataEncoder } from "ethers";
import { explain } from "../web/eth.js";
import { shareOf } from "../web/v3-new-page.js";
import { claimData, DOMAIN, FIELDS, flawOf, fundData, money, packTerms, refundData, settleBy, settleData, stateOf, typedData, unpackTerms } from "../web/v3.js";
import { CHAIN_ID } from "../.launchpad/checks/round-1/chain.mjs";
import { artifacts3, DAY, feesOf, SIGNERS, STATUS3, TYPES, world3 } from "../scripts/lib/world3.mjs";

const contract = new Interface(artifacts3().BrokerDeals.abi);
/** Terms as the page holds them (addresses in lower case, numbers as BigInts), from a world's terms. */
const pageTerms = (t) => Object.fromEntries(FIELDS.map(([name, type]) => [name, type === "address" ? t[name].toLowerCase() : BigInt(t[name])]));

test("each selector and topic in web/v3.js is the keccak of the signature written next to it, and names something the contract has", () => {
  const source = readFileSync("web/v3.js", "utf8"), tuple = /const TERMS = "(.*)";/.exec(source)[1];
  const pairs = [...source.matchAll(/"(0x[0-9a-f]{8}|0x[0-9a-f]{64})",? \/\/ (\w+\(.*\))$/gm)];
  assert.equal(pairs.length, 17, "the 12 calls and the 5 events");
  for (const [, hex, written] of pairs) {
    const signature = written.replace("TERMS", tuple);
    assert.equal(hex, id(signature).slice(0, hex.length), signature);
    assert.ok(hex.length === 10 ? contract.getFunction(hex) : contract.getEvent(hex), `${signature} is in the contract`);
  }
  assert.deepEqual(FIELDS.map(([name, type]) => ({ name, type })), contract.getFunction("fund").inputs[0].components.map(({ name, type }) => ({ name, type })),
    "the page's fields are IBrokerDeals.BrokerTerms: the same names, types and order");
});

test("R3-02: what the page asks a wallet to sign is what the contract checks: the typed data's digest is the deal's ID, for this chain and this contract", async () => {
  const w = await world3(), t = await w.vesting3({ fixedStart: (await w.chain.now()) + 2 * DAY }), terms = pageTerms(t);
  const typed = typedData(CHAIN_ID, w.v3.address, terms), { EIP712Domain: domainType, ...types } = typed.types;
  assert.deepEqual(typed.domain, { name: "OTC.fam Broker Deals", version: "3", chainId: CHAIN_ID, verifyingContract: w.v3.address });
  assert.deepEqual(domainType.map((field) => field.name), ["name", "version", "chainId", "verifyingContract"]);
  assert.deepEqual(types, TYPES);
  assert.equal(typed.primaryType, "BrokerTerms");
  const digest = TypedDataEncoder.hash(typed.domain, types, typed.message);
  assert.equal(digest, w.idOf(t), "the digest of the page's message is the digest of the terms");
  assert.equal(digest, await w.v3.read.dealIdOf(t), "and the contract's own dealIdOf says the same");
  assert.equal(await w.v3.read.domainSeparator(), TypedDataEncoder.hashDomain(typed.domain));
  for (const other of [{ chainId: CHAIN_ID + 1 }, { verifyingContract: w.other }, { version: "2" }, { name: "OTC.fam" }]) {
    assert.notEqual(TypedDataEncoder.hash({ ...typed.domain, ...other }, types, typed.message), digest, `another ${Object.keys(other)[0]} is another digest`);
  }

  // The page's own call data, with signatures of the page's own message, funds and settles the deal on the chain.
  const sign = (name) => SIGNERS[name].signTypedData(typed.domain, types, typed.message);
  const [sellerSignature, buyerSignature] = [await sign("seller"), await sign("buyer")];
  assert.equal(fundData(terms, sellerSignature), contract.encodeFunctionData("fund", [t, sellerSignature]));
  assert.equal(settleData(digest, buyerSignature), contract.encodeFunctionData("settle", [digest, buyerSignature]));
  assert.equal(refundData(digest), contract.encodeFunctionData("refund", [digest]));
  assert.equal(claimData(7n), contract.encodeFunctionData("claim", [7n]));
  await w.stock(t);
  await w.ready3(t);
  await w.chain.send(w.seller, { to: w.v3.address, data: fundData(terms, sellerSignature) }, "the page's fund");
  assert.equal((await w.v3.read.getDeal(digest)).status, STATUS3.Funded);
  await w.chain.send(w.buyer, { to: w.v3.address, data: settleData(digest, buyerSignature) }, "the page's settle");
  assert.equal((await w.v3.read.getDeal(digest)).status, STATUS3.Settled);
});

test("a link carries the terms exactly: every field survives it, and a link that was cut or changed carries nothing", async () => {
  const w = await world3();
  const max = { ...pageTerms(await w.terms3()), allocation: 2n ** 256n - 1n, quote: 2n ** 256n - 1n, expiry: 2n ** 64n - 1n, nonce: 2n ** 256n - 1n, delivery: 255n,
    fixedStart: 2n ** 64n - 1n, cliffSeconds: 2n ** 64n - 1n, durationSeconds: 2n ** 64n - 1n, brokerBps: 65_535n };
  for (const terms of [pageTerms(await w.terms3()), pageTerms(await w.vesting3()), max]) {
    const text = packTerms(terms);
    assert.match(text, /^[A-Za-z0-9_-]{308}$/, "231 bytes, as base64 for a URL");
    assert.deepEqual(unpackTerms(text), terms);
    for (const broken of [text.slice(1), `${text}A`, text.replace(/.$/, "="), `${text.slice(0, 100)} ${text.slice(101)}`, "", undefined]) assert.equal(unpackTerms(broken), null);
  }
  // Another letter is other terms, and so another deal: never the same deal with something changed.
  const text = packTerms(pageTerms(await w.terms3())), other = unpackTerms(`${text.slice(0, 150)}${text[150] === "A" ? "B" : "A"}${text.slice(151)}`);
  assert.ok(other, "a changed letter still reads as terms");
  assert.notEqual(await w.v3.read.dealIdOf(other), await w.v3.read.dealIdOf(unpackTerms(text)), "but as the terms of another deal, with another ID");
});

test("R3-03: the page's fee arithmetic is the contract's, to the smallest unit, for both broker rates and both fixtures of the brief and at the edges", async () => {
  const w = await world3();
  assert.deepEqual(money(100_000_000_000n, 2_000), { quote: 100_000_000_000n, buyerFee: 500_000_000n, sellerFee: 500_000_000n, buyerTotal: 100_500_000_000n, sellerNet: 99_500_000_000n,
    feePool: 1_000_000_000n, brokerFee: 200_000_000n, treasuryFee: 800_000_000n }, "100,000 USDC at 20%: 100,500 paid, 99,500 received, 200 to the broker, 800 to the treasury");
  assert.equal(money(100_000_000_000n, 0).treasuryFee, 1_000_000_000n, "at 0% the treasury has the whole 1,000");
  assert.deepEqual([money(123_456_789n, 2_000).brokerFee, money(123_456_789n, 2_000).treasuryFee], [246_913n, 987_653n], "123.456789 USDC at 20%: floor(1,234,566 × 0.2)");
  for (const quote of [1n, 199n, 200n, 201n, 123_456_789n, 100_000_000_000n, 10n ** 30n + 7n, 2n ** 255n]) {
    for (const bps of [0, 1, 2_000, 3_333, 9_999, 10_000]) {
      const m = money(quote, bps), [buyerFee, sellerFee, brokerFee, treasuryFee] = await w.v3.read.feesOf(quote, bps);
      assert.deepEqual([m.buyerFee, m.sellerFee, m.brokerFee, m.treasuryFee], [buyerFee, sellerFee, brokerFee, treasuryFee], `${quote} at ${bps} bps`);
      assert.deepEqual(feesOf(quote, bps), { buyerFee, sellerFee, brokerFee, treasuryFee, buyerTotal: quote + buyerFee, sellerNet: quote - sellerFee }, "and the tests' own arithmetic");
      assert.equal(m.brokerFee + m.treasuryFee, m.buyerFee + m.sellerFee, "the broker and the treasury share exactly the two fees");
    }
  }
});

test("the broker's share is typed as a percentage of the fees and read to the hundredth of a percent", () => {
  for (const [text, bps] of [["0", 0n], ["20", 2_000n], ["12.5", 1_250n], ["0.01", 1n], ["100", 10_000n], ["100.00", 10_000n], ["7.25", 725n]]) assert.equal(shareOf(text).bps, bps, text);
  for (const text of ["100.01", "101", "20%", "-1", "1e2", "12.345", ".5", "abc"]) assert.equal(shareOf(text).problem, "Check the broker's share", text);
  assert.equal(shareOf("").problem, "Enter the broker's share");
});

test("the page refuses, before any wallet is asked, the terms the contract would refuse; and it says a deal's state from its status and the time", async () => {
  const w = await world3(), t = pageTerms(await w.terms3()), v = pageTerms(await w.vesting3()), here = w.v3.address;
  assert.equal(flawOf(t, here), null);
  assert.equal(flawOf(v, here), null);
  for (const [changes, error] of [[{ allocation: 0n }, "ZeroAmount"], [{ quote: 0n }, "ZeroAmount"], [{ quoteToken: t.baseToken }, "SameToken"], [{ buyer: `0x${"0".repeat(40)}` }, "NoBuyer"],
    [{ buyer: t.seller }, "BuyerIsSeller"], [{ broker: t.seller }, "BadBroker"], [{ broker: t.buyer }, "BadBroker"], [{ broker: here }, "BadBroker"], [{ broker: `0x${"0".repeat(40)}` }, "BadBroker"],
    [{ brokerBps: 10_001n }, "BrokerShareTooLarge"], [{ delivery: 2n }, "BadDelivery"], [{ cliffSeconds: 1n }, "ScheduleOnImmediate"], [{ delivery: 1n }, "BadSchedule"],
    [{ quote: 2n ** 256n - 1n }, "QuoteTooLarge"], [{ delivery: 1n, durationSeconds: 2n ** 64n - 1n }, "ScheduleTooLong"]]) {
    const terms = { ...t, ...changes };
    assert.ok(flawOf(terms, here), `${error}: the page says why ${JSON.stringify(changes, (_, x) => (typeof x === "bigint" ? `${x}` : x))} cannot be funded`);
    // The contract refuses the same terms with that error, whoever signs them.
    const data = contract.encodeFunctionData("fund", [terms, await w.sign("seller", terms)]);
    const refusal = await w.chain.rpc("eth_call", [{ from: w.seller, to: here, data }, "latest"]).then(() => null, (e) => e);
    assert.equal(contract.parseError(refusal.data?.data ?? refusal.data).name, error);
  }
  const expiry = Number(t.expiry), fixed = { ...v, fixedStart: BigInt(expiry - 100) };
  assert.deepEqual([stateOf(t, "unfunded", expiry - 1), stateOf(t, "funded", expiry - 1), stateOf(t, "unfunded", expiry), stateOf(t, "funded", expiry), stateOf(t, "settled", expiry + 9), stateOf(t, "refunded", 0)],
    ["awaiting", "funded", "expired", "expired", "settled", "refunded"]);
  assert.deepEqual([stateOf(fixed, "funded", expiry - 100), stateOf(fixed, "funded", expiry - 99), settleBy(fixed), settleBy(t)], ["funded", "expired", expiry - 100, expiry],
    "a fixed vesting start ends a deal sooner than its expiry");
  assert.deepEqual([stateOf(fixed, "unfunded", expiry - 101), stateOf(fixed, "unfunded", expiry - 100)], ["awaiting", "expired"],
    "a deal can be settled in the second of its fixed start, but no longer funded then: the contract asks for a start in the future");
  assert.equal(money(1_000_000n, 65_535).treasuryFee, 0n, "a share the contract would refuse never shows as a negative amount");
});

test("every error BrokerDeals can revert with from the page has words there, and the words carry its arguments", () => {
  const source = readFileSync("web/eth.js", "utf8");
  // BadTreasury is the constructor's answer: the page cannot meet it.
  contract.forEachError((error) => error.name === "BadTreasury" || assert.ok(source.includes(`"${error.selector}": `), `${error.format()} has no reason in web/eth.js`));
  const who = "0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081", some = `0x${"ab".repeat(32)}`;
  assert.equal(explain({ code: 3, data: contract.encodeErrorResult("NotBuyer", [who]) }), `This deal is for ${who}: only that address can settle it.`);
  assert.equal(explain({ code: 3, data: contract.encodeErrorResult("NotSeller", [who]) }), `Only the seller, ${who}, can fund this deal or take its tokens back.`);
  assert.match(explain({ code: -32000, data: { data: contract.encodeErrorResult("BadSignature", [who]) } }), new RegExp(`not ${who}'s signature of these exact terms`));
  assert.match(explain({ code: 3, data: contract.encodeErrorResult("NonceUsed", [who, 71n]) }), /already funded a deal with nonce 71/);
  assert.match(explain({ code: 3, data: contract.encodeErrorResult("NotFunded", [some]) }), /not funded yet, or it was settled or refunded/);
  assert.match(explain({ code: 3, data: contract.encodeErrorResult("DealExpired", [some]) }), /has expired/);
  assert.equal(DOMAIN.version, "3");
});

test("frozen: the contracts of rounds 1 and 2 are the files those rounds ended with, byte for byte", () => {
  // The git blob id of each file (the SHA-1 of "blob <length>\0" and the file): of round 1's at commit 545cdb7, of
  // round 2's at the round 2 merge 0bcc9c8. "git ls-tree 545cdb7 contracts/" and "git ls-tree 0bcc9c8 contracts/" print them.
  const frozen = {
    "contracts/OtcDeals.sol": "a57230a3322564b53a29f86ff52c763c05506aa3", "contracts/IOtcDeals.sol": "cd7dd49b9b964a2d953aacfd02b701eb04cae3ff",
    "contracts/OtcDealsV2.sol": "41dea306f97d4124e6d8e34c6bbb0692dc235d71", "contracts/IOtcDealsV2.sol": "02153548f4c7ce8e0b7e0043d2a39517f3cb0977",
    "contracts/GrantVault.sol": "1df2619379eea7b3d8c8377d8e95bbb5a77a25ff", "contracts/TokenMoves.sol": "4c9f85d7e57b49f770b9e3912e5e6414c8178239",
  };
  for (const [file, blob] of Object.entries(frozen)) {
    const content = readFileSync(file);
    assert.equal(createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex"), blob, `${file} was changed`);
  }
  assert.equal(readFileSync("contracts/IBrokerDeals.sol", "utf8"), readFileSync(".launchpad/checks/round-3/IBrokerDeals.sol", "utf8"), "the v3 interface is the round's own file");
});
