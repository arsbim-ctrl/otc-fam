// The broker deal pages (v3), used as the three people of a deal use them, each in a browser of their own: the broker
// prepares a link with no wallet, the seller signs and funds, a fresh buyer checks the deal with no wallet and then
// signs and settles, and everyone finds the deal and its receipt again. Each test builds the page, serves it for a
// fresh world (scripts/lib/site.mjs, scripts/lib/world3.mjs) and drives it in Chromium at a phone's width (390 px), a
// desktop's (1440 px), or both. What moved is always read from the chain and compared to the unit.
// The tests are named by the acceptance point of the round 3 brief they show (R3-01 … R3-05).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { TypedDataEncoder } from "ethers";
import { browse, closeBrowser, DESKTOP, fits, offered, PHONE, pressUntil, read, seen, serve, shows, signerFor, until } from "../scripts/lib/site.mjs";
import { ALLOCATION, DAY, feesOf, QUOTE, STATUS3, world3 } from "../scripts/lib/world3.mjs";
import { packTerms } from "../web/v3.js";

after(closeBrowser);

const USDC = 10n ** 6n;
const LARGE = 100_000n * USDC; // the brief's 100,000 USDC; QUOTE is its 123.456789 USDC
const TOTAL = feesOf(QUOTE, 2_000).buyerTotal; // 124.074072 USDC
const FUND = "0xcdbe064f"; // fund(terms,bytes)
const DECLINED = { error: { code: 4001, message: "User rejected the request." } };
/** The link of the deal of `t` (a world's terms) on the world's chain and contract. */
const linkTo = (w, t) => `#/v3/d/31337/${w.v3.address.toLowerCase()}/${packTerms(t)}`;
const receiptsOf = (page, kind) => page.locator(`[data-testid="receipts"] li[data-kind="${kind}"]`).count();
const says = (page, id, text, name) => shows(page, id, (t) => t === text, JSON.stringify(text), name);
const noticeSays = (page, text) => shows(page, "notice", (t) => t.includes(text), `a notice saying "${text}"`);
const state = (page, status) => says(page, "deal-status", status, "data-status");
/** Makes the page read the chain now, as it does every few seconds and whenever its window gets the focus. */
const refresh = (page) => page.evaluate(() => dispatchEvent(new Event("focus")));
const statusOf = async (w, id) => (await w.v3.read.getDeal(id)).status;
const SIZES = [["a phone's (390 px)", PHONE], ["a desktop's (1440 px)", DESKTOP]];

/** Runs `steps(site, w)` on a fresh world `w` with broker deals, whose page is served at `site`. */
async function onSite(steps, more) {
  const w = await world3();
  const site = await serve(w, more);
  try {
    await steps(site, w);
  } finally {
    await site.close();
  }
}

/** Types a deal into the broker's form at #/v3/new: a million FAM from the seller to the buyer for `quote` USDC, the broker taking `share` percent of the fees. */
async function enter(page, w, { quote = "100000", share = "20", ...more } = {}) {
  const entered = { "base-token": w.fam.address, allocation: "1000000", "quote-token": w.usdc.address, quote, seller: w.seller, buyer: w.buyer, broker: w.broker, "broker-share": share, ...more };
  for (const [id, value] of Object.entries(entered)) await page.getByTestId(id).fill(value);
}
/** The broker prepares a deal in a browser with no wallet and returns its link's hash and its id. `form(page)` can change the form first. */
function prepare(site, w, size, entered, form = async () => {}) {
  return browse(site, "#/v3/new", { size }, async (page) => {
    await enter(page, w, entered);
    await form(page);
    await page.getByTestId("primary-action").click();
    const href = await until(async () => ((await page.getByTestId("deal-link").count()) ? page.getByTestId("deal-link").evaluate((el) => el.href) : null), "the deal's link");
    return { hash: href.slice(site.url.length + 1), id: await seen(page, "created-id") };
  });
}
/** What the receipt of a settled deal's page says, by handle. */
const receipt = async (page, ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await seen(page, `receipt-${id}`)])));

