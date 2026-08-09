#!/usr/bin/env node
/**
 * The evestack ⇄ eve contract runner.
 *
 * Why this exists rather than `node --test`: the upgrade workflow has to put
 * "which contracts passed, which failed, and what breaks because of it" into a
 * pull-request body. A test reporter emits pass/fail lines; it does not emit
 * blast radius. Here every contract declares the assumption it pins and what
 * evestack does with that assumption, and the runner renders both — as text
 * for a human, as JSON for a script, as Markdown for a PR.
 *
 * Usage:
 *   node contract/run.mjs                     human-readable, exit 1 on failure
 *   node contract/run.mjs --format=json       machine-readable summary
 *   node contract/run.mjs --format=markdown   PR-body-ready report
 *   node contract/run.mjs --only=auth         run contracts whose id matches
 *   node contract/run.mjs --verbose           show passing assertions too
 *   node contract/run.mjs --write-floor       re-record contract/floor.json
 *
 *   EVESTACK_CONTRACT_EVE_DIR=path/to/eve node contract/run.mjs
 *       run the same contracts against a different eve install
 *
 * Exit codes: 0 green · 1 a contract failed · 2 the runner could not start, or
 * --only matched no contract · 3 the suite shrank below contract/floor.json
 * (see contract/lib/floor.mjs).
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FLOOR_EXIT_CODE, checkFloor, readFloor, writeFloor } from "./lib/floor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------------------- */
/* argv                                                                        */
/* -------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const format = (args.find((a) => a.startsWith("--format="))?.slice(9) ?? "human").toLowerCase();
const only = args.find((a) => a.startsWith("--only="))?.slice(7) ?? null;
const verbose = args.includes("--verbose");
const writeFloorFlag = args.includes("--write-floor");

if (!["human", "json", "markdown"].includes(format)) {
  process.stderr.write(`Unknown --format=${format}. Use human, json or markdown.\n`);
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* assertion recorder                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Handed to each contract's `check`. Assertions record rather than throw so one
 * contract reports every violation it finds in a single run — when eve renames
 * a family of things, seeing all six failures at once is the difference between
 * one upgrade and six.
 */
function createRecorder() {
  const assertions = [];
  return {
    assertions,
    ok(condition, detail, extra = {}) {
      const passed = Boolean(condition);
      // expected/actual is failure diagnostics; carrying it on a pass just
      // makes --verbose noisier without telling anyone anything.
      assertions.push({ detail, passed, ...(passed ? {} : extra) });
      return passed;
    },
    equal(actual, expected, detail) {
      const passed = Object.is(actual, expected);
      // Rendered eagerly so a missing value reads as the string "undefined"
      // rather than vanishing from the report — "expected local-dev" with no
      // actual beside it looks like a rendering bug, not a finding.
      assertions.push({ detail, passed, ...(passed ? {} : { expected: describe(expected), actual: describe(actual) }) });
      return passed;
    },
    /** `haystack` may be an array, a Set or a string. */
    contains(haystack, needle, detail) {
      const passed =
        haystack instanceof Set
          ? haystack.has(needle)
          : Array.isArray(haystack)
            ? haystack.includes(needle)
            : String(haystack).includes(needle);
      assertions.push({
        detail,
        passed,
        ...(passed ? {} : { expected: `contains ${JSON.stringify(needle)}`, actual: describe(haystack) }),
      });
      return passed;
    },
  };
}

