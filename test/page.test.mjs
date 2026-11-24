// The page on the paths the round's checks leave out: a token with no decimals, an amount with too many, a wallet on
// another network, a press declined in the wallet, a transaction refused before sending or failed on the chain, a
// token that wants its approval reset (as USDT), and the maker taking their tokens back. Like the checks' page tests,
// they build the page, serve it with the checks' helpers and drive it in Chromium ("npx playwright install chromium").
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deploy } from "../.launchpad/checks/round-1/chain.mjs";
import { compile } from "../.launchpad/checks/round-1/compile.mjs";
import { ROOT } from "../.launchpad/checks/round-1/lib/entry.mjs";
import { offered, pressUntil, seen, serve, shows, until, wallet, withPage } from "../.launchpad/checks/round-1/page.mjs";
import { STATUS, world } from "../.launchpad/checks/round-1/world.mjs";
import { serve as serveSnapshot } from "../scripts/lib/site.mjs";

const { EdgeToken } = compile(ROOT, "test/tokens/EdgeToken.sol");
const FILL = "0x3fda5389"; // fill(uint256)
const KIND = { Plain: 0, Fee: 1, FeeOnTop: 2, False: 3, Reset: 4 }; // EdgeToken.Kind

/** Runs `steps(site, w)` on a fresh world `w` whose page is served at `site`. */
async function onSite(steps) {
  const w = await world();
  const site = await serve(w);
  try {
    await steps(site, w);
  } finally {
    await site.close();
  }
}

/** The checks' wallet for `account`, with `instead(request)` answering first when it returns something. */
const walletWith = (w, account, instead) => {
  const answer = wallet(w, account);
  return async (request) => (await instead(request, answer)) ?? answer(request);
};

const fillForm = async (page, entered) => {
  for (const [id, value] of Object.entries(entered)) await page.getByTestId(id).fill(value);
};
const noteSays = (page, text) => until(async () => (await page.locator(".note.problem").allInnerTexts()).some((t) => t.includes(text)), `a note saying "${text}"`);
const filled = (w, id) => async () => (await w.deals.read.getDeal(id)).status === STATUS.Filled;

test("a token with no decimals shows whole numbers, and the form refuses a fraction of it", () => onSite(async (site, w) => {
  const whole = await w.token("PlainToken", "WHOLE", 0);
  const id = await w.offer({ sellToken: whole.address, sellAmount: 1500n });
  await withPage(site, `#/d/${id}`, null, async (page) => {
    await shows(page, "receive-amount", (t) => t === "1,500", '"1,500"');
    await shows(page, "receive-symbol", (t) => t === "WHOLE", '"WHOLE"');
  });
  await withPage(site, "#/new", wallet(w, w.maker), async (page) => {
    await fillForm(page, { "sell-token": whole.address, "sell-amount": "2.5" });
    await noteSays(page, "WHOLE has no decimals");
  });
}));

test("an amount with more decimals than its token has is refused, and nothing can be sent", () => onSite(async (site, w) => {
  await withPage(site, "#/new", wallet(w, w.maker), async (page) => {
    await fillForm(page, { "sell-token": w.alfa.address, "sell-amount": "1.1234567", "buy-token": w.bravo.address, "buy-amount": "1", "expiry-hours": "1" });
    await pressUntil(page, async () => (await seen(page, "primary-action")) === "Check the amount you give", "the button naming what to check");
    assert.equal(await offered(page), false);
    await noteSays(page, "ALFA has 6 decimals");
  });
}));

test("a wallet on another network is asked to switch first, then fills in four presses", () => onSite(async (site, w) => {
  const id = await w.offer();
  let chainId = "0x1";
  const elsewhere = walletWith(w, w.taker, async (request, answer) => {
    if (request.method === "eth_chainId") return { result: chainId };
    if (request.method !== "wallet_switchEthereumChain") return null;
    const reply = await answer(request);
    if (!reply.error) chainId = request.params[0].chainId;
    return reply;
  });
  const buttons = [];
  await withPage(site, `#/d/${id}`, elsewhere, (page) => pressUntil(page, filled(w, id), "the deal filled", async () => buttons.push(await seen(page, "primary-action"))));
  assert.deepEqual(buttons.slice(0, 4), ["Connect wallet", "Switch to Local test chain", "Approve 0.75 BRAVO", "Fill: pay 0.75 BRAVO"]);
}));