for (const [name, size] of SIZES) {
  test(`R3-01, R3-05 at ${name} width: a broker prepares an immediate deal with no wallet, the seller signs and funds, a fresh buyer checks it with no wallet, then signs and settles; the receipt and every balance are exact`, () => onSite(async (site, w) => {
    const fees = feesOf(LARGE, 2_000);
    await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
    await w.usdc.as(w.deployer).mint(w.buyer, fees.buyerTotal);
    const start = await w.holdings();

    // The broker, with no wallet: the exact money, then the link. Nothing exists on the chain, and nobody gained any right.
    const { hash, id } = await prepare(site, w, size, {}, async (page) => {
      await says(page, "version", "v3");
      for (const [handle, text] of Object.entries({ price: "100,000", "buyer-fee": "500", "buyer-total": "100,500", "seller-fee": "500", "seller-net": "99,500",
        "fee-pool": "1,000", "broker-fee": "200", "treasury-fee": "800" })) await says(page, handle, text);
      assert.match(await seen(page, "summary-delivery"), /^Immediate: 1,000,000 FAM go to the buyer/);
      await says(page, "summary-seller", w.seller);
      await says(page, "summary-buyer", w.buyer);
      assert.ok(await fits(page), "the form fits the window's width");
    });
    assert.match(hash, new RegExp(`^#/v3/d/31337/${w.v3.address.toLowerCase()}/[A-Za-z0-9_-]{308}$`), "the link names the chain and the contract, and carries the terms");
    assert.equal(await statusOf(w, id), STATUS3.Unfunded, "preparing a link funds nothing");
    assert.deepEqual(await w.moved(start), {}, "and moves nothing");

    // The seller: sees whose turn it is, then connects, approves, signs and funds.
    const asked = [];
    await browse(site, hash, { wallet: signerFor(w, "seller", () => null, asked), size }, async (page) => {
      await state(page, "awaiting");
      await says(page, "next-actor", "seller", "data-actor");
      await says(page, "funding", "false", "data-funded");
      await says(page, "deal-id", id);
      await says(page, "terms-seller", w.seller);
      await says(page, "terms-brokerBps", "2000");
      assert.ok(await fits(page), "the deal fits the window's width");
      assert.equal(await pressUntil(page, async () => (await seen(page, "deal-status", "data-status")) === "funded", "the deal to be funded"), 3, "connect, approve, sign and fund");
      await says(page, "next-actor", "buyer", "data-actor");
      await says(page, "funding", "true", "data-funded");
      assert.match(await seen(page, "last-receipt"), /^Signing and funding: confirmed in block \d+/);
    });
    assert.ok(asked.includes("eth_signTypedData_v4"), "the seller's wallet was asked to sign the typed terms");
    assert.equal(await statusOf(w, id), STATUS3.Funded);
    assert.deepEqual(await w.moved(start), { "seller.FAM": -ALLOCATION, "brokerDeals.FAM": ALLOCATION }, "funding moves the allocation and nothing else: no fee, nothing for the broker");

    // The buyer, in a fresh browser with no wallet: the funding, the delivery and the money, before connecting anything.
    await browse(site, hash, { size }, async (page) => {
      await state(page, "funded");
      await says(page, "funding", "true", "data-funded");
      await says(page, "delivery", "immediate", "data-delivery");
      for (const [handle, text] of Object.entries({ "pay-amount": "100,500", "receive-amount": "1,000,000", "buyer-total": "100,500", "broker-fee": "200", "treasury-fee": "800", broker: w.broker }))
        await says(page, handle, text);
      assert.equal(await offered(page), false, "with no wallet there is nothing to press");
      assert.match(await read(page), /There is no wallet in this browser/);
    });

    // The buyer's wallet: connect, approve, sign and settle. Then the receipt, which a reload still shows.
    const funded = await w.holdings();
    await browse(site, hash, { wallet: signerFor(w, "buyer"), size }, async (page) => {
      assert.equal(await pressUntil(page, async () => (await seen(page, "deal-status", "data-status")) === "settled", "the deal to be settled"), 3, "connect, approve, sign and settle");
      const expected = { paid: "100,500", "seller-net": "99,500", "buyer-fee": "500", "seller-fee": "500", "broker-fee": "200", "treasury-fee": "800" };
      assert.deepEqual(await receipt(page, Object.keys(expected)), expected);
      assert.match(await seen(page, "receipt-delivery"), /^All 1,000,000 FAM to the buyer's wallet$/);
      assert.match(await seen(page, "receipt-status"), /^confirmed, 1 block deep$/);
      await says(page, "receipt-network", "Local test chain, chain 31337");
      await says(page, "receipt-contract", w.v3.address.toLowerCase());
      await says(page, "receipt-deal", id);
      const tx = await seen(page, "settlement", "data-tx");
      assert.match(tx, /^0x[0-9a-f]{64}$/);
      assert.ok(await fits(page), "the receipt fits the window's width");
      await page.reload();
      await state(page, "settled");
      await says(page, "settlement", tx, "data-tx");
      assert.deepEqual(await receipt(page, Object.keys(expected)), expected, "after a reload the receipt is read from the chain again");
      await says(page, "next-actor", "none", "data-actor");
    });
    assert.equal(await statusOf(w, id), STATUS3.Settled);
    assert.deepEqual(await w.moved(funded), { "buyer.USDC": -fees.buyerTotal, "seller.USDC": fees.sellerNet, "broker.USDC": 200n * USDC, "treasury.USDC": 800n * USDC,
      "brokerDeals.FAM": -ALLOCATION, "buyer.FAM": ALLOCATION }, "the brief's 100,000 USDC fixture at 20%: 100,500 paid, 99,500 received, 200 to the broker, 800 to the treasury");
  }));
}

for (const [name, size] of SIZES) {
  test(`R3-01, R3-04, R3-05 at ${name} width: a vesting deal: the broker's form shows the schedule, the buyer's settlement funds a grant in a vault of its own, the receipt names it, and a claim pays the buyer only`, () => onSite(async (site, w) => {
    const fees = feesOf(QUOTE, 2_000);
    await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
    await w.usdc.as(w.deployer).mint(w.buyer, fees.buyerTotal);
    const { hash, id } = await prepare(site, w, size, { quote: "123.456789" }, async (page) => {
      await page.getByTestId("delivery-vesting").check();
      for (const [handle, text] of Object.entries({ "buyer-total": "124.074072", "seller-net": "122.839506", "fee-pool": "1.234566", "broker-fee": "0.246913", "treasury-fee": "0.987653" })) await says(page, handle, text);
      assert.match(await seen(page, "summary-schedule"), /^Starts when the buyer settles\. Cliff 30 days later: 333,333\.333333333333333333 FAM unlock at once\. Fully vested 90 days after the start/);
      assert.ok(await fits(page), "the form fits the window's width");
    });
    await browse(site, hash, { wallet: signerFor(w, "seller"), size }, async (page) => {
      await says(page, "delivery", "vesting", "data-delivery");
      await says(page, "terms-cliffSeconds", String(30 * DAY));
      await says(page, "terms-durationSeconds", String(90 * DAY));
      await pressUntil(page, async () => (await seen(page, "deal-status", "data-status")) === "funded", "the deal to be funded");
    });
    const funded = await w.holdings();
    await browse(site, hash, { wallet: signerFor(w, "buyer"), size }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "deal-status", "data-status")) === "settled", "the deal to be settled");
      const grant = await w.v3.read.getGrant(1);
      w.watch("vault", grant.custodian);
      assert.deepEqual(await w.moved(funded), { "buyer.USDC": -fees.buyerTotal, "seller.USDC": fees.sellerNet, "broker.USDC": 246_913n, "treasury.USDC": 987_653n,
        "brokerDeals.FAM": -ALLOCATION, "vault.FAM": ALLOCATION }, "the brief's 123.456789 USDC fixture at 20%, and the whole allocation in the grant's vault: the buyer holds none of it yet");
      assert.equal((await w.v3.read.getDeal(id)).grantId, 1n);
      await says(page, "receipt-delivery", "1", "data-grant");
      await says(page, "receipt-vault", grant.custodian.toLowerCase());
      await says(page, "receipt-broker-fee", "0.246913");
      await says(page, "grant-status", "cliff", "data-status");
      await says(page, "grant-backing", "true", "data-backed");
      await says(page, "grant-allocation", "1,000,000");
      await says(page, "next-actor", "buyer", "data-actor");
      assert.ok(await fits(page), "the settled deal, its grant and its receipt fit the window's width");

      // At the cliff the buyer claims a third: from the vault to the buyer, and nothing else moves.
      const settled = await w.holdings();
      await w.at(grant.cliff);
      await refresh(page);
      await says(page, "grant-claimable", "333,333.333333333333333333");
      await w.next(grant.cliff);
      await page.getByTestId("primary-action").click();
      await says(page, "grant-claimed", "333,333.333333333333333333");
      await until(async () => (await receiptsOf(page, "claimed")) === 1, "the claim's receipt");
      assert.deepEqual(await w.moved(settled), { "buyer.FAM": ALLOCATION / 3n, "vault.FAM": -(ALLOCATION / 3n) }, "a claim pays the buyer from the vault: no fee, and nothing for the broker");
    });
  }));
}

