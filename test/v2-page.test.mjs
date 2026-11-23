// The v2 pages, used as a person uses them: the seller's form, the buyer's fresh browser, the grant on its schedule,
// the refusal of an existing position, and the ways back from a declined, failed, replaced or interrupted transaction.
// Each test builds the page, serves it for a fresh v2 world (test/lib/v2-site.mjs) and drives it in Chromium at a
// phone's width, a desktop's, or both ("npx playwright install chromium"). What moved is always read from the chain.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { browse, closeBrowser, DESKTOP, fits, offered, PHONE, pressUntil, read, seen, serve, shows, until, walletFor } from "./lib/v2-site.mjs";
import { ALLOCATION, DAY, feeOn, QUOTE, STATUS, world } from "./lib/v2-world.mjs";

after(closeBrowser);

const TOTAL = QUOTE + feeOn(QUOTE);
const FILL = "0x3fda5389"; // fill(uint256)
const says = (page, id, text, name) => shows(page, id, (t) => t === text, JSON.stringify(text), name);
const noticeSays = (page, text) => shows(page, "notice", (t) => t.includes(text), `a notice saying "${text}"`);
/** Makes the page read the chain now, as it does every few seconds and whenever its window gets the focus. */
const refresh = (page) => page.evaluate(() => dispatchEvent(new Event("focus")));
const statusOf = async (w, id) => (await w.deals.read.getDeal(id)).status;

/** Runs `steps(site, w)` on a fresh v2 world `w` whose page is served at `site`. */
async function onSite(steps) {
  const w = await world();
  const site = await serve(w);
  try {
    await steps(site, w);
  } finally {
    await site.close();
  }
}

/** Types the deal of the tests (a million FAM for 123.456789 USDC, for the buyer) into the form at #/v2/new. */
async function enter(page, w, more = {}) {
  const entered = { "base-token": w.fam.address, allocation: "1000000", "quote-token": w.usdc.address, quote: "123.456789", buyer: w.buyer, ...more };
  for (const [id, value] of Object.entries(entered)) await page.getByTestId(id).fill(value);
}
const link = (page) => page.getByTestId("deal-link").evaluate((el) => el.href).catch(() => null);

