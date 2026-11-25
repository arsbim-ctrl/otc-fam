// npm run build: makes dist/, the static site, from web/. The base copies the files as they are;
// an entry may build any other way, as long as "npm run build" leaves dist/index.html.
// "node scripts/build.mjs <folder>" builds into another folder: the tests do, each into one of its own, so that
// test files that run side by side never serve a site another one is rebuilding.
import { cpSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";

const out = process.argv[2] ?? "dist";
// The folder is emptied first: it must not be this one, or one that holds the sources.
if (!relative(resolve(out), resolve("web")).startsWith("..")) {
  console.error(`${out} holds web/: the site is not built over its own sources.`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync("web", out, { recursive: true });
console.log(`built ${out}${out.endsWith("/") ? "" : "/"} from web/`);
