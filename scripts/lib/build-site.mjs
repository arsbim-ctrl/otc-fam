import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function buildSite(root, output) {
  cpSync(join(root, "web"), output, { recursive: true });
  mkdirSync(join(output, "vendor"), { recursive: true });
  cpSync(join(root, "node_modules/ethers/dist/ethers.min.js"), join(output, "vendor/ethers.min.js"));
}
