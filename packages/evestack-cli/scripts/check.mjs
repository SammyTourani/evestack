#!/usr/bin/env node
/**
 * `node --check` over every source file.
 *
 * This package is plain ESM with no build step, which is the same choice
 * create-evestack made and for the same reason: a CLI that has to run inside
 * someone else's broken deployment is worth keeping to one runtime and zero
 * compile steps. That trades away a type checker, so this is the substitute —
 * cheap, and it catches the class of mistake a no-build package is most exposed
 * to, which is a syntax error in a file nothing imported during testing.
 */
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["bin", "src", "scripts", "test"];

let checked = 0;
let failed = 0;

for (const dir of DIRS) {
  const path = join(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(path);
  } catch {
    continue;
  }
  for (const entry of entries) {
    const file = join(path, entry);
    if (!entry.endsWith(".mjs") || !statSync(file).isFile()) continue;
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    checked++;
    if (result.status !== 0) {
      failed++;
      process.stderr.write(result.stderr);
    }
  }
}

process.stdout.write(`checked ${checked} file(s), ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