test("R3-02: the wallet is asked to sign exactly the terms on the page, for this chain and this contract; any other wallet is told whose turn it is, and is never asked to sign or send", () => onSite(async (site, w) => {
  const t = await w.terms3(), id = w.idOf(t), hash = linkTo(w, t);
  await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
  await w.usdc.as(w.deployer).mint(w.buyer, TOTAL);
  const start = await w.holdings();
  /** Opens the deal with `name`'s wallet, connects it, and expects no button but a notice saying `text`. */
  const turnedAway = async (name, text, actor) => {
    const asked = [];
    await browse(site, hash, { wallet: signerFor(w, name, () => null, asked) }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "notice"))?.includes(text) && !(await offered(page)), `the ${name}'s wallet told "${text}"`);
      await says(page, "next-actor", actor, "data-actor");
    });
    assert.ok(!asked.some((method) => /sign|sendTransaction/i.test(method)), `the ${name}'s wallet was never asked to sign or send: it was asked ${[...new Set(asked)]}`);
  };
  await turnedAway("other", `Only the seller, ${w.seller}, can fund this deal`, "seller");
  await turnedAway("broker", "You are this deal's broker. You cannot fund it, and the link gives nobody that right", "seller");
  await turnedAway("buyer", "it is not funded yet", "seller");
  assert.deepEqual(await w.moved(start), {}, "nothing moved, and the deal is still not on the chain");
  assert.equal(await statusOf(w, id), STATUS3.Unfunded);

  // The seller funds: what its wallet was asked to sign is the page's terms, under this chain and this contract.
  const requests = [];
  const seller = signerFor(w, "seller", (request) => {
    if (request.method === "eth_signTypedData_v4") requests.push(request.params);
    return null;
  });
  await browse(site, hash, { wallet: seller }, async (page) => {
    await says(page, "deal-id", id);
    for (const [field, value] of Object.entries(t)) assert.equal(await seen(page, `terms-${field}`), String(value).toLowerCase(), `the page shows ${field} as it is signed`);
    await says(page, "terms-network", "Local test chain, chain 31337");
    await says(page, "terms-contract", w.v3.address.toLowerCase());
    await says(page, "terms-domain", "OTC.fam Broker Deals, version 3");
    await pressUntil(page, async () => (await seen(page, "deal-status", "data-status")) === "funded", "the deal to be funded");
  });
  assert.equal(requests.length, 1, "one signature");
  const [[account, json]] = requests, { domain, primaryType, types: { EIP712Domain: _, ...types }, message } = JSON.parse(json);
  assert.equal(account, w.seller);
  assert.equal(primaryType, "BrokerTerms");
  assert.deepEqual(domain, { name: "OTC.fam Broker Deals", version: "3", chainId: 31337, verifyingContract: w.v3.address.toLowerCase() });
  for (const [field, value] of Object.entries(t)) assert.equal(String(message[field]).toLowerCase(), String(value).toLowerCase(), `the wallet signs ${field} as the page shows it`);
  assert.equal(TypedDataEncoder.hash(domain, types, message), id, "what the wallet signed is the deal's ID");
  assert.deepEqual(await w.moved(start), { "seller.FAM": -ALLOCATION, "brokerDeals.FAM": ALLOCATION });

  // Funded: only the buyer can settle. The seller is offered the refund, never the settlement.
  await turnedAway("other", `Only the buyer, ${w.buyer}, can settle this deal`, "buyer");
  await turnedAway("broker", "You are this deal's broker. You cannot settle it", "buyer");
  await browse(site, hash, { wallet: signerFor(w, "seller") }, async (page) => {
    await pressUntil(page, async () => (await page.getByTestId("refund-action").count()) === 1 && !(await offered(page)), "the seller's refund, and no way to settle");
    assert.match(await seen(page, "notice"), /only its buyer can settle it/);
  });
  assert.equal(await statusOf(w, id), STATUS3.Funded);
}));

