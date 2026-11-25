// npm run build: makes dist/, the static site, from web/. The base copies the files as they are;
// an entry may build any other way, as long as "npm run build" leaves dist/index.html.
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
cpSync("web", "dist", { recursive: true });
mkdirSync("dist/vendor", { recursive: true });
cpSync("node_modules/ethers/dist/ethers.min.js", "dist/vendor/ethers.js");
console.log("built dist/ from web/");
