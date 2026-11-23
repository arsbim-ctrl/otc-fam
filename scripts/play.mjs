// npm run play [folder]: plays round 2's scenes (the brief's "What users see") with the built page, on a local
// chain inside this process, with test tokens and a stand-in wallet: once at a phone's width (390 px) and once at a
// desktop's (1440 px). At each step it prints the text a person reads, saves a screenshot (screens/ by default), and
// where tokens moved it checks every party's balances against the deal's exact numbers and prints what moved.
// It needs "npm ci" and "npx playwright install chromium", and no network. It stops at the first thing that is not
// as it should be.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatAmount } from "../web/units.js";
import { browse, closeBrowser, DESKTOP, fits, offered, PHONE, pressUntil, read, seen, serve, shows, until, walletFor } from "../test/lib/v2-site.mjs";
import { ALLOCATION, DAY, feeOn, QUOTE, STATUS, world } from "../test/lib/v2-world.mjs";

const folder = resolve(process.argv[2] ?? "screens");
mkdirSync(folder, { recursive: true });
const FEE = feeOn(QUOTE), TOTAL = QUOTE + FEE, FILL = "0x3fda5389"; // fill(uint256)
const DECIMALS = { FAM: 18, USDC: 6 };
let shots = 0;

/** "buyer -124.074072 USDC, seller +122.839506 USDC…" for what moved. */
const told = (moved) => Object.entries(moved).map(([key, delta]) => {
  const [who, symbol] = key.split(".");
  return `${who} ${delta < 0n ? "-" : "+"}${formatAmount(delta < 0n ? -delta : delta, DECIMALS[symbol])} ${symbol}`;
}).join(", ") || "nothing";

