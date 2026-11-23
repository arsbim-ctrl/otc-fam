import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { actors, root, serveV2, v2World } from "../test/support/v2-site.mjs";

execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });
const world = await v2World();
const site = await serveV2(world, { demo: true, port: Number(process.env.DEMO_PORT ?? 0), directory: join(root, "dist") });
console.log(`Seller: ${site.url}/?wallet=seller#/v2/new`);
console.log(`Buyer address: ${actors.buyer}`);
console.log(`Allocation token (ALFA): ${world.base.address}`);
console.log(`Payment token (USDC, 6 decimals): ${world.quote.address}`);
console.log("To act as buyer, open the funded link with ?wallet=buyer before the #. Remove the query string for wallet-free reading.");
console.log("This server holds synthetic balances on a disposable local chain. Press Ctrl+C to stop.");
