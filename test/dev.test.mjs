// npm run dev, as a person uses it: the page on a local chain with a stand-in wallet and a bar that switches between
// the seller and the buyer and moves the chain's time. One browser funds a vesting deal, settles it and claims.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { chromium } from "playwright";
import { pressUntil, seen, shows, until } from "../.launchpad/checks/round-1/page.mjs";

test("npm run dev: the seller funds a vesting deal, the buyer settles it, 45 days pass and the buyer claims half", async () => {
  const dev = spawn(process.execPath, ["scripts/dev.mjs"], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  let browser;
  try {
    browser = await chromium.launch();
    const said = await new Promise((resolve, reject) => {
      let text = "";
      dev.stdout.on("data", (chunk) => (text += chunk).includes("Ctrl-C") && resolve(text));
      dev.on("exit", (code) => reject(new Error(`scripts/dev.mjs stopped with ${code}`)));
    });
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(said)[0];
    const address = (name) => new RegExp(`^${name}\\s+(0x[0-9a-fA-F]{40})`, "m").exec(said)[1];
    const page = await (await browser.newContext({ locale: "en-US", timezoneId: "UTC", viewport: { width: 1440, height: 900 } })).newPage();
    page.setDefaultTimeout(5000);

    await page.goto(`${url}#/v2/new`); // a new tab has the seller's wallet
    await page.getByTestId("delivery-vesting").check();
    const entered = { "base-token": address("FAM"), allocation: "1000000", "quote-token": address("USDC"), quote: "123.456789", buyer: address("Buyer") };
    for (const [id, value] of Object.entries(entered)) await page.getByTestId(id).fill(value);
    await pressUntil(page, async () => (await page.getByTestId("deal-link").count()) === 1, "the deal's link");
    assert.equal(await page.getByTestId("deal-link").getAttribute("href"), `${url}#/v2/d/1`);

    // The bar: from now on the browser has the buyer's wallet. Choosing reloads the page.
    await Promise.all([page.waitForEvent("load"), page.selectOption("#dev-account", address("Buyer"))]);
    await page.goto(`${url}#/v2/d/1`);
    await pressUntil(page, async () => (await seen(page, "grant-status", "data-status")) === "cliff", "the deal settled into a grant");
    await page.getByRole("button", { name: "+45 days" }).click();
    await shows(page, "grant-claimable", (text) => text.startsWith("500,00"), "about half, on day 45");
    await page.getByTestId("primary-action").click();
    await until(async () => (await seen(page, "grant-claimed"))?.startsWith("500,00") && (await seen(page, "grant-claimable")) === "0", "half claimed");
    assert.match(await seen(page, "last-receipt", "data-tx"), /^0x[0-9a-f]{64}$/);
  } finally {
    dev.kill();
    await browser?.close();
  }
});