test("a press declined in the wallet sends nothing, says so, and can be pressed again", () => onSite(async (site, w) => {
  const id = await w.offer();
  let declined = false;
  const once = walletWith(w, w.taker, (request) => {
    if (request.method !== "eth_sendTransaction" || declined) return null;
    declined = true;
    return { error: { code: 4001, message: "User rejected the request." } };
  });
  await withPage(site, `#/d/${id}`, once, async (page) => {
    await pressUntil(page, async () => (await seen(page, "notice")) === "You declined in your wallet. Nothing was sent.", "the notice of the declined approval");
    assert.equal(await seen(page, "primary-action"), "Approve 0.75 BRAVO");
    await pressUntil(page, filled(w, id), "the deal filled after all");
  });
}));

test("a transaction that fails on the chain is reported, nothing moves, and the deal can still be filled", () => onSite(async (site, w) => {
  const id = await w.offer();
  const before = await w.holdings();
  let starved = false;
  const starving = walletWith(w, w.taker, (request, answer) => {
    if (request.method !== "eth_sendTransaction" || !request.params[0].data.startsWith(FILL) || starved) return null;
    starved = true; // the first fill is sent with too little gas: it is mined, and fails
    return answer({ ...request, params: [{ ...request.params[0], gas: "0x7530" }] });
  });
  await withPage(site, `#/d/${id}`, starving, async (page) => {
    const click = (name) => page.getByRole("button", { name, exact: true }).click();
    for (const label of ["Connect wallet", "Approve 0.75 BRAVO", "Fill: pay 0.75 BRAVO"]) await click(label);
    await shows(page, "notice", (text) => text.includes("failed on the chain"), "the notice of the failed fill");
    assert.equal(starved, true);
    assert.equal((await w.deals.read.getDeal(id)).status, STATUS.Open);
    await w.moved(before, {}, "after a fill that failed on the chain");
    await click("Fill: pay 0.75 BRAVO");
    await until(filled(w, id), "the deal filled at the next press");
  });
}));

test("a replay server leaves the v1 server's dist snapshot in place", () => onSite(async (site, w) => {
  const marker = mkdtempSync(join(ROOT, "dist", ".v1-server-"));
  try {
    const replay = await serveSnapshot({ legacy: w.deals, deals: w.deals });
    try {
      assert.ok(existsSync(marker), "building another browser fixture must never remove the v1 server's files");
      for (const server of [site, replay]) {
        assert.equal((await fetch(`${server.url}/app.js`)).status, 200);
      }
    } finally {
      await replay.close();
    }
  } finally {
    rmSync(marker, { recursive: true, force: true });
  }
}));

test("a deal the contract would refuse is not sent, and the page says why", () => onSite(async (site, w) => {
  const feeToken = await deploy(w.chain, w.deployer, EdgeToken, ["FEE", 18, KIND.Fee], { label: "FEE" });
  await feeToken.as(w.deployer).mint(w.maker, 10n ** 24n);
  const sent = [];
  const counting = walletWith(w, w.maker, (request) => void (request.method === "eth_sendTransaction" && sent.push(request.params[0].to)));
  await withPage(site, "#/new", counting, async (page) => {
    await fillForm(page, { "sell-token": feeToken.address, "sell-amount": "100", "buy-token": w.bravo.address, "buy-amount": "1", "expiry-hours": "24" });
    await pressUntil(page, async () => (await seen(page, "notice"))?.includes("does not move exactly the amount asked"), "the reason the deal is refused");
  });
  assert.deepEqual(sent.map((to) => to.toLowerCase()), [feeToken.address.toLowerCase()], "only the approval was sent, never the deal");
}));

test("a token that wants its approval set to zero first (as USDT) is reset and approved in one press", () => onSite(async (site, w) => {
  const usdt = await deploy(w.chain, w.deployer, EdgeToken, ["RESET", 6, KIND.Reset], { label: "RESET" });
  await usdt.as(w.deployer).mint(w.taker, 10n ** 12n);
  const id = await w.offer({ buyToken: usdt.address, buyAmount: 5_000_000n });
  await usdt.as(w.taker).approve(w.deals.address, 1n); // an approval left from before
  await withPage(site, `#/d/${id}`, wallet(w, w.taker), async (page) => {
    assert.equal(await pressUntil(page, filled(w, id), "the deal filled"), 3, "connect, approve (reset, then approve), fill");
  });
}));

test("the maker opening their own deal is offered no fill, and can cancel it to take the tokens back", () => onSite(async (site, w) => {
  const before = await w.holdings();
  const id = await w.offer();
  await withPage(site, `#/d/${id}`, wallet(w, w.maker), async (page) => {
    await pressUntil(page, async () => (await page.getByTestId("cancel-action").count()) === 1, "the maker's cancel button");
    assert.equal(await offered(page), false, "no fill is offered to the maker");
    await page.getByTestId("cancel-action").click();
    await shows(page, "deal-status", (s) => s === "cancelled", '"cancelled"', "data-status");
  });
  await w.moved(before, {}, "after the maker made a deal and cancelled it from its page");
}));