function describe(value) {
  if (value instanceof Set) return `Set(${[...value].map((v) => JSON.stringify(v)).join(", ")})`;
  if (Array.isArray(value)) return value.length > 12 ? `[${value.length} entries]` : JSON.stringify(value);
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

/* -------------------------------------------------------------------------- */
/* run                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Write, and do not return until the bytes have left this process.
 *
 * On POSIX, Node's stdout is synchronous when it is a file or a TTY and
 * ASYNCHRONOUS when it is a pipe. `process.stdout.write(json)` immediately
 * followed by `process.exit(0)` therefore throws away everything still buffered
 * — which is everything past the 64 KiB pipe buffer, silently, with a zero exit
 * code.
 *
 * That is not hypothetical here. `--format=json` is 100343 bytes. Redirected to
 * a file it was complete; read through a pipe it arrived as 65258 bytes and
 * JSON.parse threw:
 *
 *   $ node contract/run.mjs --format=json > /tmp/c.json ; wc -c /tmp/c.json
 *   100343
 *   $ node contract/run.mjs --format=json | wc -c
 *   65536
 *
 * The consumer is .github/workflows/eve-watch.yml:411-421, which builds the
 * coverage list for the upgrade advisor with execFileSync + JSON.parse — a
 * pipe. It has been failing into its own `|| echo "(could not list contract
 * coverage)"` fallback, so the advisor has been reasoning about every eve
 * release with no idea what the suite covers, and nothing said so.
 */
function writeFlushed(stream, text) {
  return new Promise((resolve) => {
    // The error listener is not defensive padding. Waiting for the flush means
    // this process is still alive when a reader that took what it needed closes
    // the pipe — `node contract/run.mjs --format=json | head` — and the write
    // then fails with EPIPE. An 'error' event with no listener is rethrown, so
    // fixing the truncation without this line swapped a silently short report
    // for a stack trace. The old fire-and-forget code never saw it only because
    // it had already called process.exit.
    //
    // Resolving on either outcome is the correct behaviour, not a shortcut: a
    // consumer hanging up early is that consumer's decision, and there is no
    // one left to report it to.
    stream.once("error", resolve);
    stream.write(text, resolve);
  });
}

async function loadContracts() {
  const dir = join(HERE, "contracts");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".contract.mjs"))
    .sort();

  const contracts = [];
  for (const file of files) {
    const module = await import(pathToFileURL(join(dir, file)).href);
    const exported = module.default;
    for (const contract of Array.isArray(exported) ? exported : [exported]) {
      contracts.push({ ...contract, file: `contract/contracts/${file}` });
    }
  }
  return contracts;
}

