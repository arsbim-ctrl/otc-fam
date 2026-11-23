// npm run dev: the page on a local chain, for a person to click through with no wallet extension and no test
// network. It starts a chain inside this process, deploys both deal contracts and two test tokens (FAM with 18
// decimals, USDC with 6), gives the seller FAM and the buyer USDC, and serves web/ at http://127.0.0.1:8787 with a
// stand-in wallet in the page (scripts/dev-wallet.js): a bar at the bottom switches between the seller, the buyer and
// a stranger, and moves the chain's time forward, so a grant can be followed past its cliff and its end in a minute.
// Nothing here is for a real network: the wallet holds no key, and the chain forgets everything when this stops.
// PORT and HOST change where it listens (HOST=0.0.0.0 inside a container).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { CHAIN_ID } from "../.launchpad/checks/round-1/chain.mjs";
import { wallet } from "../.launchpad/checks/round-1/page.mjs";
import { world } from "../test/lib/v2-world.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const root = realpathSync(resolve("web")), port = Number(process.env.PORT ?? 8787), host = process.env.HOST ?? "127.0.0.1";

const w = await world();
const people = { Seller: w.seller, Buyer: w.buyer, Stranger: w.other };
await w.fam.as(w.deployer).mint(w.seller, 10_000_000n * 10n ** 18n);
for (const who of [w.buyer, w.other]) await w.usdc.as(w.deployer).mint(who, 10_000n * 10n ** 6n);
const wallets = Object.fromEntries(Object.values(people).map((account) => [account, wallet(w, account)]));
const setup = { people, tokens: { FAM: w.fam.address, USDC: w.usdc.address }, treasury: w.treasury };

const body = async (req) => {
  let text = "";
  for await (const chunk of req) if ((text += chunk).length > 1_000_000) throw new Error("too large");
  return JSON.parse(text);
};
const server = createServer(async (req, res) => {
  const send = (status, type, content) => res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(content);
  const json = (value) => send(200, "application/json", JSON.stringify(value));
  try {
    const path = decodeURIComponent(new URL(req.url, "http://dev").pathname);
    if (req.method === "POST" && path === "/rpc") return json(await w.chain.publicRpc(await body(req)));
    if (req.method === "POST" && path === "/dev/wallet") {
      const { account, request } = await body(req);
      return json(wallets[account] ? await wallets[account](request) : { error: { code: 4100, message: "no such person" } });
    }
    if (req.method === "POST" && path === "/dev/time") {
      const { seconds } = await body(req);
      if (!Number.isSafeInteger(seconds) || seconds <= 0) return send(400, "text/plain", "seconds must be a positive whole number");
      await w.at((await w.chain.now()) + seconds);
      return json({ time: await w.chain.now() });
    }
    if (req.method !== "GET") return send(405, "text/plain", "GET, or POST /rpc");
    if (path === "/config.json") return json({ chainId: CHAIN_ID, contract: w.legacy.address, contractV2: w.deals.address, fromBlockV2: 0, rpcUrl: "rpc" });
    if (path === "/dev/wallet.js") return send(200, TYPES[".js"], `window.__dev = ${JSON.stringify(setup)};\n${readFileSync(new URL("./dev-wallet.js", import.meta.url), "utf8")}`);
    const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
    const real = existsSync(file) ? realpathSync(file) : null;
    if (!real || !real.startsWith(root + sep) || !statSync(real).isFile()) return send(404, "text/plain", "not found");
    // The stand-in wallet must be in the page before the page's own script looks for one.
    if (real.endsWith(`${sep}index.html`)) return send(200, TYPES[".html"], readFileSync(real, "utf8").replace('<script type="module"', '<script src="dev/wallet.js"></script>\n  <script type="module"'));
    send(200, TYPES[extname(real)] ?? "application/octet-stream", readFileSync(real));
  } catch (e) {
    send(400, "text/plain", String(e.message));
  }
});
server.listen(port, host, () => {
  console.log(`otc.fam on a local chain: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${server.address().port}/\n`);
  for (const [name, address] of Object.entries(people)) console.log(`${name.padEnd(9)} ${address}`);
  console.log(`FAM       ${setup.tokens.FAM}  (18 decimals; the seller holds 10,000,000)`);
  console.log(`USDC      ${setup.tokens.USDC}  (6 decimals; the buyer and the stranger hold 10,000 each)`);
  console.log(`Treasury  ${setup.treasury}\n`);
  console.log("The bar at the bottom of the page chooses whose wallet the browser has, and moves the chain's time. Ctrl-C stops it.");
});