test("the maker of an expired deal connects from its page and takes the tokens back", () => onSite(async (site, w) => {
  const before = await w.holdings();
  const expiry = Math.max(await w.chain.now(), Math.floor(Date.now() / 1000)) + 3;
  const id = await w.offer({ expiry });
  await until(() => Date.now() / 1000 > expiry + 1, "the deal to expire", 10_000);
  await w.chain.mine();
  await withPage(site, `#/d/${id}`, wallet(w, w.maker), async (page) => {
    await shows(page, "deal-status", (s) => s === "expired", '"expired"', "data-status");
    await page.getByTestId("connect-action").click();
    await page.getByTestId("cancel-action").click();
    await shows(page, "deal-status", (s) => s === "cancelled", '"cancelled"', "data-status");
    assert.equal(await offered(page), false);
  });
  await w.moved(before, {}, "after the maker cancelled the expired deal");
}));

test("the deal's card is changed in place: the button keeps the focus while the time left changes, and from one step to the next", () => onSite(async (site, w) => {
  const id = await w.offer({ expiry: (await w.chain.now()) + 3600 });
  await withPage(site, `#/d/${id}`, wallet(w, w.taker), async (page) => {
    const button = page.getByTestId("primary-action");
    await button.focus();
    await button.evaluate((el) => (el.marked = true));
    const expires = await seen(page, "expires");
    await w.chain.setNextTime((await w.chain.now()) + 600);
    await w.chain.mine();
    await page.evaluate(() => dispatchEvent(new Event("focus"))); // the page reads the chain again, as it does every few seconds
    await until(async () => (await seen(page, "expires")) !== expires, "the time left to change on the page");
    assert.equal(await page.evaluate(() => document.activeElement?.marked === true && document.activeElement.dataset.testid), "primary-action",
      "the very same button still has the focus");
    const ready = (label) => until(async () => (await seen(page, "primary-action")) === label
      && (await page.evaluate(() => document.activeElement?.dataset.testid === "primary-action" && !document.activeElement.disabled)), `"${label}" focused and ready`);
    for (const label of ["Connect wallet", "Approve 0.75 BRAVO", "Fill: pay 0.75 BRAVO"]) {
      await ready(label);
      await page.keyboard.press("Enter");
    }
    await until(filled(w, id), "the deal filled with three presses of Enter");
  });
}));

test("a wallet with nothing to pay the network fee is told so in plain words, not in the node's", () => onSite(async (site, w) => {
  const id = await w.offer();
  await w.chain.rpc("hardhat_setBalance", [w.taker, "0x0"]);
  await withPage(site, `#/d/${id}`, wallet(w, w.taker), async (page) => {
    // The wallet passes the approval to the node, which refuses it in its own words: the page says it in the person's.
    await pressUntil(page, async () => (await seen(page, "notice")) === "This wallet has too little of the network's own coin (ETH) to pay the network fee. "
      + "Add some to it, then try again. Nothing was sent.", "the notice about the network fee");
    assert.equal(await seen(page, "primary-action"), "Approve 0.75 BRAVO", "the same step is offered again");
  });
  assert.equal(await w.bravo.read.allowance(w.taker, w.deals.address), 0n, "nothing was sent");
}));

test("a deal stays open at least a minute: fewer hours are refused, and a minute is accepted", () => onSite(async (site, w) => {
  await withPage(site, "#/new", wallet(w, w.maker), async (page) => {
    await fillForm(page, { "sell-token": w.alfa.address, "sell-amount": "1", "buy-token": w.bravo.address, "buy-amount": "1", "expiry-hours": "0.0001" });
    await pressUntil(page, async () => (await seen(page, "primary-action")) === "Check the hours", "the button naming what to check");
    assert.equal(await offered(page), false);
    await noteSays(page, "at least 0.017 (one minute)");
    await page.getByTestId("expiry-hours").fill("0.017");
    const from = Math.floor(Date.now() / 1000);
    await pressUntil(page, async () => (await page.getByTestId("deal-link").count()) === 1, "the deal's link");
    const left = Number((await w.deals.read.getDeal(1)).expiry) - from;
    assert.ok(left >= 60 && left < 70, `the deal expires ${left} s after it was made`);
  });
}));

test("a link whose end is not a deal number says so", () => onSite(async (site) => {
  await withPage(site, "#/d/12abc", null, (page) => shows(page, "deal-status", (s) => s === "not-found", '"not-found"', "data-status"));
}));