async function main() {
  let eve;
  try {
    ({ eve } = await import("./lib/eve.mjs"));
  } catch (error) {
    process.stderr.write(`Cannot run contracts: ${error.message}\n`);
    process.exit(2);
  }

  const all = await loadContracts();
  const selected = only === null ? all : all.filter((c) => c.id.includes(only));

  // `--only=auth` when nothing is called auth used to print "0 contracts, 0
  // assertions — all green against eve 0.30.8" and exit 0. That sentence is the
  // most dangerous output this file can produce: it is what a fully passing run
  // looks like, so a mistyped filter in a CI step or in docs/upgrading.mdx's
  // copy-paste instructions silently turns the whole suite into a no-op that
  // certifies a release. Exit 2 ("could not start") rather than 1, because
  // nothing was wrong with eve — the command was wrong.
  if (selected.length === 0) {
    const groups = [...new Set(all.map((c) => c.id.split("/")[0]))].sort();
    process.stderr.write(
      `--only=${only} matched none of the ${all.length} contracts.\n` +
        "A filter that selects nothing is a usage error, not a pass.\n" +
        `Contract groups that exist: ${groups.join(", ")}\n`,
    );
    process.exit(2);
  }

  const results = [];
  for (const contract of selected) {
    // A repo-scoped contract asserts something about this checkout, not about
    // eve. Interrogating an arbitrary release via EVESTACK_CONTRACT_EVE_DIR
    // would fail it for a tautology — eve 0.30.2 cannot satisfy a `^0.30.6`
    // pin — and report a red result for a version that is in fact fine.
    // Skipped, not passed: a silent pass would be a claim we did not check.
    if (contract.scope === "repo" && eve.isOverride) {
      results.push({
        id: contract.id,
        title: contract.title,
        assumption: contract.assumption,
        evestackUse: contract.evestackUse,
        file: contract.file,
        status: "skip",
        skipReason: `repo-scoped: describes this checkout's install, not eve ${eve.version}`,
        assertions: [],
        crash: null,
      });
      continue;
    }

    const recorder = createRecorder();
    let crash = null;
    try {
      await contract.check(eve, recorder);
    } catch (error) {
      crash = error instanceof Error ? (error.stack ?? error.message) : String(error);
      recorder.assertions.push({
        detail: `the contract check itself threw — eve probably moved something this contract reads`,
        passed: false,
        actual: error instanceof Error ? error.message : String(error),
      });
    }

    const failed = recorder.assertions.filter((a) => !a.passed);
    results.push({
      id: contract.id,
      title: contract.title,
      assumption: contract.assumption,
      evestackUse: contract.evestackUse,
      file: contract.file,
      status: failed.length === 0 ? "pass" : "fail",
      assertions: recorder.assertions,
      crash,
    });
  }

  const report = {
    // `!== "fail"` rather than `=== "pass"`: a skipped contract must not turn
    // the run red, or every certification run would fail on the one contract it
    // deliberately did not run.
    ok: results.every((r) => r.status !== "fail"),
    eve: { version: eve.version, pin: eve.pin, path: eve.root },
    counts: {
      contracts: results.length,
      failedContracts: results.filter((r) => r.status === "fail").length,
      skippedContracts: results.filter((r) => r.status === "skip").length,
      assertions: results.reduce((n, r) => n + r.assertions.length, 0),
      failedAssertions: results.reduce((n, r) => n + r.assertions.filter((a) => !a.passed).length, 0),
    },
    contracts: results,
  };

  // Re-recording the floor is an authoring action, not a verdict: it must not
  // happen on an incomplete run, or `--only=auth --write-floor` would silently
  // erase every other contract's minimum.
  if (writeFloorFlag) {
    if (only !== null) {
      process.stderr.write("--write-floor cannot be combined with --only: it would erase the other floors.\n");
      process.exit(2);
    }
    const written = writeFloor(report);
    const total = Object.values(written.contracts).reduce((n, v) => n + v, 0);
    process.stdout.write(
      `contract/floor.json written: ${Object.keys(written.contracts).length} contracts, ${total} assertions.\n`,
    );
    process.exit(0);
  }

  // The floor describes the WHOLE suite, so it can only be judged against a
  // whole run. Under `--only` every unselected contract looks deleted, which
  // turns a routine `--only=auth` into an alarm about erosion that did not
  // happen — and an alarm that fires when nothing is wrong is how a real one
  // gets ignored.
  const violations = only === null ? checkFloor(report, readFloor()) : [];

  // Awaited, not fire-and-forget: see writeFlushed. Every branch below ends in
  // process.exit, and an unflushed pipe write does not survive it.
  if (format === "json")
    await writeFlushed(process.stdout, `${JSON.stringify({ ...report, floorViolations: violations }, null, 2)}\n`);
  else if (format === "markdown") await writeFlushed(process.stdout, renderMarkdown(report));
  else await writeFlushed(process.stdout, renderHuman(report, verbose));

  // Reported after the table, and before the exit, because it is a statement
  // about the table itself rather than about eve: everything above may be green
  // and still be describing less than it used to.
  if (violations.length > 0) {
    const lines = [
      "",
      "  THE SUITE SHRANK. Everything above may be green and still cover less than it did:",
      ...violations.map((v) => `    · ${v}`),
      "",
      "  These assertions are generated from evestack's own source, so this usually means",
      "  an import, a query column or a route was removed and took its coverage with it.",
      "  If the loss is intentional, lower the floor deliberately:",
      "",
      "    node contract/run.mjs --write-floor",
      "",
    ];
    await writeFlushed(process.stderr, `${lines.join("\n")}\n`);
    process.exit(FLOOR_EXIT_CODE);
  }

  process.exit(report.ok ? 0 : 1);
}

/* -------------------------------------------------------------------------- */
/* renderers                                                                   */
/* -------------------------------------------------------------------------- */

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

