#!/usr/bin/env node
/**
 * Regenerates the contract table in docs/compatibility.mdx from a real run.
 *
 * The page's whole value is that a reader can trust the version it names. A
 * hand-maintained table cannot carry that: eve published seven releases in nine
 * hours on 2026-08-04, and a table someone edits after the fact is stale before
 * the next morning's `eve-watch` run. So the table is a function of
 * `contract/run.mjs --format=json`, spliced between markers, and CI proves the
 * committed page is that function's current output.
 *
 * Usage:
 *   node scripts/gen-compatibility.mjs            rewrite the generated region
 *   node scripts/gen-compatibility.mjs --check    exit 1 if the region is stale
 *
 * `--format=json` rather than `--format=markdown`: the markdown renderer builds
 * a pull-request body — it opens with its own `###` heading and expands failures
 * into `<details>` blocks, neither of which belongs inside a docs page whose
 * heading structure is authored by hand. JSON is the runner's documented
 * machine-readable format, so this script owns the presentation and the runner
 * stays free to change how a PR reads.
 *
 * The output is a pure function of the report: no clock, no locale, no network.
 * A timestamp in here would make every run a diff and make --check meaningless.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(REPO_ROOT, "docs", "compatibility.mdx");
const RUNNER = join(REPO_ROOT, "contract", "run.mjs");

const START = "{/* GENERATED:contracts start */}";
const END = "{/* GENERATED:contracts end */}";

const checkOnly = process.argv.slice(2).includes("--check");

function die(message) {
  process.stderr.write(`gen-compatibility: ${message}\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* the run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A red suite fails this script rather than publishing a red table. The page
 * states which eve evestack is verified against; there is no such thing as a
 * verified-against version whose contracts do not hold, and a page that renders
 * ❌ next to `auth/local-dev-must-not-trust-the-request` while the site still
 * tells people to install that version is worse than no page. Fix the contract
 * or move the pin, then regenerate.
 */
function runContracts() {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [RUNNER, "--format=json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // eve's report carries every assertion; the default 1 MB buffer is not
      // enough headroom for a suite that keeps growing.
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (error) {
    // run.mjs exits 1 on a broken contract and 2 when it cannot even find eve.
    // Both are refusals to generate, but they need different advice.
    if (error.status === 2) die("the contract runner could not load eve — run `pnpm install` first.");
    if (error.status === 1) {
      die(
        "the contract suite is red, so there is no verified version to publish.\n" +
          "  Run `node contract/run.mjs` and read docs/upgrading.mdx before regenerating.",
      );
    }
    die(`could not run ${RUNNER}: ${error.message}`);
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    die("the contract runner did not emit JSON. Did --format=json change?");
  }
  if (!report.ok) die("the contract runner reported ok:false with exit 0 — refusing to publish it.");
  if (!Array.isArray(report.contracts) || report.contracts.length === 0) die("the report contains no contracts.");
  return report;
}

/* -------------------------------------------------------------------------- */
/* rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * MDX 3 parses `{` and `<` in prose as JSX. A contract author writing an
 * `assumption` is writing for a terminal, so nothing stops them from putting a
 * bare brace in one — and the first place it would surface is a failed site
 * build with a parser error pointing at generated MDX nobody wrote by hand.
 * Catch it here, where the message can say what to do.
 */
function assertMdxSafe(text, contractId) {
  const outsideCode = text.replace(/`[^`]*`/g, "");
  const hazard = [...outsideCode].find((ch) => ch === "{" || ch === "<");
  if (hazard !== undefined) {
    die(
      `the assumption on \`${contractId}\` contains a bare \`${hazard}\` outside a code span, ` +
        "which MDX parses as JSX and which would fail the site build.\n" +
        "  Wrap that part of the assumption in backticks in contract/contracts/.",
    );
  }
}

function cell(text) {
  // Same escape the runner's own markdown format applies: an unescaped pipe
  // silently splits the row into extra columns.
  return String(text).replace(/\|/g, "\\|");
}

function renderRegion(report) {
  const { contracts, assertions } = report.counts;
  const out = [];

  out.push("{/* Generated by scripts/gen-compatibility.mjs. Do not edit inside these markers. */}");
  out.push("");
  // Wrapped by hand rather than by a wrapper: it is one sentence whose only
  // variables are three short numbers, and a real wrapper would reflow the
  // whole line on a version bump, turning a two-digit change into a five-line
  // diff nobody can skim.
  out.push(`All ${contracts} contracts hold against eve \`${report.eve.version}\` — ${assertions} assertions,`);
  out.push("no network, no model call, no database.");
  out.push("");
  out.push("| | Contract | Assertions | What it pins |");
  out.push("| --- | --- | --- | --- |");
  for (const contract of report.contracts) {
    assertMdxSafe(contract.assumption, contract.id);
    const failures = contract.assertions.filter((a) => !a.passed).length;
    const tally = failures === 0 ? `${contract.assertions.length}` : `${failures}/${contract.assertions.length} failed`;
    out.push(
      `| ${contract.status === "pass" ? "✅" : "❌"} | \`${cell(contract.id)}\` | ${tally} | ` +
        `${cell(contract.assumption)} |`,
    );
  }
  out.push("");
  out.push("Regenerate with:");
  out.push("");
  out.push("```bash");
  out.push("node scripts/gen-compatibility.mjs");
  out.push("```");

  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* splice                                                                      */
/* -------------------------------------------------------------------------- */

function splice(source, region) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);

  if (start === -1) die(`docs/compatibility.mdx is missing the start marker:\n  ${START}`);
  if (end === -1) die(`docs/compatibility.mdx is missing the end marker:\n  ${END}`);
  if (end < start) die("the end marker appears before the start marker in docs/compatibility.mdx.");
  // Two start markers would make the splice silently pick the first region and
  // leave a second stale one behind, which --check would then never notice.
  if (source.indexOf(START) !== source.lastIndexOf(START)) die(`docs/compatibility.mdx contains more than one ${START}`);
  if (source.indexOf(END) !== source.lastIndexOf(END)) die(`docs/compatibility.mdx contains more than one ${END}`);

  return `${source.slice(0, start + START.length)}\n\n${region}\n\n${source.slice(end)}`;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

let source;
try {
  source = readFileSync(PAGE, "utf8");
} catch {
  die(`cannot read ${PAGE}. This script rewrites a region of an existing page; it does not create one.`);
}

const report = runContracts();
const next = splice(source, renderRegion(report));

if (next === source) {
  process.stdout.write(`docs/compatibility.mdx is up to date (eve ${report.eve.version}).\n`);
  process.exit(0);
}

if (checkOnly) {
  process.stderr.write(
    "gen-compatibility: docs/compatibility.mdx is out of date against the contract suite " +
      `(eve ${report.eve.version}, ${report.counts.contracts} contracts, ${report.counts.assertions} assertions).\n` +
      "  Run `node scripts/gen-compatibility.mjs` and commit the result.\n",
  );
  process.exit(1);
}

writeFileSync(PAGE, next);
process.stdout.write(
  `docs/compatibility.mdx updated: eve ${report.eve.version}, ` +
    `${report.counts.contracts} contracts, ${report.counts.assertions} assertions.\n`,
);
