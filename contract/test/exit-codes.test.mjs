/**
 * The runner's exit codes, and specifically which one wins when two things are
 * wrong at once.
 *
 * `node contract/run.mjs` answers with 0, 1, 2 or 3, and CI, the eve-watch
 * workflow and anyone piping it into a shell all branch on that number. Two of
 * the conditions can hold in the same run: a contract can fail while the suite
 * has also shrunk below `contract/floor.json`. Until this file existed the
 * shrink won, and the failure — the one that says an assumption about the
 * installed eve no longer holds — never reached the exit code at all. A caller
 * checking `=== 1` saw a 3 and read it as bookkeeping.
 *
 * Testing that by hand means editing floor.json and a contract in the working
 * tree and remembering to put them back, which is exactly the kind of check that
 * gets run once. So each case here builds a throwaway repo instead: a scratch
 * directory of symlinks to every top-level entry of this checkout, with a real
 * copy of `contract/` that the test is free to vandalise. The runner resolves
 * REPO_ROOT from its own location, so it reads the copy's floor.json and the
 * copy's contracts while still seeing the real packages, templates and installed
 * eve through the symlinks. Nothing in the working tree is touched, and a crashed
 * test leaves a scratch directory behind rather than a broken floor in git.
 *
 *   node --test contract/test/*.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const scratches = [];

after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

/** A repo the test is free to break: symlinks for everything, a real copy of contract/. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "evestack-exit-codes-"));
  scratches.push(dir);
  for (const entry of readdirSync(REPO_ROOT)) {
    if (entry === "contract") continue;
    symlinkSync(join(REPO_ROOT, entry), join(dir, entry));
  }
  cpSync(join(REPO_ROOT, "contract"), join(dir, "contract"), { recursive: true });
  return dir;
}

function run(dir) {
  const result = spawnSync(process.execPath, [join(dir, "contract", "run.mjs")], { encoding: "utf8" });
  assert.equal(result.error, undefined, `spawning the runner failed: ${result.error?.message}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function editFloor(dir, edit) {
  const file = join(dir, "contract", "floor.json");
  const floor = JSON.parse(readFileSync(file, "utf8"));
  edit(floor.contracts);
  writeFileSync(file, `${JSON.stringify(floor, null, 2)}\n`);
}

/**
 * Makes the suite shrink without deleting anything real: one existing contract's
 * minimum is raised past the number it actually asserts, which is the same
 * shortfall a deleted import would produce and stays true as the suite grows.
 */
function makeItShrink(dir) {
  editFloor(dir, (contracts) => {
    contracts["hooks/observe-only-and-event-names"] = 9000;
  });
}

/**
 * Makes one contract fail, by adding one that cannot pass. It gets a floor entry
 * of its own so this arranges a failure and nothing else — a contract that runs
 * but is missing from the floor is a separate hole, and a test that accidentally
 * opens it is not testing what it says it is.
 */
function makeItFail(dir) {
  writeFileSync(
    join(dir, "contract", "contracts", "99-injected-failure.contract.mjs"),
    `export default {
  id: "test/deliberately-fails",
  title: "a contract that cannot pass, injected by contract/test/exit-codes.test.mjs",
  assumption: "nothing — this exists to make a run red on purpose",
  evestackUse: "nothing; it is never present in a real checkout",
  async check(_eve, t) {
    t.ok(false, "this assertion fails by construction");
  },
};
`,
  );
  editFloor(dir, (contracts) => {
    contracts["test/deliberately-fails"] = 1;
  });
}

test("an untouched copy of the suite exits 0", () => {
  const { code, stdout } = run(scratchRepo());
  assert.equal(code, 0, stdout);
  assert.match(stdout, /all green against eve/);
});

test("a shrunken suite alone exits 3", () => {
  const dir = scratchRepo();
  makeItShrink(dir);
  const { code, stderr } = run(dir);
  assert.equal(code, 3, stderr);
  assert.match(stderr, /THE SUITE SHRANK/);
});

test("a floor entry for a contract that does not exist also exits 3", () => {
  const dir = scratchRepo();
  editFloor(dir, (contracts) => {
    contracts["ghost/never-existed"] = 7;
  });
  const { code, stderr } = run(dir);
  assert.equal(code, 3, stderr);
  assert.match(stderr, /ghost\/never-existed is in the floor but did not run at all/);
});

test("a failing contract alone exits 1", () => {
  const dir = scratchRepo();
  makeItFail(dir);
  const { code, stdout, stderr } = run(dir);
  assert.equal(code, 1, stderr);
  assert.match(stdout, /FAIL {2}test\/deliberately-fails/);
  assert.doesNotMatch(stderr, /SHRANK/);
});

test("a run that both fails and shrinks exits 1, and still reports the shrink", () => {
  const dir = scratchRepo();
  makeItFail(dir);
  makeItShrink(dir);
  const { code, stdout, stderr } = run(dir);

  // The point of the whole file. 3 here would mean the failure was swallowed by
  // a bookkeeping code, which is what this runner used to do.
  assert.equal(code, 1, `expected the failure to win the exit code\n${stdout}\n${stderr}`);

  // Winning the exit code must not mean silencing the other finding: both are
  // real, both are printed, and only the more urgent one sets the number.
  assert.match(stderr, /THE SUITE ALSO SHRANK/);
  assert.match(stderr, /hooks\/observe-only-and-event-names asserted \d+, floor is 9000/);
  assert.match(stderr, /sets the exit\s+code \(1\)/);
  assert.match(stdout, /FAIL {2}test\/deliberately-fails/);
});

test("a ghost floor entry loses to a failing contract too", () => {
  const dir = scratchRepo();
  makeItFail(dir);
  editFloor(dir, (contracts) => {
    contracts["ghost/never-existed"] = 7;
  });
  const { code, stderr } = run(dir);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /ghost\/never-existed is in the floor but did not run at all/);
});