function renderHuman(report, showPasses) {
  const out = [];
  out.push("");
  out.push("evestack ⇄ eve contract suite");
  out.push(`  eve   ${report.eve.version}   (templates/default pins ${report.eve.pin})`);
  out.push(`  from  ${report.eve.path}`);
  out.push("");

  for (const contract of report.contracts) {
    const failures = contract.assertions.filter((a) => !a.passed);
    const mark = contract.status === "pass" ? "PASS" : contract.status === "skip" ? "SKIP" : "FAIL";
    const tally =
      contract.status === "skip"
        ? contract.skipReason
        : contract.status === "pass"
          ? `${contract.assertions.length} assertions`
          : `${failures.length} of ${contract.assertions.length} assertions failed`;
    out.push(`  ${mark}  ${contract.id.padEnd(42)} ${tally}`);

    if (contract.status !== "fail" && !showPasses) continue;

    out.push(wrap(`assumption: ${contract.assumption}`, 92, "        "));
    for (const assertion of contract.assertions) {
      if (assertion.passed && !showPasses) continue;
      out.push(`        ${assertion.passed ? "✓" : "✗"} ${assertion.detail}`);
      if (assertion.expected !== undefined) out.push(`            expected  ${assertion.expected}`);
      if (assertion.actual !== undefined) out.push(`            actual    ${assertion.actual}`);
    }
    if (failures.length > 0) {
      out.push("        what this breaks in evestack:");
      out.push(wrap(contract.evestackUse, 88, "          "));
    }
    out.push("");
  }

  const { contracts, failedContracts, skippedContracts, assertions, failedAssertions } = report.counts;
  const ran = contracts - (skippedContracts ?? 0);
  const skipNote = skippedContracts > 0 ? `, ${skippedContracts} skipped` : "";
  if (!report.ok) {
    out.push(
      `  ${failedContracts} of ${ran} contracts broken (${failedAssertions} of ${assertions} assertions) against eve ${report.eve.version}${skipNote}`,
    );
  } else if (ran === 0) {
    // `EVESTACK_CONTRACT_EVE_DIR=… --only=version` selects one repo-scoped
    // contract, which then skips by design (see the scope check in main) — and
    // the old line printed "0 contracts, 0 assertions — all green against eve
    // 0.29.5". A certification run that skipped everything it selected must not
    // be describable as green; the exit code stays 0 because the skip itself is
    // correct, but the sentence has to say what happened.
    out.push(`  NOTHING RAN. All ${skippedContracts} selected contracts skipped, 0 executed.`);
    out.push(`  This is not a green result against eve ${report.eve.version}: no assertion was evaluated.`);
  } else {
    out.push(`  ${ran} contracts, ${assertions} assertions — all green against eve ${report.eve.version}${skipNote}`);
  }
  if (!report.ok) out.push("  See docs/upgrading.mdx for what to do next.");
  out.push("");
  return `${out.join("\n")}\n`;
}

function renderMarkdown(report) {
  const out = [];
  out.push(`### Contract suite vs eve \`${report.eve.version}\``);
  out.push("");
  const ranCount = report.counts.contracts - (report.counts.skippedContracts ?? 0);
  // This block is pasted into the eve-upgrade pull-request body by
  // eve-watch.yml:214, which is the highest-stakes place any of these sentences
  // ends up: "All 0 contracts hold (0 assertions)." next to a version bump
  // reads as a green certification of a release nothing was run against.
  out.push(
    !report.ok
      ? `**${report.counts.failedContracts} of ${ranCount} contracts broken** ` +
          `(${report.counts.failedAssertions} of ${report.counts.assertions} assertions).`
      : ranCount === 0
        ? `**Nothing ran.** All ${report.counts.skippedContracts} selected contracts skipped — ` +
          "no assertion was evaluated, so this is not a green result."
        : `All ${ranCount} contracts hold (${report.counts.assertions} assertions).`,
  );
  out.push("");
  out.push("| | contract | assertions | pins |");
  out.push("|---|---|---|---|");
  for (const c of report.contracts) {
    const failures = c.assertions.filter((a) => !a.passed).length;
    const mark = c.status === "pass" ? "✅" : c.status === "skip" ? "⊘" : "❌";
    const tally =
      c.status === "skip"
        ? "skipped"
        : failures === 0
          ? `${c.assertions.length} ok`
          : `${failures}/${c.assertions.length} failed`;
    out.push(`| ${mark} | \`${c.id}\` | ${tally} | ${c.assumption.replace(/\|/g, "\\|")} |`);
  }
  out.push("");

  const broken = report.contracts.filter((c) => c.status === "fail");
  if (broken.length > 0) {
    out.push("#### Broken contracts");
    out.push("");
    for (const c of broken) {
      out.push(`<details open><summary><code>${c.id}</code> — ${c.title}</summary>`);
      out.push("");
      out.push(`**eve no longer holds:** ${c.assumption}`);
      out.push("");
      for (const a of c.assertions.filter((x) => !x.passed)) {
        out.push(`- ❌ ${a.detail}`);
        if (a.expected !== undefined) out.push(`  - expected: \`${String(a.expected).replace(/`/g, "'")}\``);
        if (a.actual !== undefined) out.push(`  - actual: \`${String(a.actual).replace(/`/g, "'")}\``);
      }
      out.push("");
      out.push(`**What this breaks in evestack:** ${c.evestackUse}`);
      out.push("");
      out.push(`Defined in \`${c.file}\`.`);
      out.push("");
      out.push("</details>");
      out.push("");
    }
    out.push("Read `docs/upgrading.mdx` before touching any of this.");
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

await main();
