// npm run play:v3 [folder]: plays round 3's scenes (the brief's "What users see") with the built page, on a local
// chain inside this process, with test tokens and stand-in wallets that sign with local test keys: once at a phone's
// width (390 px) and once at a desktop's (1440 px). A broker, a seller, a buyer and a stranger each have a browser of
// their own. At each step it prints the text a person reads, saves a screenshot (screens/ by default), and where
// tokens moved, or must not have moved, it checks every party's balances against the deal's exact numbers and prints
// what moved. It needs "npm ci" and "npx playwright install chromium", and no network. It stops at the first thing
// that is not as it should be.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatAmount } from "../web/units.js";
import { packTerms } from "../web/v3.js";
import { browse, closeBrowser, DESKTOP, fits, offered, PHONE, pressUntil, read, seen, serve, shows, signerFor, until, walletSays } from "./lib/site.mjs";
import { ALLOCATION, feesOf, QUOTE, STATUS3, world3 } from "./lib/world3.mjs";

const folder = resolve(process.argv[2] ?? "screens");
mkdirSync(folder, { recursive: true });
const USDC = 10n ** 6n, LARGE = 100_000n * USDC; // the brief's 100,000 USDC; QUOTE is its 123.456789 USDC
const DECIMALS = { FAM: 18, USDC: 6 };
// The stand names a block explorer so that receipts show their links; on a real network it is that network's own.
const EXPLORER = "https://explorer.invalid";
const ledger = []; // every balance check of the run, to list them in one place at the end
let shots = 0;

/** "buyer -100,500 USDC, seller +99,500 USDC…" for what moved. */
const told = (moved) => Object.entries(moved).map(([key, delta]) => {
  const [who, symbol] = key.split(".");
  return `${who} ${delta < 0n ? "-" : "+"}${formatAmount(delta < 0n ? -delta : delta, DECIMALS[symbol])} ${symbol}`;
}).join(", ") || "nothing";

