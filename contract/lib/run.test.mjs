/**
 * The static contract runner's own regression suite.
 *
 * `find contract -name '*test*'` used to return exactly one file — the RUNTIME
 * probe runner's selection tests. The 453-line static runner, the recorder
 * factory and the whole floor mechanism had no automated coverage at all, and
 * that gap is what three measured defects cost:
 *
 *   · a contract that recorded ZERO assertions was reported PASS, counted in
 *     the "N contracts" headline, and rendered as "0 ok" in the table this
 *     runner pastes into eve-upgrade pull-request bodies;
 *   · a FAILING assertion recorded one macrotask after `check` resolved was
 *     dropped — no failure, no change in the count, no warning, exit 0. One
 *     MICROtask late was still caught, which is why nobody had noticed;
 *   · contract/lib/floor.mjs cannot rescue either of them, because it only
 *     iterates ids already present in floor.json.
 *
 * Everything here runs the runner as a real SUBPROCESS. That is deliberate and
 * it is the same reasoning contract/runtime/lib/selection.test.mjs gives: none
 * of these defects is in a function that can be called and asserted on. Each of
 * them is an EXIT CODE and a sentence in a report, and the only place either of
 * those exists is at the process boundary.
 *
 * The fixtures are written to a temporary directory and passed with
 * `--contracts`, so proving that a broken contract fails never involves putting
 * a broken contract in contract/contracts/. `--floor` is the same argument for
 * the floor file.
 *
 *   node --test 'contract/lib/*.test.mjs'
 *
 * The quotes are load-bearing: node must expand the glob, not the shell.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(REPO, "contract", "run.mjs");

const scratch = mkdtempSync(join(tmpdir(), "evestack-contract-runner-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;

/**
 * Writes each fixture as its own `*.contract.mjs` in a fresh directory and
 * returns that directory. Fresh per call, so one test's fixtures cannot leak
 * into another's run and make a failure impossible to attribute.
 */
