// The page on a world (world.mjs), built with the same assets as "npm run build", served on
// 127.0.0.1 with a config.json that names the deal contracts and a read-only JSON-RPC endpoint, and opened in
// Chromium at a phone's or a desktop's width, with a stand-in wallet as window.ethereum or with no wallet at all.
// The tests (test/v2-page.test.mjs) and the scenes (scripts/play.mjs) both use it.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, sep } from "node:path";
import { chromium } from "playwright";
import { CHAIN_ID } from "../../.launchpad/checks/round-1/chain.mjs";
import { ROOT } from "../../.launchpad/checks/round-1/lib/entry.mjs";
import { wallet as checksWallet } from "../../.launchpad/checks/round-1/page.mjs";
import { buildSite } from "./build-site.mjs";

export { offered, pressUntil, seen, shows, until } from "../../.launchpad/checks/round-1/page.mjs";
export const PHONE = { width: 390, height: 844 }, DESKTOP = { width: 1440, height: 900 };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

let built;
function siteRoot() {
  if (built) return built;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "otc-site-")));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  buildSite(ROOT, root);
  built = root;
  return built;
}

/** Serves a private build snapshot, isolated from dist/ while the v1 tests serve it. */
export async function serve(w, more = {}) {
  const root = siteRoot();
  let url;
  const server = createServer(async (req, res) => {
    const send = (status, type, body) => res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
    try {
      const path = decodeURIComponent(new URL(req.url, url).pathname);
      if (req.method === "POST" && path === "/rpc") {
        let body = "";
        for await (const chunk of req) if ((body += chunk).length > 1_000_000) return send(413, "text/plain", "too large");
        return send(200, "application/json", JSON.stringify(await w.chain.publicRpc(JSON.parse(body))));
      }
      if (req.method !== "GET") return send(405, "text/plain", "GET, or POST /rpc");
      if (path === "/config.json") {
        return send(200, "application/json", JSON.stringify({ chainId: CHAIN_ID, contract: w.legacy.address, contractV2: w.deals.address, fromBlockV2: w.fromBlockV2, rpcUrl: "rpc", ...w.brokerConfig, ...more }));
      }
      const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
      const real = existsSync(file) ? realpathSync(file) : null;
      if (!real || !real.startsWith(root + sep) || !statSync(real).isFile()) return send(404, "text/plain", "not found");
      send(200, TYPES[extname(real)] ?? "application/octet-stream", readFileSync(real));
    } catch (e) {
      send(400, "text/plain", String(e.message));
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

/**
 * A stand-in wallet for `account`: it follows EIP-1193, holds no account until the page asks, and says yes to
 * everything at once. `instead(request, answer)` answers first when it returns something, and `asked` collects the
 * name of every request the page made.
 */
export function walletFor(w, account, instead = () => null, asked = []) {
  const answer = checksWallet(w, account);
  return async (request) => {
    asked.push(request.method);
    const changed = await instead(request, answer);
    if (changed) return changed;
    if (request.method === "eth_signTypedData_v4" && w.signAs) {
      const { result } = await answer({ method: "eth_accounts" });
      if (result.length) return w.signAs(account, request);
    }
    return answer(request);
  };
}

/** Runs in the page before its own scripts: window.ethereum, answered by the wallet above. */
function injectWallet() {
  const listeners = {};
  window.__standEmit = (event, value) => {
    for (const listener of listeners[event] ?? []) listener(value);
  };
  window.ethereum = {
    async request({ method, params }) {
      const { result, error } = await window.__standWallet({ method, params });
      if (error) throw Object.assign(new Error(error.message), { code: error.code, data: error.data });
      if (method === "eth_requestAccounts") window.__standEmit("accountsChanged", result);
      return result;
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return this;
    },
    removeListener(event, listener) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      return this;
    },
  };
}

let browser;
/** Closes the browser the pages share; call it once everything is done. */
export const closeBrowser = () => browser?.then((b) => b.close());

/**
 * Opens `site.url/<hash>` in a fresh browser profile (English, UTC) at `size`, with `wallet` (walletFor) as
 * window.ethereum or none, runs `steps(page)` and closes it. A failure carries what the page itself reported.
 */
export async function browse(site, hash, { wallet = null, size = PHONE, permissions = [], cleanConsole = false } = {}, steps) {
  browser ??= chromium.launch();
  const context = await (await browser).newContext({ locale: "en-US", timezoneId: "UTC", viewport: size, permissions });
  const reported = [];
  try {
    context.setDefaultTimeout(5000);
    if (wallet) {
      await context.exposeBinding("__standWallet", (_source, request) => wallet(request));
      await context.addInitScript(injectWallet);
    }
    const page = await context.newPage();
    page.on("pageerror", (e) => reported.push(`uncaught ${e.message}`));
    page.on("console", (m) => m.type() === "error" && reported.push(m.text()));
    await page.goto(`${site.url}/${hash}`);
    const result = await steps(page);
    if (cleanConsole && reported.length) throw new Error("The page emitted browser errors.");
    return result;
  } catch (e) {
    throw new Error(`${e.message}${reported.length ? `\nThe page reported: ${reported.slice(-5).join(" | ").slice(0, 800)}` : ""}`);
  } finally {
    await context.close().catch(() => {});
  }
}

/** The text of the page's body, as a person reads it. */
export const read = async (page) => (await page.locator("body").innerText()).trim();
/** Whether the page fits its window's width: nothing to scroll sideways. */
export const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
