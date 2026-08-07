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
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("pointing create at a FILE is explained, not an errno", () => {
  // The guard was `existsSync(target) && readdirSafe(target).length > 0`, and
  // readdirSafe swallowed ENOTDIR — so a file looked empty enough to scaffold
  // into, and mkdirSync then threw `EEXIST: file already exists, mkdir
  // '/path/README.md'`. index.mjs prints message-only, so that errno was the
  // entire explanation for pointing at a file.
  const dir = mkdtempSync(join(tmpdir(), "evestack-create-"));
  const file = join(dir, "README.md");
  writeFileSync(file, "# not a directory\n");

  const result = run([file, "--yes"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /is a file, not a directory/);
  assert.doesNotMatch(output, /EEXIST/);
  assert.deepEqual(looksLikeACrash(output), [], output);
  assert.equal(readFileSync(file, "utf8"), "# not a directory\n", "the file was written to");
});

test("a directory that cannot be created is explained, not an errno", () => {
  // `npx create-evestack /etc/foo`: nothing exists at the path and there is no
  // permission to make it, so the guard passes and mkdirSync throws EACCES.
  const result = run(["/etc/evestack-should-not-be-creatable", "--yes"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /Could not create/);
  assert.match(output, /not writable by this user/);
  assert.deepEqual(looksLikeACrash(output), [], output);
});

test("an unknown flag creates nothing, rather than a directory named after its value", () => {
  // Verified before the fix: this created a directory called `5000`.
  const dir = mkdtempSync(join(tmpdir(), "evestack-create-"));
  const result = spawnSync(process.execPath, [ENTRY, "--port", "5000"], { cwd: dir, encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /Unknown option "--port"/);
  assert.equal(existsSync(join(dir, "5000")), false, "a directory named after the flag's value exists");
  assert.deepEqual(looksLikeACrash(output), [], output);
});

test("--version prints one line and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-create-"));
  const result = spawnSync(process.execPath, [ENTRY, "--version"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  assert.deepEqual(readdirSync(dir), [], "--version left something behind");
});
