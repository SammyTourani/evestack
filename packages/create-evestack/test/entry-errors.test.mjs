/**
 * Neither front door may answer a wrong directory with a stack trace.
 *
 * `attach` refuses six ordinary situations by throwing, each with a multi-line
 * message naming the next command to run. Through `evestack attach` those arrive
 * as prose, because src/cli.mjs wraps the call. Through `npx create-evestack
 * attach` they arrived as an uncaught exception — the good message buried under
 * `throw new Error(`, four `at …` frames and `Node.js v26.0.0`.
 *
 * Same code, same message, and the door that needs no global install was the one
 * showing the stack trace. That is the door a first-timer uses, and pointing at
 * the wrong directory is the most ordinary mistake there is.
 *
 * The exit code was already correct, which is why this is a test about output.
 * Nothing typechecks or unit-tests the difference between a message and a message
 * wrapped in a crash; only running it shows that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");

function run(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [ENTRY, ...args], { cwd, encoding: "utf8" });
}

/** The fingerprints of an uncaught exception, as a reader sees them. */
function looksLikeACrash(output) {
  return [
    /\n\s+at [\w$.<>]+ \(/, // a stack frame
    /throw new Error\(/, // the source line node echoes
    /^Node\.js v\d/m, // node's footer
    /file:\/\/\/.*\.mjs:\d+/, // a file:// url with a line number
  ].filter((pattern) => pattern.test(output));
}

test("a directory that is not an eve project is explained, not crashed", () => {
  // A real Node project, deliberately: this is the near miss, not the far one.
  const dir = mkdtempSync(join(tmpdir(), "evestack-attach-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mine", version: "1.0.0" }));

  const result = run(["attach", dir, "--yes"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, "a refusal is exit 1");
  assert.match(output, /lists no "eve" dependency/, "the reason survives");
  assert.match(output, /npx eve init \./, "and so does the way out of it");

  const crashes = looksLikeACrash(output);
  assert.deepEqual(crashes, [], `output reads as a crash: ${crashes.join(", ")}\n${output}`);
});

test("a directory that does not exist is explained, not crashed", () => {
  const result = run(["attach", join(tmpdir(), "evestack-definitely-not-here"), "--yes"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /No such directory/);
  assert.deepEqual(looksLikeACrash(output), [], output);
});

test("a package.json that is not JSON is explained, not crashed", () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-attach-"));
  writeFileSync(join(dir, "package.json"), "{ this is not json");

  const result = run(["attach", dir, "--yes"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /not valid JSON/);
  assert.deepEqual(looksLikeACrash(output), [], output);
});

test("--help still works and exits 0", () => {
  // The refactor that added the catch also moved the help branch, so this is here
  // to catch that going wrong rather than because help is fragile.
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /evestack attach/);
});

test("refusing to scaffold over a non-empty directory is still exit 1, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-create-"));
  writeFileSync(join(dir, "something.txt"), "already here");

  const result = run([dir, "--yes"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /already exists and is not empty/);
  assert.deepEqual(looksLikeACrash(output), [], output);
});