async function play(size) {
  const w = await world3();
  await w.fam.as(w.deployer).mint(w.seller, 2n * ALLOCATION);
  await w.usdc.as(w.deployer).mint(w.buyer, feesOf(LARGE, 2_000).buyerTotal + feesOf(QUOTE, 2_000).buyerTotal);
  const site = await serve(w, { explorerUrl: EXPLORER });
  const refresh = (page) => page.evaluate(() => dispatchEvent(new Event("focus")));
  const says = (page, id, text, name) => shows(page, id, (t) => t === text, JSON.stringify(text), name);
  const state = (page, status) => says(page, "deal-status", status, "data-status");
  const is = (id, status) => async () => (await w.v3.read.getDeal(id)).status === status;
  const linkOf = (t) => `#/v3/d/31337/${w.v3.address.toLowerCase()}/${packTerms(t)}`;
  const pressed = (page) => async (presses) => console.log(`    press ${presses + 1}: ${await seen(page, "primary-action")}`);

  /** Prints what the page shows now and, when `name` starts with a number, saves it as `<folder>/<name>-<width>.jpg`. */
  async function look(page, name) {
    const file = /^\d/.test(name) ? `${name}-${size.width}.jpg` : null;
    await page.waitForTimeout(150); // a last look-up may still be drawing
    assert.ok(await fits(page), `${name}: the page is wider than its ${size.width} px window`);
    if (file) {
      await page.screenshot({ path: join(folder, file), fullPage: true, type: "jpeg", quality: 38 });
      shots++;
    }
    console.log(`\n--- ${name} (${file ?? "text only"})\n${(await read(page)).split("\n").map((line) => `    ${line}`).join("\n")}`);
    // What was typed or chosen in a form is not part of the page's text: it is listed after it.
    const typed = await page.evaluate(() => [...document.querySelectorAll("input[data-testid]")].filter((i) => i.offsetParent && (i.type === "radio" ? i.checked : i.value))
      .map((i) => (i.type === "radio" ? `${i.dataset.testid} chosen` : `${i.dataset.testid} = ${i.value}`)));
    if (typed.length) console.log(`    [in the form: ${typed.join("; ")}]`);
  }
  /** Checks that exactly `expected` moved since `before`, and prints it. */
  async function moved(before, expected, what) {
    assert.deepEqual(await w.moved(before), expected, what);
    console.log(`\n    BALANCES, ${what}: ${told(expected)}. Nothing else moved.`);
    ledger.push(`${size.width} px · ${what}: ${told(expected)}`);
  }
  /**
   * Takes a deal on from the keyboard alone: Enter on the page's main button until `done`. Before every press that
   * button has the focus, and after the last one the focus is on the line that says whose turn it is now.
   */
  async function keyboard(page, done, what) {
    await page.getByTestId("primary-action").focus();
    const focusOn = (id) => page.evaluate((handle) => document.activeElement?.dataset.testid === handle && !document.activeElement.disabled, id);
    for (let presses = 0; ; presses++) {
      const next = await until(async () => ((await done()) ? "done" : (await focusOn("primary-action")) ? "press" : null), `${what}: not done, and the main button is not focused and ready`);
      if (next === "done") break;
      assert.ok(presses < 4, `${what}: not done after four presses of Enter`);
      console.log(`    Enter ${presses + 1}, on the focused button: ${await seen(page, "primary-action")}`);
      await page.keyboard.press("Enter");
    }
    await until(() => focusOn("next-actor"), `${what}: the focus on the line that says whose turn it is`);
    console.log(`\n    KEYBOARD at ${size.width} px, ${what}: every press was Enter on the button that had the focus. The focus is now on the status line: ${JSON.stringify(await seen(page, "next-actor"))}`);
  }
  /** What stays readable at this width before anything is signed: the token warning, whole, and the status, in words and announced. */
  async function readable(page) {
    const warning = page.getByTestId("token-warning"), turn = page.getByTestId("next-actor");
    assert.ok(await warning.isVisible(), "the token warning is shown");
    assert.ok(await warning.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth), "none of the token warning is cut off");
    assert.equal(await turn.getAttribute("role"), "status", "the line that says whose turn it is is announced to a screen reader");
    console.log(`\n    READABLE at ${size.width} px. The token warning, whole: ${JSON.stringify(await warning.innerText())} The state, in words: ${JSON.stringify(await seen(page, "deal-status"))}. `
      + `Announced to a screen reader (role="status"): ${JSON.stringify(await turn.innerText())}`);
  }
  /** A scene's heading: its title, and the brief's acceptance points it shows. */
  const scene = (title, shows) => console.log(`\n=== ${size.width} px · ${title} [${shows}]`);
  /** Presses a "Copy link" button and checks that the clipboard then holds exactly `expected`. */
  async function copies(page, button, expected, what) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: site.url });
    await button.click();
    await until(async () => (await button.innerText()) === "Link copied", `${what}: the button saying that the link is copied`);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected, `${what}: the clipboard holds the link`);
    console.log(`\n    COPIED at ${size.width} px, ${what}: "Copy link" put the whole link on the clipboard, ${expected.length} characters, the same as the link on the page.`);
  }
  /** The broker's form, filled: a million FAM from the seller to the buyer for `quote` USDC, the broker taking 20% of the fees. */
  async function form(page, quote, vesting) {
    if (vesting) await page.getByTestId("delivery-vesting").check();
    const entered = { "base-token": w.fam.address, allocation: "1000000", "quote-token": w.usdc.address, quote, seller: w.seller, buyer: w.buyer, broker: w.broker, "broker-share": "20" };
    for (const [id, value] of Object.entries(entered)) await page.getByTestId(id).fill(value);
  }
  /** Presses the form's button and returns the link's hash and the deal's id. */
  async function link(page) {
    await page.getByTestId("primary-action").click();
    const href = await until(async () => ((await page.getByTestId("deal-link").count()) ? page.getByTestId("deal-link").evaluate((el) => el.href) : null), "the deal's link");
    return { hash: href.slice(site.url.length + 1), id: await seen(page, "created-id") };
  }

  try {
    scene("1. A broker, with no wallet, enters the terms, sees the exact fee share, gets one link and copies it", "R3-01, R3-05");
    const start = await w.holdings();
    const a = await browse(site, "#/v3/new", { size }, async (page) => {
      await form(page, "100000", false);
      for (const [id, text] of Object.entries({ "buyer-total": "100,500", "seller-net": "99,500", "fee-pool": "1,000", "broker-fee": "200", "treasury-fee": "800" })) await says(page, id, text);
      await look(page, "01-broker-form");
      const made = await link(page);
      await look(page, "02-broker-link");
      await copies(page, page.getByTestId("copy-link"), `${site.url}/${made.hash}`, "the broker's new link");
      return made;
    });
    assert.equal((await w.v3.read.getDeal(a.id)).status, STATUS3.Unfunded);
    await moved(start, {}, "preparing the link (it is not on the chain, and gives nobody any right)");

    scene("2. The seller inspects the deal, declines the signature once, then signs and funds", "R3-01, R3-05");
    let declined = false;
    const hesitant = signerFor(w, "seller", (request) => {
      if (request.method !== "eth_signTypedData_v4" || declined) return null;
      declined = true;
      return { error: { code: 4001, message: "User rejected the request." } };
    });
    await browse(site, a.hash, { wallet: hesitant, size }, async (page) => {
      await state(page, "awaiting");
      await says(page, "next-actor", "seller", "data-actor");
      await look(page, "03-seller-inspects");
      await pressUntil(page, async () => (await seen(page, "notice")) === "You declined in your wallet. Nothing was sent.", "the notice of the declined signature", pressed(page));
      await look(page, "04-seller-declined-the-signature");
      await moved(start, {}, "the declined signature");
      await pressUntil(page, is(a.id, STATUS3.Funded), "the deal funded", pressed(page));
      await state(page, "funded");
      await until(async () => (await page.locator('[data-testid="receipts"] li[data-kind="funded"]').count()) === 1, "the funding's receipt");
      await look(page, "the seller's page once the deal is funded");
      await moved(start, { "seller.FAM": -ALLOCATION, "brokerDeals.FAM": ALLOCATION }, "funding the deal (no fee, nothing for the broker)");
    });

    scene("3. The buyer, in a fresh browser with no wallet, inspects the funding and the delivery; then connects, signs and settles from the keyboard, sees the receipt, and reloads", "R3-01, R3-03, R3-05");
    await browse(site, a.hash, { size }, async (page) => {
      await says(page, "funding", "true", "data-funded");
      await says(page, "next-actor", "buyer", "data-actor");
      assert.equal(await offered(page), false);
      await look(page, "05-buyer-no-wallet");
      await readable(page);
    });
    await browse(site, a.hash, { wallet: signerFor(w, "buyer"), size }, async (page) => {
      const before = await w.holdings();
      await keyboard(page, is(a.id, STATUS3.Settled), "the buyer's settlement");
      await state(page, "settled");
      await says(page, "receipt-broker-fee", "200");
      const tx = await seen(page, "settlement", "data-tx");
      assert.equal(await page.locator('[data-testid="receipt-tx"] a').getAttribute("href"), `${EXPLORER}/tx/${tx}`, "the receipt links to the explorer");
      await look(page, "06-buyer-settled-receipt");
      await moved(before, { "buyer.USDC": -100_500n * USDC, "seller.USDC": 99_500n * USDC, "broker.USDC": 200n * USDC, "treasury.USDC": 800n * USDC, "buyer.FAM": ALLOCATION, "brokerDeals.FAM": -ALLOCATION },
        "the immediate settlement of 100,000 USDC with a 20% broker share");
      await page.reload();
      await state(page, "settled");
      await says(page, "settlement", tx, "data-tx");
      await says(page, "receipt-paid", "100,500");
      console.log("\n    RELOAD: after a reload the page shows the same settlement receipt, read from the chain again. Its text follows.");
      await look(page, "the buyer's page after the reload");
    });

    scene("4. A vesting deal: the buyer cannot settle before it is funded; a wallet on another network switches first; settled is not unlocked", "R3-01, R3-04, R3-05");
    const fees = feesOf(QUOTE, 2_000);
    const b = await browse(site, "#/v3/new", { size }, async (page) => {
      await form(page, "123.456789", true);
      for (const [id, text] of Object.entries({ "buyer-total": "124.074072", "seller-net": "122.839506", "fee-pool": "1.234566", "broker-fee": "0.246913", "treasury-fee": "0.987653" })) await says(page, id, text);
      await look(page, "07-broker-form-vesting");
      return link(page);
    });
    await browse(site, b.hash, { wallet: signerFor(w, "buyer"), size }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "notice"))?.includes("not funded yet") && !(await offered(page)), "why the buyer cannot settle yet", pressed(page));
      await look(page, "08-buyer-cannot-settle-unfunded");
    });
    await browse(site, b.hash, { wallet: signerFor(w, "seller"), size }, async (page) => {
      await pressUntil(page, is(b.id, STATUS3.Funded), "the vesting deal funded");
    });
    let chainId = "0x1";
    const elsewhere = signerFor(w, "buyer", async (request, answer) => {
      if (request.method === "eth_chainId") return { result: chainId };
      if (request.method !== "wallet_switchEthereumChain") return null;
      chainId = request.params[0].chainId;
      return answer(request);
    });
    const vault = await browse(site, b.hash, { wallet: elsewhere, size }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "primary-action")) === "Switch to Local test chain", "the offer to switch network", pressed(page));
      await look(page, "09-buyer-on-another-network");
      const before = await w.holdings();
      await pressUntil(page, is(b.id, STATUS3.Settled), "the vesting deal settled", pressed(page));
      const { custodian } = await w.v3.read.getGrant(1);
      w.watch("vault", custodian);
      await says(page, "grant-status", "cliff", "data-status");
      await says(page, "receipt-delivery", "1", "data-grant");
      await look(page, "10-vesting-settled-day-0");
      await moved({ ...before, "vault.FAM": 0n }, { "buyer.USDC": -fees.buyerTotal, "seller.USDC": fees.sellerNet, "broker.USDC": fees.brokerFee, "treasury.USDC": fees.treasuryFee,
        "brokerDeals.FAM": -ALLOCATION, "vault.FAM": ALLOCATION }, "the vesting settlement of 123.456789 USDC with a 20% broker share: the whole allocation is in the grant's vault");
      return custodian;
    });

    scene("5. A stranger's wallet, which then turns to the buyer's account; the broker's wallet; and the seller's refund", "R3-02, R3-03, R3-05");
    const c = await w.terms3({ brokerBps: 0 });
    const cId = await w.fund3(c);
    // One wallet with two accounts: the stranger's first, the buyer's once its owner turns to it.
    const turning = { account: w.other };
    const twoAccounts = signerFor(w, "buyer", async (request, answer) => {
      if (request.method !== "eth_requestAccounts") return null;
      await answer(request);
      return { result: [turning.account] };
    });
    await browse(site, linkOf(c), { wallet: twoAccounts, size }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "notice"))?.includes(w.buyer) && !(await offered(page)), "a notice naming the buyer", pressed(page));
      await look(page, "11-not-a-party");
      turning.account = w.buyer;
      await walletSays(page, "accountsChanged", [w.buyer]);
      await says(page, "primary-action", "Not enough USDC"); // the buyer's USDC went into the two deals settled above
      console.log(`\n    WALLET CHANGED at ${size.width} px: the wallet turned from the stranger's account to the buyer's. The page read the chain again; what it said to the stranger is gone, and it says: `
        + JSON.stringify(await seen(page, "notice")));
    });
    await browse(site, linkOf(c), { wallet: signerFor(w, "broker"), size }, async (page) => {
      await pressUntil(page, async () => (await seen(page, "notice"))?.includes("You are this deal's broker") && !(await offered(page)), "what the broker can and cannot do", pressed(page));
      console.log(`\n    THE BROKER'S WALLET on a funded deal reads: ${await seen(page, "notice")}`);
    });
    await browse(site, linkOf(c), { wallet: signerFor(w, "seller"), size }, async (page) => {
      const before = await w.holdings();
      await pressUntil(page, async () => (await page.getByTestId("refund-action").count()) === 1, "the seller's refund button", pressed(page));
      await look(page, "12-seller-can-refund");
      await page.getByTestId("refund-action").click();
      await state(page, "refunded");
      await until(async () => (await page.locator('[data-testid="receipts"] li[data-kind="refunded"]').count()) === 1, "the refund's receipt");
      await look(page, "13-refunded");
      await moved(before, { "seller.FAM": ALLOCATION, "brokerDeals.FAM": -ALLOCATION }, "the refund (no fee, nothing for the broker)");
    });

    scene("6. Expired: a deal that was never funded, and a funded one that only its seller can still act on", "R3-02");
    const soon = (await w.chain.now()) + 300;
    const d = await w.terms3({ expiry: soon }), e = await w.terms3({ expiry: soon }), f = await w.terms3(), g = await w.terms3({ quote: LARGE });
    const eId = await w.fund3(e), gId = await w.fund3(g);
    await w.at(soon);
    const beforeExpired = await w.holdings();
    await browse(site, linkOf(d), { wallet: signerFor(w, "seller"), size }, async (page) => {
      await state(page, "expired");
      await says(page, "next-actor", "none", "data-actor");
      assert.equal(await offered(page), false);
      await look(page, "14-expired-before-funding");
    });
    await browse(site, linkOf(e), { wallet: signerFor(w, "buyer"), size }, async (page) => {
      await state(page, "expired");
      await says(page, "next-actor", "seller", "data-actor");
      assert.equal(await offered(page), false);
      await look(page, "15-expired-funded-cannot-settle");
    });
    await moved(beforeExpired, {}, "expiry (no fee, nothing for the broker)");

    scene("7. The broker's history: created and awaiting funding, funded, settled, expired and refunded deals, each with its pair, price, share, deadline and receipt; a link copied, and terms duplicated", "R3-05");
    await browse(site, a.hash, { wallet: signerFor(w, "broker"), size }, async (page) => {
      // The broker's own browser has had every one of these deals open: that is where it knows the unfunded ones from.
      for (const hash of [a.hash, b.hash, linkOf(c), linkOf(d), linkOf(e), linkOf(f), linkOf(g)]) {
        await page.goto(`${site.url}/${hash}`);
        await until(async () => (await page.getByTestId("deal-id").count()) === 1, "the deal");
      }
      await page.goto(`${site.url}/#/v3/deals`);
      await page.getByTestId("connect-action").click();
      await until(async () => (await page.getByTestId("deal-row").count()) === 7, "the broker's seven deals");
      const statuses = await page.getByTestId("deal-row").evaluateAll((rows) => rows.map((row) => row.dataset.status).sort());
      assert.deepEqual(statuses, ["awaiting", "expired", "expired", "funded", "refunded", "settled", "settled"]);
      assert.deepEqual(await page.getByTestId("deal-row").evaluateAll((rows) => [...new Set(rows.map((row) => row.dataset.role))]), ["broker"]);
      await look(page, "16-broker-history");
      await copies(page, page.locator(`[data-testid="deal-row"][data-id="${gId}"] [data-testid="copy-link"]`), `${site.url}/${linkOf(g)}`, "a deal's link from the broker's history");
      await page.locator(`[data-testid="deal-row"][data-id="${gId}"] [data-testid="row-duplicate"]`).click();
      await says(page, "broker-fee", "200");
      await shows(page, "copied", (text) => text.includes("another deal with another ID"), "the note that these are copied terms");
      await look(page, "17-broker-duplicates-terms");
      const copy = await link(page);
      assert.notEqual(copy.id, gId, "duplicated terms are another deal, with another ID");
      console.log(`\n    DUPLICATE: the copied terms became deal ${copy.id}, another deal than ${gId}, whose terms are unchanged.`);
    });
    await browse(site, "#/v3/deals", { wallet: signerFor(w, "seller"), size }, async (page) => {
      await page.getByTestId("connect-action").click();
      await until(async () => (await page.getByTestId("deal-row").count()) === 5, "the five deals the chain has for the seller");
      assert.deepEqual(await page.getByTestId("deal-row").evaluateAll((rows) => [...new Set(rows.map((row) => row.dataset.role))]), ["seller"]);
      await look(page, "the seller's history, from the chain alone");
    });
    assert.equal((await w.v3.read.getDeal(eId)).status, STATUS3.Funded);
    assert.equal((await w.v3.read.getDeal(cId)).status, STATUS3.Refunded);

    scene("8. The grant at its cliff and at its end: the buyer claims, with no fee and nothing for the broker", "R3-04");
    await browse(site, b.hash, { wallet: signerFor(w, "buyer"), size }, async (page) => {
      const { cliff, end } = await w.v3.read.getGrant(1);
      await pressUntil(page, async () => (await seen(page, "primary-action")) === "Nothing to claim yet", "the grant before its cliff", pressed(page));
      const claim = async (time, name, amount, expected) => {
        await w.at(time);
        await refresh(page);
        await says(page, "grant-claimable", expected.claimable);
        const held = await w.holdings();
        await w.next(time); // the claim is mined at exactly this second
        await page.getByTestId("primary-action").click();
        await says(page, "grant-claimed", expected.claimed);
        await until(async () => (await seen(page, "last-receipt", "data-tx")) !== null, "the claim's receipt");
        await look(page, name);
        await moved(held, { "buyer.FAM": amount, "vault.FAM": -amount }, "the claim (no fee, nothing for the broker)");
      };
      // In text only: the grant's card is the one round 2's screenshots show day by day (evidence/round-2).
      await claim(cliff, "the grant on day 30, at its cliff, after the claim", ALLOCATION / 3n, { claimable: "333,333.333333333333333333", claimed: "333,333.333333333333333333" });
      await claim(end, "the grant on day 90, at its end, after the last claim", ALLOCATION - ALLOCATION / 3n, { claimable: "666,666.666666666666666667", claimed: "1,000,000" });
      assert.equal(await w.fam.read.balanceOf(vault), 0n, "the vault paid everything out");
    });

    scene("9. The brief's four fee fixtures, settled on the chain: 100,000 USDC and 123.456789 USDC, with a broker share of 0% and of 20%", "R3-03");
    for (const quote of [LARGE, QUOTE]) {
      for (const brokerBps of [0, 2_000]) {
        const t = await w.terms3({ quote, brokerBps }), m = feesOf(quote, brokerBps);
        const id = await w.fund3(t);
        await w.ready3(t);
        const before = await w.holdings();
        await w.v3.as(t.buyer).settle(id, await w.sign("buyer", t));
        const expected = { "buyer.USDC": -m.buyerTotal, "seller.USDC": m.sellerNet, "broker.USDC": m.brokerFee, "treasury.USDC": m.treasuryFee, "buyer.FAM": ALLOCATION, "brokerDeals.FAM": -ALLOCATION };
        await moved(before, Object.fromEntries(Object.entries(expected).filter(([, delta]) => delta !== 0n)), `${formatAmount(quote, 6)} USDC at ${brokerBps / 100}%`);
      }
    }
  } finally {
    await site.close();
  }
}

for (const size of [PHONE, DESKTOP]) await play(size);
await closeBrowser();
console.log(`\n=== Every balance check of this run in one place: what moved, compared with every party's holdings before it was printed\n${ledger.map((line) => `    ${line}`).join("\n")}`);
console.log(`\nEvery scene played at 390 px and 1440 px, and every balance was as the deal says. ${shots} screenshots are in ${process.argv[2] ?? "screens"}/`);
process.exit(0);