test("R3-02: a link for another chain or another contract is refused, a cut link says so, and a changed link is another deal that nobody signed or funded", () => onSite(async (site, w) => {
  const t = await w.terms3(), id = await w.fund3(t), blob = packTerms(t), contract = w.v3.address.toLowerCase();
  const refused = (hash, text) => browse(site, hash, {}, async (page) => {
    await shows(page, "refusal", (said) => said.includes(text), `"${text}"`);
    await says(page, "deal-status", "not-found", "data-status");
    assert.equal(await offered(page), false);
  });
  await refused(`#/v3/d/1/${contract}/${blob}`, "This link is for chain 1 ");
  await refused(`#/v3/d/31337/${w.deals.address.toLowerCase()}/${blob}`, "A broker deal's terms are signed for one chain and one contract");
  await refused(`#/v3/d/31337/${contract}/${blob.slice(0, -2)}`, "This link does not carry a broker deal");
  await refused(`#/v3/d/31337/${contract}/0x${"12".repeat(32)}`, "The chain has no funded broker deal with the ID");

  // A funded deal is also found by its ID alone: the chain has its terms.
  await browse(site, `#/v3/d/31337/${contract}/${id}`, {}, async (page) => {
    await state(page, "funded");
    await says(page, "deal-id", id);
    await says(page, "terms-nonce", String(t.nonce));
    await says(page, "terms-quote", String(t.quote));
  });

  // One changed letter is other terms: another ID, which the seller never signed. With the same nonce it can never be funded.
  const changed = `${blob.slice(0, 150)}${blob[150] === "A" ? "B" : "A"}${blob.slice(151)}`;
  const before = await w.holdings();
  await browse(site, `#/v3/d/31337/${contract}/${changed}`, { wallet: signerFor(w, "buyer") }, async (page) => {
    await state(page, "void");
    assert.notEqual(await seen(page, "deal-id"), id, "another ID");
    assert.match(await seen(page, "next-actor"), /already funded another deal with nonce/);
    assert.equal(await offered(page), false);
  });
  assert.deepEqual(await w.moved(before), {});
}));

