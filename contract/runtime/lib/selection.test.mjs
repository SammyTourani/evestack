/**
 * The runners' own regression suite: does a check that checked nothing say so?
 *
 * Both contract runners used to answer no. `--only=seem` (a typo for `seam`)
 * selected zero probes, printed "0 probes, 0 checks — all green" and exited 0;
 * `node contract/run.mjs --only=nosuchthing` did the same for the static tier.
 * A CI step with that typo verifies nothing and reports success forever.
 *
 * Most of this file runs the two runners as real subprocesses rather than
 * unit-testing the pure helpers, and that is deliberate: the defect was never
 * in a function, it was in an exit code. Only the process boundary can show
 * that the exit code changed.
 *
 * The CI-invocation block at the bottom is the guard on the guard. Every
 * runtime-runner command line in .github/workflows must survive this change,
 * and the failure mode to avoid is subtle: those steps are SUPPOSED to be able
 * to exit 1 (a --require'd prerequisite was absent) and they are supposed to
 * exit 0 when everything is up. What they must never do now is exit 2, which
 * would mean this file's new argument validation rejected a command line CI
 * depends on. So the assertion is "not 2", not "is 0" — this laptop has no
 * Postgres and no agent, so 1 is the honest local answer for most of them.
 *
 * Nothing runs this yet: contract/ is not a pnpm workspace package, so neither
 * `pnpm -r test` nor any step in .github/workflows reaches it. Wiring it in is
 * a one-line change to the root `test` script that belongs to whoever owns
 * package.json. Until then, by hand — and note the quotes, because Node 25's
 * --test rejects a bare directory:
 *
 *   node --test 'contract/runtime/lib/*.test.mjs'
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { capabilitiesOf, emptySelectionError, groupsOf, requirementErrors } from "./selection.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNTIME = join(REPO, "contract", "runtime", "run.mjs");
const STATIC = join(REPO, "contract", "run.mjs");

/** The runtime runner has to be reachable without a database: every probe is
 *  allowed to skip. `env` is spread over a copy so a WORKFLOW_POSTGRES_URL in
 *  the developer's shell cannot change which branch a test takes. */
function run(script, args, env = {}) {
  const clean = { ...process.env };
  for (const key of ["WORKFLOW_POSTGRES_URL", "EVESTACK_CONTRACT_EVE_DIR"]) delete clean[key];
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...clean, ...env },
  });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

/* -------------------------------------------------------------------------- */
/* contract/runtime/run.mjs — a filter matching nothing                        */
/* -------------------------------------------------------------------------- */

