// The site uses the ESM browser build of the repository's pinned ethers dependency.
import { copyFileSync, cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(require.resolve("ethers")), "..");

rmSync("dist", { recursive: true, force: true });
cpSync("web", "dist", { recursive: true });
copyFileSync(resolve(packageRoot, "dist/ethers.min.js"), "dist/ethers.min.js");
copyFileSync(resolve(packageRoot, "LICENSE.md"), "dist/ethers-LICENSE.md");
console.log("Built static site in dist/");
