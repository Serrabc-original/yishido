import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const fixtureDir = "test/fixtures";
const files = (await readdir(fixtureDir))
  .filter((name) => name.endsWith(".json"))
  .sort();

let failures = 0;

for (const file of files) {
  const fixturePath = join(fixtureDir, file);
  const result = spawnSync(process.execPath, ["scripts/simulate-media-intake.js", fixturePath], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    failures += 1;
    console.error("INPUT_CASE_FAILED", fixturePath);
    console.error(result.stderr || result.stdout);
  } else {
    console.log("INPUT_CASE_OK", fixturePath);
  }
}

if (failures) {
  process.exit(1);
}