test("runtime: --only matching zero probes is a usage error, not a green run", () => {
  const { code, out, err } = run(RUNTIME, ["--only=seem"]);
  assert.equal(code, 2, `expected exit 2, got ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  assert.match(err, /--only=seem/);
  assert.doesNotMatch(out + err, /all green/);
});

test("runtime: --exclude removing every probe is a usage error", () => {
  // Every id contains a slash, so this is the whole suite excluded.
  const { code, out, err } = run(RUNTIME, ["--exclude=/"]);
  assert.equal(code, 2, `expected exit 2, got ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  assert.match(err, /--exclude=\//);
  assert.doesNotMatch(out + err, /all green/);
});

test("runtime: --list does not quietly print nothing for a filter that matches nothing", () => {
  const { code, out } = run(RUNTIME, ["--list", "--only=seem"]);
  assert.equal(code, 2, `expected exit 2, got ${code}\nstdout:\n${out}`);
  assert.equal(out.trim(), "");
});

test("runtime: a filter that does match still runs", () => {
  const { code, out } = run(RUNTIME, ["--only=memory"]);
  assert.notEqual(code, 2, `usage error on a valid filter\n${out}`);
  assert.match(out, /memory\/recall-does-not-depend-on-the-plan/);
});

/* -------------------------------------------------------------------------- */
/* contract/runtime/run.mjs — --require that cannot require anything           */
/* -------------------------------------------------------------------------- */

test("runtime: --require with a misspelled capability is refused, not ignored", () => {
  const { code, out, err } = run(RUNTIME, ["--require=postgress"]);
  assert.equal(code, 2, `expected exit 2, got ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  assert.match(err, /postgress/);
  // The message has to be actionable: name the vocabulary that does exist.
  assert.match(err, /postgres/);
  assert.doesNotMatch(out + err, /all green/);
});

test("runtime: --require naming a capability no selected probe needs is refused", () => {
  // Every memory probe needs postgres and nothing else, so --require=agent here
  // cannot turn a single skip into a failure — it is a flag that does nothing
  // while looking like protection.
  const { code, out, err } = run(RUNTIME, ["--require=agent", "--only=memory"]);
  assert.equal(code, 2, `expected exit 2, got ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  assert.match(err, /--require=agent/);
});

/* -------------------------------------------------------------------------- */
/* contract/runtime/run.mjs — an all-skipped run is not a green run            */
/* -------------------------------------------------------------------------- */

test("runtime: a run where every probe skipped does not claim to be green", () => {
  // No WORKFLOW_POSTGRES_URL (run() strips it), no --require: all three memory
  // probes skip. Legitimate — but it must not read like a pass.
  const { code, out } = run(RUNTIME, ["--only=memory"]);
  assert.equal(code, 0, `the legitimate skip path must stay exit 0\n${out}`);
  assert.match(out, /SKIP/);
  assert.doesNotMatch(out, /all green/);
  assert.match(out, /NOTHING RAN/);
});

test("runtime: the JSON report distinguishes 'ran and passed' from 'skipped'", () => {
  const { code, out } = run(RUNTIME, ["--only=memory", "--format=json"]);
  assert.equal(code, 0);
  const report = JSON.parse(out);
  assert.equal(report.counts.probes, 3);
  assert.equal(report.counts.skipped, 3);
  assert.equal(report.counts.ran, 0, "counts.ran must exist and be 0 when nothing executed");
});

/* -------------------------------------------------------------------------- */
/* contract/run.mjs — the same hole in the static tier                         */
/* -------------------------------------------------------------------------- */

test("static: --only matching zero contracts is a usage error, not a green run", () => {
  const { code, out, err } = run(STATIC, ["--only=nosuchcontract"]);
  assert.equal(code, 2, `expected exit 2, got ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  assert.match(err, /--only=nosuchcontract/);
  assert.doesNotMatch(out + err, /all green/);
});

test("static: a filter that does match still runs", () => {
  const { code, out } = run(STATIC, ["--only=version"]);
  assert.notEqual(code, 2, `usage error on a valid filter\n${out}`);
  assert.match(out, /version\//);
});

test("static: a run where every contract skipped does not claim to be green", (t) => {
  // Repo-scoped contracts skip under EVESTACK_CONTRACT_EVE_DIR, so pointing the
  // override at the installed eve and selecting only a repo-scoped contract is
  // the one way to make the static tier skip everything it selected.
  const pnpm = join(REPO, "node_modules", ".pnpm");
  const eveDir = existsSync(pnpm)
    ? readdirSync(pnpm)
        .filter((d) => d.startsWith("eve@"))
        .map((d) => join(pnpm, d, "node_modules", "eve"))
        .find((d) => existsSync(join(d, "package.json")))
    : undefined;
  if (!eveDir) {
    t.skip("no installed eve to point EVESTACK_CONTRACT_EVE_DIR at (run pnpm install)");
    return;
  }
  const { code, out } = run(STATIC, ["--only=version/installed-satisfies"], { EVESTACK_CONTRACT_EVE_DIR: eveDir });
  assert.equal(code, 0, `the legitimate skip path must stay exit 0\n${out}`);
  assert.match(out, /SKIP/);
  assert.doesNotMatch(out, /all green/);
  assert.match(out, /NOTHING RAN/);
});

/* -------------------------------------------------------------------------- */
/* --format=json must survive being read by another process                    */
/* -------------------------------------------------------------------------- */

test("static: --format=json is not truncated when stdout is a pipe", () => {
  // On POSIX, Node's stdout is asynchronous when it is a pipe and synchronous
  // when it is a file or a TTY. `process.stdout.write(json); process.exit(0)`
  // therefore discards whatever is still buffered — which is everything past
  // the 64 KiB pipe buffer. The report is ~100 KB, so a consumer reading it
  // through a pipe got 65258 bytes and a JSON.parse throw, while the same
  // command redirected to a file was perfect. eve-watch.yml:411-421 is exactly
  // that consumer (execFileSync + JSON.parse), and its `|| echo "(could not
  // list contract coverage)"` fallback meant the failure never surfaced.
  //
  // The suite's own verdict is deliberately NOT asserted here. This test asks
  // whether every byte of the report survived the pipe; whether the contracts
  // passed is a different question, and coupling the two makes an unrelated
  // red contract fail a test about buffering — which is precisely what happened
  // the first time this ran.
  const { out } = run(STATIC, ["--format=json"]);
  assert.ok(out.length > 65536, `report shrank below the pipe buffer (${out.length} bytes) — test lost its teeth`);
  JSON.parse(out); // throws, and fails the test, if a single byte was dropped
});

test("runtime: --format=json is not truncated when stdout is a pipe", () => {
  const { out } = run(RUNTIME, ["--format=json"]);
  const report = JSON.parse(out);
  assert.ok(Array.isArray(report.probes));
});

/* -------------------------------------------------------------------------- */
/* every command line CI actually runs must survive the new validation         */
/* -------------------------------------------------------------------------- */

// Transcribed from .github/workflows/ci.yml:216,342,343,358 and
// .github/workflows/eve-watch.yml:234,235. If a workflow's invocation changes,
// this list has to change with it — that is the point of writing them down.
const CI_INVOCATIONS = [
  ["--require=postgres,typescript", "--exclude=seam"], // ci.yml:216
  ["--require=agent", "--only=protocol"], // ci.yml:342
  ["--require=agent", "--only=channels"], // ci.yml:343
  ["--require=dashboard,agent,postgres", "--only=seam"], // ci.yml:358
  ["--format=json"], // eve-watch.yml:234
  ["--require=postgres,typescript"], // eve-watch.yml:235
];

for (const args of CI_INVOCATIONS) {
  test(`CI invocation survives argument validation: ${args.join(" ")}`, () => {
    const { code, out, err } = run(RUNTIME, args);
    // Not "equals 0": these steps are entitled to exit 1 here, because this
    // machine has no Postgres and no booted agent and --require is supposed to
    // turn that into a failure. Exit 2 would mean the validation above rejected
    // a line CI depends on, which is the regression this test exists to catch.
    assert.notEqual(code, 2, `argument validation rejected a real CI invocation\nstdout:\n${out}\nstderr:\n${err}`);
  });
}

/* -------------------------------------------------------------------------- */
/* the pure helpers                                                            */
/* -------------------------------------------------------------------------- */

const FAKE = [
  { id: "seam/one", needs: ["dashboard", "agent"] },
  { id: "seam/two", needs: ["dashboard", "postgres"] },
  { id: "memory/one", needs: ["postgres"] },
];

test("groupsOf / capabilitiesOf summarise the suite for the error message", () => {
  assert.deepEqual(groupsOf(FAKE), ["memory", "seam"]);
  assert.deepEqual(capabilitiesOf(FAKE), ["agent", "dashboard", "postgres"]);
});

test("emptySelectionError blames the flag that emptied the selection", () => {
  const byOnly = emptySelectionError({ all: FAKE, matched: [], selected: [], only: "seem", exclude: null });
  assert.match(byOnly, /--only=seem matched none of the 3/);

  const byExclude = emptySelectionError({ all: FAKE, matched: FAKE, selected: [], only: null, exclude: "/" });
  assert.match(byExclude, /--exclude=\/ removed all 3/);

  const fine = emptySelectionError({ all: FAKE, matched: FAKE, selected: FAKE, only: null, exclude: null });
  assert.equal(fine, null);

  const empty = emptySelectionError({ all: [], matched: [], selected: [], only: null, exclude: null });
  assert.match(empty, /No probe files/);
});

test("requirementErrors separates a typo from a requirement nothing selected can use", () => {
  const typo = requirementErrors({ required: ["postgress"], all: FAKE, selected: FAKE, only: null, exclude: null });
  assert.equal(typo.length, 1);
  assert.match(typo[0], /names a capability no probe declares/);

  const inert = requirementErrors({
    required: ["agent"],
    all: FAKE,
    selected: [FAKE[2]],
    only: "memory",
    exclude: null,
  });
  assert.equal(inert.length, 1);
  assert.match(inert[0], /has no effect on this selection/);

  const good = requirementErrors({ required: ["postgres"], all: FAKE, selected: FAKE, only: null, exclude: null });
  assert.deepEqual(good, []);
});
