// npm run build: makes dist/, the static site, from web/. The base copies the files as they are;
// the broker pages load the locked ethers browser bundle for local EIP-712 hashing.
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
cpSync(new URL("../web/", import.meta.url), "dist", { recursive: true });
mkdirSync("dist/vendor", { recursive: true });
copyFileSync(new URL("../node_modules/ethers/dist/ethers.min.js", import.meta.url), "dist/vendor/ethers.min.js");
console.log("built dist/ from web/");