async function play(size) {
  const w = await world();
  await w.fam.as(w.deployer).mint(w.seller, 2n * ALLOCATION);
  await w.usdc.as(w.deployer).mint(w.buyer, 2n * TOTAL);
  const site = await serve(w);
  const refresh = (page) => page.evaluate(() => dispatchEvent(new Event("focus")));
  const says = (page, id, text, name) => shows(page, id, (t) => t === text, JSON.stringify(text), name);
  const settled = (id) => async () => (await w.deals.read.getDeal(id)).status === STATUS.Settled;

  /** Prints what the page shows now, and saves it as `<folder>/<name>-<width>.jpg`. */
  async function look(page, name) {
    const file = `${name}-${size.width}.jpg`;
    await page.waitForTimeout(150); // a last look-up may still be drawing
    assert.ok(await fits(page), `${name}: the page is wider than its ${size.width} px window`);
    await page.screenshot({ path: join(folder, file), fullPage: true, type: "jpeg", quality: 50 });
    shots++;
    console.log(`\n--- ${name} (${file})\n${(await read(page)).split("\n").map((line) => `    ${line}`).join("\n")}`);
    // What was typed or chosen in a form is not part of the page's text: it is listed after it.
    const typed = await page.evaluate(() => [...document.querySelectorAll("input[data-testid]")].filter((i) => i.offsetParent && (i.type === "radio" ? i.checked : i.value))
      .map((i) => (i.type === "radio" ? `${i.dataset.testid} chosen` : `${i.dataset.testid} = ${i.value}`)));
    if (typed.length) console.log(`    [in the form: ${typed.join("; ")}]`);
  }
  /** Checks that exactly `expected` moved since `before`, and prints it. */
  async function moved(before, expected, what) {
    assert.deepEqual(await w.moved(before), expected, what);
    console.log(`\n    BALANCES, ${what}: ${told(expected)}. Nothing else moved.`);
  }
  const scene = (title) => console.log(`\n=== ${size.width} px · ${title}`);
  const form = async (page, vesting) => {
    if (vesting) await page.getByTestId("delivery-vesting").check();
    const entered = { "base-token": w.fam.address, allocation: "1000000", "quote-token": w.usdc.address, quote: "123.456789", buyer: w.buyer };
    for (const [id, value] of Object.entries(entered)) await page.getByTestId(id).fill(value);
    await says(page, "buyer-total", "124.074072");
  };

  try {
    scene("1. The seller chooses immediate delivery, sees the exact money, funds, and gets one link");
    await browse(site, "#/v2/new", { wallet: walletFor(w, w.seller), size }, async (page) => {
      await form(page, false);
      await look(page, "01-form-immediate");
      const before = await w.holdings();
      await pressUntil(page, async () => (await page.getByTestId("deal-link").count()) === 1, "the deal's link");
      await look(page, "02-funded-link");
      await moved(before, { "seller.FAM": -ALLOCATION, "deals.FAM": ALLOCATION }, "funding the deal (no fee)");
    });

    scene("2. The seller chooses vesting delivery: a 30-day cliff over 90 days, from the settlement");
    await browse(site, "#/v2/new", { wallet: walletFor(w, w.seller), size }, async (page) => {
      await form(page, true);
      await look(page, "03-form-vesting");
      await pressUntil(page, async () => (await page.getByTestId("deal-link").count()) === 1, "the deal's link");
    });

    scene("3. An existing vesting position is refused, before the wallet is asked for anything");
    const asked = [];
    await browse(site, "#/v2/new", { wallet: walletFor(w, w.seller, () => null, asked), size }, async (page) => {
      await page.getByTestId("delivery-existing").check();
      await page.getByTestId("existing-position").fill("https://app.sablier.com/stream/LL2-1-1234");
      await shows(page, "notice", (t) => t.includes("cannot sell an existing vesting position"), "the refusal");
      assert.equal(await offered(page), false);
      await look(page, "04-existing-position-refused");
    });
    assert.deepEqual([...new Set(asked)].sort(), ["eth_accounts", "eth_chainId"]);
    console.log("\n    WALLET: the page only asked which account and which network; it never asked to connect, approve or send.");

    scene("4. A fresh buyer opens each link with no wallet: the terms, both fees, the delivery and the funding on the chain");
    for (const [id, name] of [[1, "05-buyer-no-wallet-immediate"], [2, "06-buyer-no-wallet-vesting"]]) {
      await browse(site, `#/v2/d/${id}`, { size }, async (page) => {
        await says(page, "funding", "true", "data-funded");
        await look(page, name);
      });
    }

    scene("5. The buyer connects and settles the immediate deal: each press, then the receipt");
    await browse(site, "#/v2/d/1", { wallet: walletFor(w, w.buyer), size }, async (page) => {
      const before = await w.holdings();
      await pressUntil(page, settled(1), "the deal settled", async (presses) => console.log(`    press ${presses + 1}: ${await seen(page, "primary-action")}`));
      await says(page, "deal-status", "settled", "data-status");
      await until(async () => (await page.locator('[data-testid="receipts"] li[data-kind="settled"]').count()) === 1, "the settlement's receipt");
      await look(page, "07-settled-immediate");
      await moved(before, { "buyer.USDC": -TOTAL, "seller.USDC": QUOTE - FEE, "treasury.USDC": 2n * FEE, "buyer.FAM": ALLOCATION, "deals.FAM": -ALLOCATION },
        "the immediate settlement (0.5% + 0.5% of 123.456789 USDC)");
    });

    scene("6. The buyer declines once in the wallet, then settles the vesting deal: settled is not unlocked");
    let declined = false;
    const once = walletFor(w, w.buyer, (request) => {
      if (request.method !== "eth_sendTransaction" || declined) return null;
      declined = true;
      return { error: { code: 4001, message: "User rejected the request." } };
    });
    await browse(site, "#/v2/d/2", { wallet: once, size }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "notice")) === "You declined in your wallet. Nothing was sent.", "the notice of the declined press");
      await look(page, "08-declined-in-the-wallet");
      const before = await w.holdings();
      await pressUntil(page, settled(2), "the deal settled");
      const { start, cliff, end, custodian } = await w.deals.read.getGrant(2);
      w.watch("vault", custodian);
      await says(page, "grant-status", "cliff", "data-status");
      await until(async () => (await page.locator('[data-testid="receipts"] li[data-kind="granted"]').count()) === 1, "the grant's receipt");
      await look(page, "09-settled-vesting-day-0");
      await moved({ ...before, "vault.FAM": 0n }, { "buyer.USDC": -TOTAL, "seller.USDC": QUOTE - FEE, "treasury.USDC": 2n * FEE, "deals.FAM": -ALLOCATION, "vault.FAM": ALLOCATION },
        "the vesting settlement: the whole allocation is in the grant's vault");

      scene("7. The grant on day 29, at the cliff, on day 45 with a claim, and on day 90 with the last claim");
      const day = async (time, name, expected) => {
        await w.at(time);
        await refresh(page);
        for (const [id, text] of Object.entries(expected)) await says(page, `grant-${id}`, text);
        await look(page, name);
      };
      const claim = async (time, name, amount, expected) => {
        const held = await w.holdings();
        await w.next(time); // the claim is mined at exactly this second
        await page.getByTestId("primary-action").click();
        for (const [id, text] of Object.entries(expected)) await says(page, `grant-${id}`, text);
        await until(async () => (await seen(page, "last-receipt", "data-tx")) !== null, "the claim's receipt");
        await look(page, name);
        await moved(held, { "buyer.FAM": amount, "vault.FAM": -amount }, "the claim (no fee)");
      };
      await day(start + BigInt(29 * DAY), "10-grant-day-29", { vested: "0", claimable: "0", locked: "1,000,000" });
      await day(cliff, "11-grant-day-30-cliff", { vested: "333,333.333333333333333333", claimable: "333,333.333333333333333333" });
      await day(start + BigInt(45 * DAY), "12-grant-day-45", { vested: "500,000", claimable: "500,000", locked: "500,000" });
      await claim(start + BigInt(45 * DAY), "13-grant-day-45-claimed", ALLOCATION / 2n, { claimed: "500,000", claimable: "0", locked: "500,000" });
      await day(end, "14-grant-day-90", { vested: "1,000,000", claimed: "500,000", claimable: "500,000", locked: "0" });
      await claim(end, "15-grant-day-90-claimed", ALLOCATION / 2n, { claimed: "1,000,000", claimable: "0" });
      assert.equal(await w.fam.read.balanceOf(w.buyer), 2n * ALLOCATION, "the buyer holds both allocations in full");
    });

    scene("8. Ways back: a wallet on another network, a settlement that fails on the chain, one the wallet replaces, a reload");
    const t = await w.terms();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await w.fund(t));
    await w.usdc.as(w.deployer).mint(w.buyer, 4n * TOTAL);
    const [elsewhereId, failedId, replacedId, reloadedId, otherId, cancelledId] = ids;

    let chainId = "0x1";
    const elsewhere = walletFor(w, w.buyer, async (request, answer) => {
      if (request.method === "eth_chainId") return { result: chainId };
      if (request.method !== "wallet_switchEthereumChain") return null;
      chainId = request.params[0].chainId;
      return answer(request);
    });
    await browse(site, `#/v2/d/${elsewhereId}`, { wallet: elsewhere, size }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "primary-action")) === "Switch to Local test chain", "the offer to switch network");
      await look(page, "16-wallet-on-another-network");
      await pressUntil(page, settled(elsewhereId), "the deal settled once the wallet switched");
    });

    let starved = false;
    const starving = walletFor(w, w.buyer, (request, answer) => {
      if (request.method !== "eth_sendTransaction" || !request.params[0].data.startsWith(FILL) || starved) return null;
      starved = true; // sent with too little gas: it is mined, and fails
      return answer({ ...request, params: [{ ...request.params[0], gas: "0x7530" }] });
    });
    await browse(site, `#/v2/d/${failedId}`, { wallet: starving, size }, async (page) => {
      const before = await w.holdings();
      await pressUntil(page, async () => (await seen(page, "notice"))?.includes("failed on the chain"), "the notice of the failed settlement");
      await look(page, "17-settlement-failed-on-the-chain");
      await moved(before, {}, "the settlement that failed on the chain");
      await pressUntil(page, settled(failedId), "the deal settled at the next press");
    });

    const replacing = walletFor(w, w.buyer, async (request, answer) => {
      if (request.method !== "eth_sendTransaction" || !request.params[0].data.startsWith(FILL)) return null;
      await answer(request); // the wallet sends another transaction in its place, as "speed up" does
      return { result: `0x${"ab".repeat(32)}` };
    });
    await browse(site, `#/v2/d/${replacedId}`, { wallet: replacing, size }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "notice"))?.includes("Your wallet replaced this transaction"), "the notice of the replaced settlement");
      await says(page, "deal-status", "settled", "data-status");
      await look(page, "18-transaction-replaced-in-the-wallet");
    });

    await browse(site, `#/v2/d/${reloadedId}`, { wallet: walletFor(w, w.buyer), size }, async (page) => {
      let held = false; // while it is, the page is told that no transaction has a receipt yet
      await page.route("**/rpc", async (route) => {
        const request = route.request().postDataJSON();
        if (held && request.method === "eth_getTransactionReceipt") return route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: null } });
        return route.continue();
      });
      await pressUntil(page, async () => (await seen(page, "primary-action")) === "Settle: pay 124.074072 USDC", "the settle button");
      held = true;
      await page.getByTestId("primary-action").click();
      await until(settled(reloadedId), "the settlement mined");
      await page.reload();
      await until(async () => (await page.getByTestId("waiting").count()) === 1, "the page waiting for its transaction again");
      await look(page, "19-reloaded-while-settling");
      held = false;
      await shows(page, "notice", (text) => text.includes("is confirmed"), "the notice that it is confirmed");
      await look(page, "20-reloaded-and-confirmed");
    });

    scene("9. Not for you, cancelled, and expired");
    await browse(site, `#/v2/d/${otherId}`, { wallet: walletFor(w, w.other), size }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "notice"))?.includes(w.buyer) && !(await offered(page)), "a notice naming the buyer");
      await look(page, "21-not-the-buyer");
    });
    await browse(site, `#/v2/d/${cancelledId}`, { wallet: walletFor(w, w.seller), size }, async (page) => {
      const before = await w.holdings();
      await pressUntil(page, async () => (await page.getByTestId("cancel-action").count()) === 1, "the seller's cancel button");
      await look(page, "22-seller-can-cancel");
      await page.getByTestId("cancel-action").click();
      await says(page, "deal-status", "cancelled", "data-status");
      await look(page, "23-cancelled");
      await moved(before, { "seller.FAM": ALLOCATION, "deals.FAM": -ALLOCATION }, "the cancellation (no fee)");
    });
    await w.at(t.expiry);
    await browse(site, `#/v2/d/${otherId}`, { size }, async (page) => {
      await says(page, "deal-status", "expired", "data-status");
      assert.equal(await offered(page), false);
      await look(page, "24-expired");
    });
  } finally {
    await site.close();
  }
}

for (const size of [PHONE, DESKTOP]) await play(size);
await closeBrowser();
console.log(`\nEvery scene played at 390 px and 1440 px, and every balance was as the deal says. ${shots} screenshots are in ${folder}`);
process.exit(0);
