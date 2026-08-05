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
 *
 *   EVESTACK_CONTRACT_EVE_DIR=path/to/eve node contract/run.mjs
 *       run the same contracts against a different eve install
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------------------- */
/* argv                                                                        */
/* -------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const format = (args.find((a) => a.startsWith("--format="))?.slice(9) ?? "human").toLowerCase();
const only = args.find((a) => a.startsWith("--only="))?.slice(7) ?? null;
const verbose = args.includes("--verbose");

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

  const results = [];
  for (const contract of selected) {
    // A repo-scoped contract asserts something about this checkout, not about
    // eve. Certifying an arbitrary release (record.mjs, via
    // EVESTACK_CONTRACT_EVE_DIR) would fail it for a tautology — eve 0.30.2
    // cannot satisfy a `^0.30.6` pin — and stamp a red cell on the public
    // matrix for a version that is in fact fine. Skipped, not passed: a silent
    // pass would be a claim we did not check.
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

  if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === "markdown") process.stdout.write(renderMarkdown(report));
  else process.stdout.write(renderHuman(report, verbose));

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
  out.push(
    report.ok
      ? `  ${ran} contracts, ${assertions} assertions — all green against eve ${report.eve.version}${skipNote}`
      : `  ${failedContracts} of ${ran} contracts broken (${failedAssertions} of ${assertions} assertions) against eve ${report.eve.version}${skipNote}`,
  );
  if (!report.ok) out.push("  See docs/upgrading.mdx for what to do next.");
  out.push("");
  return `${out.join("\n")}\n`;
}

function renderMarkdown(report) {
  const out = [];
  out.push(`### Contract suite vs eve \`${report.eve.version}\``);
  out.push("");
  const ranCount = report.counts.contracts - (report.counts.skippedContracts ?? 0);
  out.push(
    report.ok
      ? `All ${ranCount} contracts hold (${report.counts.assertions} assertions).`
      : `**${report.counts.failedContracts} of ${ranCount} contracts broken** ` +
          `(${report.counts.failedAssertions} of ${report.counts.assertions} assertions).`,
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
