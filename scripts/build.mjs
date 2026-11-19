// Build the static site and copy the pinned browser library locally. No network or config substitution.
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
cpSync("web", "dist", { recursive: true });
mkdirSync('dist/vendor', { recursive: true });
cpSync('node_modules/ethers/dist/ethers.min.js', 'dist/vendor/ethers.js');
console.log('Built dist/ with local assets and runtime config.json.');