test("R3-02, R3-04: an expired deal can be neither funded nor settled and the page says why; the seller of a funded one takes the allocation back, with no fee and nothing for the broker", () => onSite(async (site, w) => {
  const soon = (await w.chain.now()) + 300;
  const unfunded = await w.terms3({ expiry: soon }), funded = await w.terms3({ expiry: soon });
  const id = await w.fund3(funded);
  await w.usdc.as(w.deployer).mint(w.buyer, TOTAL);
  await w.fam.as(w.deployer).mint(w.seller, ALLOCATION); // the seller could fund the other deal, were it not expired
  await w.at(soon);
  const before = await w.holdings();

  await browse(site, linkTo(w, unfunded), { wallet: signerFor(w, "seller") }, async (page) => {
    await state(page, "expired");
    await says(page, "next-actor", "none", "data-actor");
    assert.match(await seen(page, "next-actor"), /^Expired before it was funded\. Nobody can act on it any more/);
    assert.equal(await offered(page), false, "nothing to fund");
    assert.equal(await page.getByTestId("duplicate").count(), 1, "its terms can be duplicated into a new deal");
  });
  await browse(site, linkTo(w, funded), { wallet: signerFor(w, "buyer") }, async (page) => {
    await state(page, "expired");
    await says(page, "next-actor", "seller", "data-actor");
    assert.match(await seen(page, "next-actor"), /^Expired: it can no longer be settled\. Only the seller, /);
    await page.getByTestId("connect-action").click();
    await until(async () => (await page.getByTestId("connect-action").count()) === 0, "the buyer's wallet connected");
    assert.equal(await offered(page), false, "nothing to settle");
    assert.equal(await page.getByTestId("refund-action").count(), 0, "and the refund is not the buyer's");
  });
  assert.deepEqual(await w.moved(before), {}, "an expiry moves nothing");

  await browse(site, linkTo(w, funded), { wallet: signerFor(w, "seller") }, async (page) => {
    await page.getByTestId("connect-action").click();
    await until(async () => (await page.getByTestId("refund-action").count()) === 1 && (await page.getByTestId("refund-action").isEnabled()), "the seller's refund button");
    await page.getByTestId("refund-action").click();
    await state(page, "refunded");
    await until(async () => (await receiptsOf(page, "refunded")) === 1, "the refund's receipt");
    await says(page, "next-actor", "none", "data-actor");
  });
  assert.equal(await statusOf(w, id), STATUS3.Refunded);
  assert.deepEqual(await w.moved(before), { "seller.FAM": ALLOCATION, "brokerDeals.FAM": -ALLOCATION }, "the refund returns the allocation: no fee, nothing for the broker or the treasury");

  // The refunded deal's nonce is spent: the seller's terms with that nonce can never be funded, whatever else they say.
  const again = { ...funded, expiry: (await w.chain.now()) + DAY };
  await browse(site, linkTo(w, again), { wallet: signerFor(w, "seller") }, async (page) => {
    await state(page, "void");
    assert.match(await seen(page, "next-actor"), /^This deal cannot be funded\. The seller has already funded another deal with nonce/);
    assert.equal(await offered(page), false);
  });
}));

