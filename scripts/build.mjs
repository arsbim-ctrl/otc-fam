// npm run build produces dist/ for static hosting and the frozen page checks.
import { rmSync } from "node:fs";
import { buildSite } from "./lib/build-site.mjs";

rmSync("dist", { recursive: true, force: true });
buildSite(process.cwd(), "dist");
console.log("built dist/ from web/");