for (const [name, size] of [["a phone's", PHONE], ["a desktop's", DESKTOP]]) {
  test(`at ${name} width: the seller funds an immediate deal and gets one link; a fresh buyer checks it with no wallet, then settles it`, () => onSite(async (site, w) => {
    await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
    await w.usdc.as(w.deployer).mint(w.buyer, TOTAL);
    await browse(site, "#/v2/new", { wallet: walletFor(w, w.seller), size }, async (page) => {
      await enter(page, w);
      await says(page, "version", "v2");
      for (const [id, text] of Object.entries({ price: "123.456789", "buyer-fee": "0.617283", "buyer-total": "124.074072", "seller-fee": "0.617283",
        "seller-net": "122.839506", "treasury-fee": "1.234566", treasury: w.treasury })) await says(page, id, text);
      assert.match(await seen(page, "summary-delivery"), /^Immediate: 1,000,000 FAM go to the buyer/);
      assert.ok(await fits(page), "the form fits the window's width");
      assert.equal(await pressUntil(page, async () => /#\/v2\/d\/\d+$/.test((await link(page)) ?? ""), "the deal's link"), 3, "connect, approve, fund");
      assert.equal(await link(page), `${site.url}/#/v2/d/1`);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "deal-link", "the link has the focus: one more key copies or opens it");
    });
    const deal = await w.deals.read.getDeal(1);
    assert.deepEqual([deal.seller.toLowerCase(), deal.terms.buyer.toLowerCase(), deal.terms.allocation, deal.terms.quote, deal.terms.delivery, deal.terms.durationSeconds, deal.status],
      [w.seller, w.buyer, ALLOCATION, QUOTE, 0n, 0n, STATUS.Funded]);

    await browse(site, "#/v2/d/1", { size }, async (page) => { // a browser with no wallet at all
      await says(page, "deal-status", "funded", "data-status");
      for (const [id, text] of Object.entries({ version: "v2", "pay-amount": "124.074072", "pay-symbol": "USDC", "receive-amount": "1,000,000", "receive-symbol": "FAM",
        seller: w.seller, buyer: w.buyer, price: "123.456789", "buyer-fee": "0.617283", "buyer-total": "124.074072", "seller-fee": "0.617283",
        "seller-net": "122.839506", "treasury-fee": "1.234566", treasury: w.treasury })) await says(page, id, text);
      await says(page, "delivery", "immediate", "data-delivery");
      await says(page, "funding", "true", "data-funded");
      await says(page, "expires", String(deal.terms.expiry), "data-expiry");
      assert.match(await seen(page, "funding"), /the deal contract holds the seller's 1,000,000 FAM for this deal/);
      assert.equal(await offered(page), false, "nothing to press without a wallet");
      assert.ok(await fits(page), "the deal fits the window's width");
    });

    const before = await w.holdings();
    await browse(site, "#/v2/d/1", { wallet: walletFor(w, w.buyer), size }, async (page) => {
      const buttons = [];
      await pressUntil(page, async () => (await statusOf(w, 1)) === STATUS.Settled, "the deal settled", async () => buttons.push(await seen(page, "primary-action")));
      assert.deepEqual(buttons.slice(0, 3), ["Connect wallet", "Approve 124.074072 USDC", "Settle: pay 124.074072 USDC"]);
      await says(page, "deal-status", "settled", "data-status");
      assert.match(await read(page), /Delivered: the 1,000,000 FAM are in the buyer's wallet\./);
      const tx = await seen(page, "last-receipt", "data-tx");
      assert.match(tx, /^0x[0-9a-f]{64}$/, "the settlement's receipt is shown");
      await until(async () => (await page.locator('[data-testid="receipts"] li[data-kind="settled"]').getAttribute("data-tx").catch(() => null)) === tx, "the settlement among the deal's receipts");
      assert.match(await page.locator('[data-testid="receipts"] li[data-kind="settled"]').innerText(), /Settled: buyer fee 0\.617283 USDC, seller fee 0\.617283 USDC/);
      assert.ok(await fits(page));
    });
    assert.deepEqual(await w.moved(before), { "buyer.USDC": -TOTAL, "seller.USDC": QUOTE - feeOn(QUOTE), "treasury.USDC": 2n * feeOn(QUOTE), "buyer.FAM": ALLOCATION, "deals.FAM": -ALLOCATION });
  }));
}

test("a vesting deal: the form shows the schedule; once settled its page is the grant's, and follows the chain's time through the cliff, a claim and the end", () => onSite(async (site, w) => {
  await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
  await w.usdc.as(w.deployer).mint(w.buyer, TOTAL);
  await browse(site, "#/v2/new", { wallet: walletFor(w, w.seller), size: DESKTOP }, async (page) => {
    await page.getByTestId("delivery-vesting").check();
    await enter(page, w);
    assert.equal(await seen(page, "summary-schedule"), "Starts when the buyer settles. Cliff 30 days later: 333,333.333333333333333333 FAM unlock at once. "
      + "Fully vested 90 days after the start; until then it unlocks second by second.");
    await pressUntil(page, async () => (await link(page)) === `${site.url}/#/v2/d/1`, "the deal's link");
  });
  const { terms } = await w.deals.read.getDeal(1);
  assert.deepEqual([terms.delivery, terms.fixedStart, terms.cliffSeconds, terms.durationSeconds], [1n, 0n, BigInt(30 * DAY), BigInt(90 * DAY)]);

  for (const size of [PHONE, DESKTOP]) {
    await browse(site, "#/v2/d/1", { size }, async (page) => { // the buyer's first look, with no wallet
      await says(page, "delivery", "vesting", "data-delivery");
      assert.match(await seen(page, "delivery"), /Vesting delivery: the buyer gets a new grant that unlocks over time\. Settled does not mean unlocked\./);
      await says(page, "schedule-start", "When the buyer settles, at that block's time");
      assert.match(await seen(page, "schedule-cliff"), /^30 days after the start\. Nothing can be claimed before it; then 333,333\.333333333333333333 FAM unlock at once\.$/);
      assert.match(await seen(page, "schedule-end"), /^90 days after the start\./);
      assert.ok(await fits(page));
    });
  }

  await browse(site, "#/v2/d/1", { wallet: walletFor(w, w.buyer), size: PHONE }, async (page) => {
    await pressUntil(page, async () => (await statusOf(w, 1)) === STATUS.Settled, "the deal settled");
    const { start, cliff, end, custodian } = await w.deals.read.getGrant(1);
    const shown = async (expected) => {
      for (const [id, text] of Object.entries(expected)) await says(page, `grant-${id}`, text, id === "status" ? "data-status" : undefined);
    };
    const moveTo = async (time) => {
      await w.at(time);
      await refresh(page);
      await says(page, "as-of", String(await w.chain.rpc("eth_blockNumber", []).then(Number)), "data-block");
    };

    // Settled is not unlocked.
    await says(page, "deal-status", "settled", "data-status");
    await shown({ status: "cliff", allocation: "1,000,000", vested: "0", claimed: "0", claimable: "0", locked: "1,000,000" });
    await says(page, "vault", custodian.toLowerCase());
    await says(page, "grant-backing", "true", "data-backed");
    for (const [id, time] of [["start", start], ["cliff", cliff], ["end", end]]) await says(page, `grant-${id}`, String(time), "data-time");
    assert.match(await seen(page, "grant-start"), /^\w{3}, \d{1,2} \w{3} \d{4}, \d{2}:\d{2}:\d{2} UTC$/, "dates are written in UTC");
    assert.equal(await seen(page, "primary-action"), "Nothing to claim yet");
    assert.equal(await offered(page), false);
    assert.match(await seen(page, "grant-next"), /^Nothing can be claimed yet\. Claiming becomes possible at the cliff, .* UTC \(in 30 days\)\. Then 333,333\.333333333333333333 FAM unlock at once/);
    assert.match(await page.locator(".timeline").getAttribute("aria-label"), /^Vesting timeline: 0% vested, 0% claimed, 100% locked\. Before the cliff\.$/);

    await moveTo(start + BigInt(29 * DAY)); // day 29
    await shown({ status: "cliff", vested: "0", claimable: "0" });
    assert.match(await seen(page, "grant-next"), /\(tomorrow\)|\(in 24 hours\)/);
    assert.equal(await offered(page), false);

    await moveTo(cliff); // day 30: what accrued since the start unlocks at once
    await shown({ status: "vesting", vested: "333,333.333333333333333333", claimable: "333,333.333333333333333333", locked: "666,666.666666666666666667" });
    assert.equal(await seen(page, "primary-action"), "Claim 333,333.333333333333333333 FAM");

    await moveTo(start + BigInt(45 * DAY)); // day 45: half
    await shown({ vested: "500,000", claimable: "500,000", locked: "500,000" });
    const before = await w.holdings();
    await w.next(start + BigInt(45 * DAY));
    await page.getByTestId("primary-action").click();
    await shown({ claimed: "500,000", claimable: "0", vested: "500,000", locked: "500,000" });
    assert.deepEqual(await w.moved(before), { "buyer.FAM": ALLOCATION / 2n }, "the claim paid the buyer, and took no fee");
    assert.equal(await w.fam.read.balanceOf(custodian), ALLOCATION / 2n);
    assert.match(await seen(page, "last-receipt", "data-tx"), /^0x[0-9a-f]{64}$/, "the claim's receipt is shown");
    await until(async () => (await page.locator('[data-testid="receipts"] li[data-kind="claimed"]').innerText().catch(() => "")).includes("Claimed 500,000 FAM"), "the claim among the receipts");
    assert.match(await seen(page, "grant-next"), /^Everything vested so far is claimed\. 500,000 FAM are still locked/);
    assert.equal(await seen(page, "primary-action"), "Nothing to claim yet");

    await moveTo(end); // day 90: everything, the earlier claim deducted
    await shown({ status: "vested", vested: "1,000,000", claimed: "500,000", claimable: "500,000", locked: "0" });
    await page.getByTestId("primary-action").click();
    await shown({ status: "claimed", claimed: "1,000,000", claimable: "0" });
    assert.equal(await offered(page), false, "nothing is left to claim");
    assert.equal(await w.fam.read.balanceOf(w.buyer), ALLOCATION);
    assert.equal(await page.locator('[data-testid="receipts"] li[data-kind="claimed"]').count(), 2);
    assert.ok(await fits(page));
  });
}));

test("a fixed vesting start is entered and shown in UTC, and the deal can be settled only until then", () => onSite(async (site, w) => {
  await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
  const start = Math.floor(Date.now() / 1000 / 60) * 60 + 7200, text = new Date(start * 1000).toISOString().slice(0, 16).replace("T", " ");
  await browse(site, "#/v2/new", { wallet: walletFor(w, w.seller) }, async (page) => {
    await page.getByTestId("delivery-vesting").check();
    await page.getByTestId("start-fixed").check();
    await enter(page, w, { "start-utc": "2026-02-31 10:00", "cliff-days": "90" });
    await until(async () => (await page.locator(".note.problem").allInnerTexts()).some((t) => t.includes("in UTC, like 2026-12-01 00:00")), "a date that does not exist is refused");
    await until(async () => (await page.locator(".note.problem").allInnerTexts()).some((t) => t.includes("The cliff must be shorter than the whole vesting")), "a cliff as long as the vesting is refused");
    await enter(page, w, { "start-utc": text, "cliff-days": "0.5" });
    await pressUntil(page, async () => (await link(page)) === `${site.url}/#/v2/d/1`, "the deal's link");
  });
  const { terms } = await w.deals.read.getDeal(1);
  assert.deepEqual([terms.fixedStart, terms.cliffSeconds, terms.durationSeconds], [BigInt(start), 43_200n, BigInt(90 * DAY)]);
  await browse(site, "#/v2/d/1", {}, async (page) => {
    await says(page, "schedule-start", String(start), "data-seconds");
    assert.match(await seen(page, "schedule-start"), /:00 UTC$/);
    assert.match(await seen(page, "expires"), /UTC \(in 2 hours\)$/, "the deal stays open for a day, and can be settled only until the vesting starts");
    await w.at(start + 1);
    await refresh(page);
    await says(page, "deal-status", "expired", "data-status");
    assert.match(await read(page), /fixed vesting start passed .* A grant cannot start before it is funded, so the deal can no longer be settled\./);
    assert.equal(await offered(page), false);
  });
}));

test("an existing vesting position is refused on the page, before the wallet is asked for anything", () => onSite(async (site, w) => {
  const asked = [];
  await browse(site, "#/v2/new", { wallet: walletFor(w, w.seller, () => null, asked) }, async (page) => {
    await enter(page, w, { "base-token": "https://app.sablier.com/stream/LL2-1-1234" });
    await until(async () => (await page.locator(".note.problem").allInnerTexts()).some((t) => t.includes("An existing vesting position, or a link to one, cannot be sold here")), "the link is refused as a token");
    await page.getByTestId("delivery-existing").check();
    await page.getByTestId("existing-position").fill("Sablier stream #1234, 250,000 FAM until 2027");
    await noticeSays(page, "otc.fam cannot sell an existing vesting position.");
    await noticeSays(page, "Nothing was asked of your wallet.");
    assert.equal(await seen(page, "primary-action"), "Existing positions are not supported");
    assert.equal(await offered(page), false);
    await page.waitForTimeout(500);
  });
  assert.deepEqual([...new Set(asked)].sort(), ["eth_accounts", "eth_chainId"], "the wallet was never asked to connect, approve or send");
}));

test("a wallet that is not the buyer's is told whose deal it is, a wallet on another network switches first, and the seller cancels from the page", () => onSite(async (site, w) => {
  const t = await w.terms();
  const id = await w.fund(t), cancelled = await w.fund(t);
  await w.usdc.as(w.deployer).mint(w.buyer, TOTAL);
  await w.usdc.as(w.deployer).mint(w.other, TOTAL);
  await browse(site, `#/v2/d/${id}`, { wallet: walletFor(w, w.other) }, async (page) => {
    await pressUntil(page, async () => (await seen(page, "notice"))?.includes(`only ${w.buyer} can settle it`) && !(await offered(page)), "a notice naming the buyer, and nothing to press");
  });
  let chainId = "0x1";
  const elsewhere = walletFor(w, w.buyer, async (request, answer) => {
    if (request.method === "eth_chainId") return { result: chainId };
    if (request.method !== "wallet_switchEthereumChain") return null;
    const reply = await answer(request);
    if (!reply.error) chainId = request.params[0].chainId;
    return reply;
  });
  const buttons = [];
  await browse(site, `#/v2/d/${id}`, { wallet: elsewhere }, (page) =>
    pressUntil(page, async () => (await statusOf(w, id)) === STATUS.Settled, "the deal settled", async () => buttons.push(await seen(page, "primary-action"))));
  assert.deepEqual(buttons.slice(0, 4), ["Connect wallet", "Switch to Local test chain", "Approve 124.074072 USDC", "Settle: pay 124.074072 USDC"]);

  const before = await w.holdings();
  await browse(site, `#/v2/d/${cancelled}`, { wallet: walletFor(w, w.seller) }, async (page) => {
    await pressUntil(page, async () => (await page.getByTestId("cancel-action").count()) === 1, "the seller's cancel button");
    assert.equal(await offered(page), false, "no settlement is offered to the seller");
    await page.getByTestId("cancel-action").click();
    await says(page, "deal-status", "cancelled", "data-status");
    await until(async () => (await page.locator('[data-testid="receipts"] li[data-kind="cancelled"]').count()) === 1, "the cancellation among the receipts");
  });
  assert.deepEqual(await w.moved(before), { "seller.FAM": ALLOCATION, "deals.FAM": -ALLOCATION }, "the allocation is back, and no fee was taken");
}));

test("a press declined in the wallet, a transaction that fails on the chain and one the wallet replaces each leave the page usable and truthful", () => onSite(async (site, w) => {
  const t = await w.terms();
  const declinedId = await w.fund(t), failedId = await w.fund(t), replacedId = await w.fund(t);
  await w.usdc.as(w.deployer).mint(w.buyer, 3n * TOTAL);

  let declined = false;
  const once = walletFor(w, w.buyer, (request) => {
    if (request.method !== "eth_sendTransaction" || declined) return null;
    declined = true;
    return { error: { code: 4001, message: "User rejected the request." } };
  });
  await browse(site, `#/v2/d/${declinedId}`, { wallet: once }, async (page) => {
    await pressUntil(page, async () => (await seen(page, "notice")) === "You declined in your wallet. Nothing was sent.", "the notice of the declined approval");
    assert.equal(await seen(page, "primary-action"), "Approve 124.074072 USDC");
    await pressUntil(page, async () => (await statusOf(w, declinedId)) === STATUS.Settled, "the deal settled after all");
  });

  let starved = false;
  const before = await w.holdings();
  const starving = walletFor(w, w.buyer, (request, answer) => {
    if (request.method !== "eth_sendTransaction" || !request.params[0].data.startsWith(FILL) || starved) return null;
    starved = true; // the first settlement is sent with too little gas: it is mined, and fails
    return answer({ ...request, params: [{ ...request.params[0], gas: "0x7530" }] });
  });
  await browse(site, `#/v2/d/${failedId}`, { wallet: starving }, async (page) => {
    await pressUntil(page, async () => (await seen(page, "notice"))?.includes("failed on the chain"), "the notice of the failed settlement");
    assert.equal(await statusOf(w, failedId), STATUS.Funded);
    assert.deepEqual(await w.moved(before), {}, "a settlement that failed moved nothing");
    await says(page, "deal-status", "funded", "data-status");
    await pressUntil(page, async () => (await statusOf(w, failedId)) === STATUS.Settled, "the deal settled at the next press");
  });

  // The wallet sends another transaction in the place of the one it told the page about, as "speed up" does.
  const replacing = walletFor(w, w.buyer, async (request, answer) => {
    if (request.method !== "eth_sendTransaction" || !request.params[0].data.startsWith(FILL)) return null;
    await answer(request);
    return { result: `0x${"ab".repeat(32)}` };
  });
  await browse(site, `#/v2/d/${replacedId}`, { wallet: replacing }, async (page) => {
    await pressUntil(page, async () => (await seen(page, "notice"))?.includes("Your wallet replaced this transaction"), "the notice of the replaced settlement");
    await says(page, "deal-status", "settled", "data-status");
    assert.equal(await offered(page), false, "the page does not offer to settle a deal that the replacement settled");
  });
}));

test("a page reloaded while its transaction is on its way takes it up again: a settlement, and a funding that still ends with the link", () => onSite(async (site, w) => {
  const t = await w.terms();
  const id = await w.fund(t);
  await w.usdc.as(w.deployer).mint(w.buyer, TOTAL);
  await w.fam.as(w.deployer).mint(w.seller, ALLOCATION);
  /** While `held.on`, the page is told that no transaction has a receipt yet: its transactions stay "on their way". */
  const hold = async (page, held) => page.route("**/rpc", async (route) => {
    const request = route.request().postDataJSON();
    if (held.on && request.method === "eth_getTransactionReceipt") return route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: null } });
    return route.continue();
  });

  await browse(site, `#/v2/d/${id}`, { wallet: walletFor(w, w.buyer) }, async (page) => {
    const held = { on: false };
    await hold(page, held);
    await pressUntil(page, async () => (await seen(page, "primary-action")) === "Settle: pay 124.074072 USDC", "the settle button");
    held.on = true;
    await page.getByTestId("primary-action").click();
    await until(async () => (await statusOf(w, id)) === STATUS.Settled, "the settlement mined");
    await says(page, "primary-action", "Settling the deal…");
    await page.reload();
    await until(async () => (await read(page)).includes("This page was reloaded while transaction 0x"), "the page waiting for its transaction again");
    assert.equal(await page.getByTestId("stop-waiting").count(), 1, "the person can stop waiting");
    held.on = false;
    await noticeSays(page, "The transaction sent before this page was reloaded is confirmed.");
    await says(page, "deal-status", "settled", "data-status");
    assert.match(await seen(page, "last-receipt", "data-tx"), /^0x[0-9a-f]{64}$/);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("otcfam:pending")).length), 0, "nothing is left waiting");
  });

  await browse(site, "#/v2/new", { wallet: walletFor(w, w.seller) }, async (page) => {
    const held = { on: false };
    await hold(page, held);
    await enter(page, w);
    await pressUntil(page, async () => (await seen(page, "primary-action")) === "Fund the deal", "the fund button");
    held.on = true;
    await page.getByTestId("primary-action").click();
    await until(async () => (await statusOf(w, id + 1n)) === STATUS.Funded, "the funding mined");
    await page.reload();
    await until(async () => (await read(page)).includes("This page was reloaded while the funding transaction 0x"), "the form waiting for its transaction again");
    held.on = false;
    await until(async () => (await link(page)) === `${site.url}/#/v2/d/${id + 1n}`, "the funded deal's link, after all");
  });
}));

test("the whole settlement can be done from the keyboard: the button keeps the focus from one step to the next", () => onSite(async (site, w) => {
  const t = await w.vesting();
  const id = await w.fund(t);
  await w.usdc.as(w.deployer).mint(w.buyer, TOTAL);
  await browse(site, `#/v2/d/${id}`, { wallet: walletFor(w, w.buyer), size: DESKTOP }, async (page) => {
    await page.getByTestId("primary-action").focus();
    const focused = () => page.evaluate(() => document.activeElement?.dataset.testid === "primary-action" && !document.activeElement.disabled);
    for (const label of ["Connect wallet", "Approve 124.074072 USDC", "Settle: pay 124.074072 USDC"]) {
      await until(async () => (await focused()) && (await seen(page, "primary-action")) === label, `"${label}" focused and ready`);
      await page.keyboard.press("Enter");
    }
    await until(async () => (await statusOf(w, id)) === STATUS.Settled, "the deal settled with three presses of Enter");
    await says(page, "grant-status", "cliff", "data-status");
  });
}));
