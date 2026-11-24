import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const screens = join(root, "screens");
mkdirSync(screens, { recursive: true });
const staging = mkdtempSync(join(screens, "evidence-"));
const replayFolder = relative(root, staging);
const widths = [390, 1440];
const sceneCount = 34;

try {
  const logPath = join(staging, "play.txt");
  const log = openSync(logPath, "w");
  try {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, "run", "play", "--", replayFolder], {
      cwd: root, stdio: ["ignore", log, "inherit"],
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, "npm run play must complete before replacing evidence");
  } finally {
    closeSync(log);
  }

  const text = readFileSync(logPath, "utf8");
  const output = join(staging, "round-3");
  const images = readdirSync(output, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jpg")).map((entry) => entry.name).sort();
  assert.equal(images.length, sceneCount * widths.length);
  for (const width of widths) {
    assert.ok(text.includes(`Broker deal replay verified at ${width} px · ${sceneCount} screenshots.`));
    const scenes = images.filter((name) => name.endsWith(`-${width}.jpg`)).map((name) => Number(name.slice(0, 2)));
    assert.deepEqual(scenes, Array.from({ length: sceneCount }, (_, i) => i + 1));
  }
  const logged = Array.from(text.matchAll(/^--- (\S+-(?:390|1440)\.jpg)$/gm), ([, name]) => name).sort();
  assert.deepEqual(logged, images, "the log must name the same Round 3 screenshots as the replay");
  const footer = text.trimEnd().split("\n").at(-1);
  assert.ok(footer.startsWith("Every scene played at 390 px and 1440 px, and every balance was as the deal says."));
  assert.ok(footer.endsWith(`screenshots are in ${replayFolder}/`));

  const destination = join(root, "evidence", "round-3");
  mkdirSync(destination, { recursive: true });
  for (const name of images) copyFileSync(join(output, name), join(destination, name));
  copyFileSync(logPath, join(destination, "play.txt"));
  assert.equal(readdirSync(destination).filter((name) => name.endsWith(".jpg")).length, images.length);
  console.log(`Wrote ${images.length} Round 3 screenshots and play.txt from one replay.`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