function fixtures(...sources) {
  const dir = join(scratch, `case-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  sources.forEach((source, index) => {
    writeFileSync(join(dir, `${String(index).padStart(2, "0")}.contract.mjs`), source);
  });
  return dir;
}

/** A contract module whose `check` is the given source text. */
function contract(id, check, extra = "") {
  return (
    `export default {\n` +
    `  id: ${JSON.stringify(id)},\n` +
    `  title: "fixture",\n` +
    `  assumption: "a fixture, asserted on by contract/lib/run.test.mjs",\n` +
    `  evestackUse: "nothing; this contract exists only inside a test",\n` +
    `${extra}` +
    `  check: ${check},\n` +
    `};\n`
  );
}

/**
 * `env` is spread over a copy so an EVESTACK_CONTRACT_EVE_DIR in the developer's
 * shell cannot silently turn every fixture into a skipped repo-scoped contract.
 */
function run(args) {
  const clean = { ...process.env };
  delete clean.EVESTACK_CONTRACT_EVE_DIR;
  const result = spawnSync(process.execPath, [RUNNER, ...args], { cwd: REPO, encoding: "utf8", env: clean });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

/** A floor file of its own, so no test can touch the committed one. */
function floorFile(contracts) {
  const file = join(scratch, `floor-${(counter += 1)}.json`);
  writeFileSync(file, `${JSON.stringify({ contracts }, null, 2)}\n`);
  return file;
}

/* -------------------------------------------------------------------------- */
/* the control: the harness can report a pass                                  */
/* -------------------------------------------------------------------------- */

// Every test below asserts that something FAILS. Without this one, a runner
// that failed unconditionally would satisfy the entire file — which is the
// exact shape of defect the file exists to catch, reproduced in its own harness.
test("a contract that asserts something true passes, and says how much it asserted", () => {
  const dir = fixtures(contract("fixture/honest", "(_eve, t) => { t.ok(true, 'a real assertion'); }"));
  const { code, out } = run([`--contracts=${dir}`, `--floor=${floorFile({})}`]);
  assert.equal(code, 0, `an honest contract must pass\n${out}`);
  assert.match(out, /1 contracts, 1 assertions — all green/);
});

/* -------------------------------------------------------------------------- */
/* a contract that asserts NOTHING                                             */
/* -------------------------------------------------------------------------- */

test("a contract that records zero assertions fails instead of reporting 0 ok", () => {
  const dir = fixtures(contract("fixture/asserts-nothing", "() => {}"));
  const { code, out } = run([`--contracts=${dir}`, `--floor=${floorFile({})}`]);
  assert.equal(code, 1, `a check that cannot fail must not pass\n${out}`);
  assert.match(out, /recorded no assertions/);
  assert.match(out, /fixture\/asserts-nothing/);
  assert.doesNotMatch(out, /all green/);
});

test("the zero-assertion failure reaches the Markdown pasted into pull requests", () => {
  const dir = fixtures(contract("fixture/asserts-nothing", "() => {}"));
  const { out } = run([`--contracts=${dir}`, `--floor=${floorFile({})}`, "--format=markdown"]);
  // The precise sentence that used to be published for an empty contract.
  assert.doesNotMatch(out, /All 1 contracts hold/);
  assert.doesNotMatch(out, /\| 0 ok \|/);
  assert.match(out, /1 of 1 contracts broken/);
});

test("an empty contracts directory is a usage error, and says the true reason", () => {
  const dir = fixtures();
  const { code, out, err } = run([`--contracts=${dir}`]);
  assert.equal(code, 2, `an empty suite must not certify anything\n${out}${err}`);
  assert.doesNotMatch(out + err, /all green/);
  assert.match(err, /No \*\.contract\.mjs files/);
  // Exit 2 alone is not enough to assert on, and asserting only on it is how
  // this test first passed against a runner that had no such guard: the
  // `--only` branch caught the empty suite by accident and reported
  // "--only=null matched none of the 0 contracts" — a usage error blamed on a
  // flag nobody passed. A message that names the wrong cause sends the reader
  // to the wrong file, so the message is part of the fix and part of the test.
  assert.doesNotMatch(err, /--only=null/);
});

/* -------------------------------------------------------------------------- */
/* an assertion recorded late                                                  */
/* -------------------------------------------------------------------------- */

test("a failing assertion recorded one macrotask late is counted, not dropped", () => {
  const dir = fixtures(
    contract(
      "fixture/late-macrotask",
      "(_eve, t) => { t.ok(true, 'on time'); setTimeout(() => t.ok(false, 'LATE FAILURE'), 0); }",
    ),
  );
  const { code, out } = run([`--contracts=${dir}`, `--floor=${floorFile({})}`]);
  assert.equal(code, 1, `the late failure vanished again\n${out}`);
  assert.match(out, /LATE FAILURE/);
  assert.match(out, /1 of 2 assertions/);
});

test("a failing assertion recorded one microtask late is still counted", () => {
  const dir = fixtures(
    contract("fixture/late-microtask", "(_eve, t) => { Promise.resolve().then(() => t.ok(false, 'MICRO FAILURE')); }"),
  );
  const { code, out } = run([`--contracts=${dir}`, `--floor=${floorFile({})}`]);
  assert.equal(code, 1, `\n${out}`);
  assert.match(out, /MICRO FAILURE/);
});

test("an assertion later than the runner waits is a loud crash, never a silent no-op", () => {
  // Later than `settle`, so it lands after this contract was counted and sealed.
  // The second fixture keeps the process alive long enough for the timer to
  // fire; without it the run would simply exit first, which is a different
  // (and harmless) outcome.
  const dir = fixtures(
    contract("fixture/very-late", "(_eve, t) => { t.ok(true, 'on time'); setTimeout(() => t.ok(false, 'WAY LATE'), 30); }"),
    contract("fixture/slow", "async (_eve, t) => { await new Promise((r) => setTimeout(r, 150)); t.ok(true, 'slow'); }"),
  );
  const { code, out, err } = run([`--contracts=${dir}`, `--floor=${floorFile({})}`]);
  assert.notEqual(code, 0, `a write to a sealed recorder must not be survivable\n${out}${err}`);
  assert.match(err, /fixture\/very-late/);
  assert.match(err, /after its check had finished/);
  assert.match(err, /WAY LATE/);
  assert.doesNotMatch(out, /all green/);
});

/* -------------------------------------------------------------------------- */
/* the failure paths that already worked, locked in                            */
/* -------------------------------------------------------------------------- */

test("a plainly failing assertion exits 1", () => {
  const dir = fixtures(contract("fixture/plainly-false", "(_eve, t) => { t.ok(false, 'this is false'); }"));
  const { code, out } = run([`--contracts=${dir}`, `--floor=${floorFile({})}`]);
  assert.equal(code, 1, `\n${out}`);
  assert.match(out, /this is false/);
});

test("a check that throws is reported as a failure rather than crashing the run", () => {
  const dir = fixtures(
    contract("fixture/throws", "() => { throw new Error('eve moved something'); }"),
    contract("fixture/after-the-throw", "(_eve, t) => { t.ok(true, 'still ran'); }"),
  );
  const { code, out } = run([`--contracts=${dir}`, `--floor=${floorFile({})}`]);
  assert.equal(code, 1, `\n${out}`);
  assert.match(out, /the contract check itself threw/);
  // The contracts after it must still run: one broken contract is not a reason
  // to stop reporting the other twenty-two.
  assert.match(out, /fixture\/after-the-throw/);
});

test("a contract that throws at IMPORT time exits non-zero", () => {
  const dir = fixtures(`throw new Error("this module is broken");\n`);
  const { code, out, err } = run([`--contracts=${dir}`, `--floor=${floorFile({})}`]);
  assert.notEqual(code, 0, `an unloadable contract file must not be a pass\n${out}${err}`);
  assert.match(err, /this module is broken/);
  assert.doesNotMatch(out, /all green/);
});

/* -------------------------------------------------------------------------- */
/* the floor                                                                   */
/* -------------------------------------------------------------------------- */

test("a contract that asserts less than its floor exits 3 and names the shrink", () => {
  const dir = fixtures(contract("fixture/shrunk", "(_eve, t) => { t.ok(true, 'one'); t.ok(true, 'two'); }"));
  const { code, out, err } = run([`--contracts=${dir}`, `--floor=${floorFile({ "fixture/shrunk": 5 })}`]);
  assert.equal(code, 3, `a shrinking suite must not exit 0\n${out}${err}`);
  assert.match(err, /THE SUITE SHRANK/);
  assert.match(err, /asserted 2, floor is 5/);
});

test("a contract in the floor that did not run at all is a floor violation", () => {
  const dir = fixtures(contract("fixture/present", "(_eve, t) => { t.ok(true, 'one'); }"));
  const { code, err } = run([`--contracts=${dir}`, `--floor=${floorFile({ "fixture/present": 1, "fixture/deleted": 3 })}`]);
  assert.equal(code, 3);
  assert.match(err, /fixture\/deleted is in the floor but did not run at all/);
});

test("growing past the floor is not a violation", () => {
  const dir = fixtures(contract("fixture/grown", "(_eve, t) => { t.ok(true, 'one'); t.ok(true, 'two'); }"));
  const { code, out } = run([`--contracts=${dir}`, `--floor=${floorFile({ "fixture/grown": 1 })}`]);
  assert.equal(code, 0, `the floor is a minimum, not an equality\n${out}`);
});

test("--write-floor records what the suite asserts, and the recorded floor then holds", () => {
  const dir = fixtures(contract("fixture/recorded", "(_eve, t) => { t.ok(true, 'one'); t.ok(true, 'two'); }"));
  const file = floorFile({});
  const written = run([`--contracts=${dir}`, `--floor=${file}`, "--write-floor"]);
  assert.equal(written.code, 0, written.out + written.err);
  const { code } = run([`--contracts=${dir}`, `--floor=${file}`]);
  assert.equal(code, 0);
  // …and the number it recorded is the real one, not a placeholder.
  const shrunk = fixtures(contract("fixture/recorded", "(_eve, t) => { t.ok(true, 'one'); }"));
  const after = run([`--contracts=${shrunk}`, `--floor=${file}`]);
  assert.equal(after.code, 3, `--write-floor recorded a floor that cannot be violated\n${after.out}${after.err}`);
});

/* -------------------------------------------------------------------------- */
/* the real suite still runs the way its callers expect                        */
/* -------------------------------------------------------------------------- */

test("the committed suite is green, and says so with real numbers", () => {
  const { code, out } = run([]);
  assert.equal(code, 0, `the committed contract suite is not green\n${out}`);
  const headline = /(\d+) contracts, (\d+) assertions — all green/.exec(out);
  assert.ok(headline, `no headline in:\n${out}`);
  assert.ok(Number(headline[1]) >= 23, `contract count fell to ${headline[1]}`);
  assert.ok(Number(headline[2]) >= 530, `assertion count fell to ${headline[2]}`);
});