test("R3-05: a signature declined in the wallet, a transaction declined after signing and a wallet on another network each leave the page usable and truthful; the signature is asked for once", () => onSite(async (site, w) => {
  const t = await w.terms3(), id = w.idOf(t), hash = linkTo(w, t);
  await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
  await w.usdc.as(w.deployer).mint(w.buyer, TOTAL);
  const start = await w.holdings(), asked = [], declines = { signature: 1, fund: 1 };
  const seller = signerFor(w, "seller", (request) => {
    const what = request.method === "eth_signTypedData_v4" ? "signature" : request.method === "eth_sendTransaction" && request.params[0].data.startsWith(FUND) ? "fund" : null;
    return what && declines[what]-- > 0 ? DECLINED : null;
  }, asked);
  await browse(site, hash, { wallet: seller }, async (page) => {
    const declined = async () => (await seen(page, "notice")) === "You declined in your wallet. Nothing was sent.";
    await pressUntil(page, declined, "the notice of the declined signature");
    assert.equal(await page.getByTestId("notice").getAttribute("role"), "alert", "what went wrong is announced at once");
    await says(page, "primary-action", "Sign the terms and fund");
    await page.getByTestId("primary-action").click(); // signs, then declines the transaction
    await until(async () => declines.fund < 1 && (await declined()) && (await offered(page)), "the notice of the declined transaction");
    assert.equal(await statusOf(w, id), STATUS3.Unfunded);
    assert.deepEqual(await w.moved(start), { }, "two refusals: only the approval was sent, and it moves nothing");
    await page.getByTestId("primary-action").click();
    await state(page, "funded");
  });
  assert.equal(asked.filter((method) => method === "eth_signTypedData_v4").length, 2, "one signature declined and one given: the declined transaction did not ask for it again");

  let chainId = "0x1";
  const elsewhere = signerFor(w, "buyer", async (request, answer) => {
    if (request.method === "eth_chainId") return { result: chainId };
    if (request.method !== "wallet_switchEthereumChain") return null;
    chainId = request.params[0].chainId;
    return answer(request);
  });
  await browse(site, hash, { wallet: elsewhere }, async (page) => {
    await pressUntil(page, async () => (await seen(page, "primary-action")) === "Switch to Local test chain", "the offer to switch network");
    assert.match(await read(page), /Your wallet is on Ethereum, and this deal is on Local test chain\. Nothing can be signed or sent until it is switched\./);
    await pressUntil(page, async () => (await seen(page, "deal-status", "data-status")) === "settled", "the deal settled once the wallet switched");
  });
  assert.equal(await statusOf(w, id), STATUS3.Settled);
}));

test("R3-05: a page reloaded while its settlement is on its way takes it up again, and ends with the receipt", () => onSite(async (site, w) => {
  const t = await w.terms3(), id = await w.fund3(t);
  await w.usdc.as(w.deployer).mint(w.buyer, TOTAL);
  await browse(site, linkTo(w, t), { wallet: signerFor(w, "buyer") }, async (page) => {
    const held = { on: false }; // while it is on, the page is told that no transaction has a receipt yet
    await page.route("**/rpc", async (route) => {
      const request = route.request().postDataJSON();
      if (held.on && request.method === "eth_getTransactionReceipt") return route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: null } });
      return route.continue();
    });
    await pressUntil(page, async () => (await seen(page, "primary-action")) === "Sign and settle: pay 124.074072 USDC", "the settle button");
    held.on = true;
    await page.getByTestId("primary-action").click();
    await until(async () => (await statusOf(w, id)) === STATUS3.Settled, "the settlement mined");
    await page.reload();
    await until(async () => (await read(page)).includes("This page was reloaded while transaction 0x"), "the page waiting for its transaction again");
    assert.equal(await page.getByTestId("stop-waiting").count(), 1, "the person can stop waiting");
    held.on = false;
    await noticeSays(page, "The transaction sent before this page was reloaded is confirmed.");
    await state(page, "settled");
    await says(page, "receipt-broker-fee", "0.246913");
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("otcfam:pending")).length), 0, "nothing is left waiting");
  });
}));

test("R3-05: the history lists a person's deals by role, from this browser and from the chain: awaiting funding, funded, settled, expired and refunded, each with its pair, price, share, deadline and receipt", () => onSite(async (site, w) => {
  const soon = (await w.chain.now()) + 300;
  const settled = await w.terms3({ quote: LARGE }), refunded = await w.terms3({ brokerBps: 0 }), funded = await w.vesting3(), expired = await w.terms3({ expiry: soon }), awaiting = await w.terms3();
  const ids = { settled: await w.fund3(settled), refunded: await w.fund3(refunded), funded: await w.fund3(funded), expired: w.idOf(expired), awaiting: w.idOf(awaiting) };
  await w.settle3(settled);
  await w.v3.as(w.seller).refund(ids.refunded);
  await w.at(soon);
  const rows = (page) => page.getByTestId("deal-row").evaluateAll((list) => Object.fromEntries(list.map((row) => [row.dataset.id, `${row.dataset.status} as ${row.dataset.role}`])));
  const listed = async (page, expected, what) => {
    await until(async () => JSON.stringify(Object.entries(await rows(page)).sort()) === JSON.stringify(Object.entries(expected).sort()), what);
  };
  const cell = (page, id, handle) => page.locator(`[data-testid="deal-row"][data-id="${id}"] [data-testid="${handle}"]`);

  // A browser that never saw these deals, with no wallet: an address is enough to read what the chain has for it, by role.
  await browse(site, "#/v3/deals", {}, async (page) => {
    await shows(page, "no-deals", (text) => text.startsWith("No deals here yet"), "an empty list");
    await page.getByTestId("who").fill(w.broker);
    await listed(page, { [ids.settled]: "settled as broker", [ids.refunded]: "refunded as broker", [ids.funded]: "funded as broker" }, "the three deals the chain has for the broker");
    assert.deepEqual(await Promise.all(["row-pair", "row-quote", "row-share", "row-role"].map((handle) => cell(page, ids.settled, handle).innerText())),
      ["FAM / USDC", "100,000 USDC", "200 USDC", "Broker: you receive the share"]);
    assert.match(await cell(page, ids.settled, "row-deadline").innerText(), /^\w{3}, \d{1,2} \w{3} \d{4}, \d{2}:\d{2}:\d{2} UTC$/, "the deadline, in UTC");
    assert.equal(await cell(page, ids.settled, "row-receipt").getAttribute("data-kind"), "settled");
    assert.match(await page.locator(`[data-testid="deal-row"][data-id="${ids.settled}"] a.mono`).getAttribute("href"), /^https:\/\/explorer\.invalid\/tx\/0x[0-9a-f]{64}$/, "the receipt links to the explorer");
    assert.equal(await cell(page, ids.settled, "row-open").getAttribute("href"), linkTo(w, settled), "and the row links to the deal's page, which holds the full receipt");
    assert.equal(await cell(page, ids.refunded, "row-receipt").getAttribute("data-kind"), "refunded");
    assert.equal(await cell(page, ids.refunded, "row-share").innerText(), "0 USDC");
    assert.ok(await fits(page), "the list fits a phone's width");
    await page.getByTestId("who").fill(w.seller);
    await listed(page, { [ids.settled]: "settled as seller", [ids.refunded]: "refunded as seller", [ids.funded]: "funded as seller" }, "the same deals, as their seller");
    await page.getByTestId("who").fill(w.buyer);
    await listed(page, { [ids.settled]: "settled as buyer" }, "what the buyer settled");
    await page.getByTestId("who").fill(w.other);
    await listed(page, {}, "nothing for a stranger");
  });

  // The broker's own browser: a deal prepared here and two links opened here are known before any wallet is connected.
  await browse(site, "#/v3/new", { wallet: signerFor(w, "broker"), size: DESKTOP }, async (page) => {
    await enter(page, w, { quote: "123.456789" });
    await page.getByTestId("primary-action").click();
    await until(async () => (await page.getByTestId("created-id").count()) === 1, "the prepared deal");
    const prepared = await seen(page, "created-id");
    for (const t of [expired, awaiting]) {
      await page.goto(`${site.url}/${linkTo(w, t)}`);
      await says(page, "deal-id", w.idOf(t));
    }
    await page.goto(`${site.url}/#/v3/deals`);
    await listed(page, { [prepared]: "awaiting as broker", [ids.expired]: "expired as here", [ids.awaiting]: "awaiting as here" }, "the deals this browser knows");
    await page.getByTestId("connect-action").click();
    const all = { [prepared]: "awaiting as broker", [ids.expired]: "expired as broker", [ids.awaiting]: "awaiting as broker", [ids.settled]: "settled as broker",
      [ids.refunded]: "refunded as broker", [ids.funded]: "funded as broker" };
    await listed(page, all, "with the broker's wallet: this browser's deals and the chain's, all as broker");
    assert.ok(await fits(page), "the list fits a desktop's width");

    // By role, from the keyboard: the pressed filter keeps the focus and says that it is pressed.
    await page.getByTestId("role-seller").focus();
    await page.keyboard.press("Enter");
    await listed(page, {}, "no deal as seller");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "role-seller");
    await says(page, "role-seller", "true", "aria-pressed");
    await page.getByTestId("role-broker").click();
    await listed(page, all, "the six deals as broker");

    // Duplicate terms: the form starts from them, and what it makes is another deal. The old one is unchanged.
    await cell(page, ids.settled, "row-duplicate").click();
    for (const [handle, text] of Object.entries({ "buyer-total": "100,500", "broker-fee": "200", "treasury-fee": "800" })) await says(page, handle, text);
    assert.deepEqual(await Promise.all(["seller", "buyer", "broker", "quote", "allocation", "broker-share"].map((handle) => page.getByTestId(handle).inputValue())),
      [w.seller, w.buyer, w.broker, "100000", "1000000", "20"]);
    await page.getByTestId("primary-action").click();
    await until(async () => (await page.getByTestId("created-id").count()) === 1, "the duplicated deal");
    assert.notEqual(await seen(page, "created-id"), ids.settled, "another deal, with another ID");
  });
  assert.equal(await statusOf(w, ids.settled), STATUS3.Settled, "the deal the terms came from is as it was");
}, { explorerUrl: "https://explorer.invalid" }));

test("R3-05: the seller's funding can be done from the keyboard alone: the button keeps the focus from one step to the next", () => onSite(async (site, w) => {
  const t = await w.terms3(), id = w.idOf(t);
  await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
  await browse(site, linkTo(w, t), { wallet: signerFor(w, "seller"), size: DESKTOP }, async (page) => {
    await page.getByTestId("primary-action").focus();
    const focused = () => page.evaluate(() => document.activeElement?.dataset.testid === "primary-action" && !document.activeElement.disabled);
    for (const label of ["Connect wallet", "Approve 1,000,000 FAM", "Sign the terms and fund"]) {
      await until(async () => (await focused()) && (await seen(page, "primary-action")) === label, `"${label}" focused and ready`);
      await page.keyboard.press("Enter");
    }
    await until(async () => (await statusOf(w, id)) === STATUS3.Funded, "the deal funded with three presses of Enter");
    await state(page, "funded");
    assert.equal(await seen(page, "deal-status"), "Funded", "the status is said in words, not only in colour");
  });
}));

test("R3-05: the broker's form shows the broker's exact share for any rate before a link exists, and refuses terms the contract would refuse", () => onSite(async (site, w) => {
  await browse(site, "#/v3/new", {}, async (page) => {
    await enter(page, w, { quote: "123.456789" });
    for (const [share, broker, treasury] of [["20", "0.246913", "0.987653"], ["0", "0", "1.234566"], ["100", "1.234566", "0"], ["12.5", "0.15432", "1.080246"], ["0.01", "0.000123", "1.234443"]]) {
      await page.getByTestId("broker-share").fill(share);
      await says(page, "broker-fee", broker);
      await says(page, "treasury-fee", treasury);
    }
    const refuses = async (field, value, label) => {
      await page.getByTestId(field).fill(value);
      await says(page, "primary-action", label);
      assert.equal(await offered(page), false, `${label}: no link can be made`);
    };
    await refuses("broker-share", "100.01", "Check the broker's share");
    await page.getByTestId("broker-share").fill("20");
    await refuses("buyer", w.seller, "Check the buyer's address");
    await page.getByTestId("buyer").fill(w.buyer);
    await refuses("broker", w.buyer, "Check the broker's address");
    await refuses("broker", w.v3.address, "Check the broker's address");
    await page.getByTestId("broker").fill(w.broker);
    await refuses("quote-token", w.fam.address, "Pick two different tokens");
    await refuses("quote-token", w.other, "Check the payment token");
    await page.getByTestId("quote-token").fill(w.usdc.address);
    await says(page, "primary-action", "Create the deal link");
    assert.equal(await offered(page), true, "with no wallet in the browser at all");
  });
}));

test("a site without a broker deals contract offers none of it and says so at a broker deal's link; a site with one links to the form and the history from its start", async () => {
  const w = await world3(), t = await w.terms3();
  const without = await serve(w, { contractV3: undefined }), site = await serve(w);
  try {
    await browse(without, "#/", {}, async (page) => {
      await until(async () => (await read(page)).includes("One deal, one link"), "the start page");
      assert.equal(await page.getByTestId("broker-new").count(), 0);
      for (const hash of ["#/v3/new", "#/v3/deals", linkTo(w, t)]) {
        await page.goto(`${without.url}/${hash}`);
        await until(async () => (await read(page)).includes("Broker deals are not set up here"), `${hash} saying that broker deals are not set up`);
      }
    });
    await browse(site, "#/", {}, async (page) => {
      await until(async () => (await page.getByTestId("broker-new").count()) === 1, "the start page's link to the broker's form");
      assert.equal(await page.getByTestId("broker-deals").getAttribute("href"), "#/v3/deals");
      await page.getByTestId("broker-new").click();
      await says(page, "version", "v3");
    });
  } finally {
    await without.close();
    await site.close();
  }
});
