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
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(REPO_ROOT, "docs", "compatibility.mdx");
const RUNNER = join(REPO_ROOT, "contract", "run.mjs");

const START = "{/* GENERATED:contracts start */}";
const END = "{/* GENERATED:contracts end */}";

/**
 * The second region: the "combination evestack ships" table. Every cell in it
 * is a literal copy of a range in templates/default/package.json, so leaving it
 * hand-written meant an eve bump had to be remembered in a third place — the
 * manifests, the contract table, and this. It was already stale by one release
 * when this was added: the page said `^0.30.6` under a suite reporting 0.30.8.
 */
const PINS_START = "{/* GENERATED:pins start */}";
const PINS_END = "{/* GENERATED:pins end */}";

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
    // run.mjs exits 1 on a broken contract, 2 when it cannot even find eve, and
    // 3 when the suite shrank below contract/floor.json. All three are refusals
    // to generate, and they need different advice.
    if (error.status === 2) die("the contract runner could not load eve — run `pnpm install` first.");
    if (error.status === 1) {
      die(
        "the contract suite is red, so there is no verified version to publish.\n" +
          "  Run `node contract/run.mjs` and read docs/upgrading.mdx before regenerating.",
      );
    }
    if (error.status === 3) {
      // Publishing here is the specific harm the floor exists to prevent: the
      // page would render a smaller, entirely green table and read as though
      // nothing had changed. The stderr from the runner already names which
      // contracts shrank and by how much.
      die(
        "the suite shrank below contract/floor.json, so publishing it would understate coverage.\n" +
          "  Run `node contract/run.mjs` for the details. If the loss is intentional,\n" +
          "  lower the floor deliberately with `node contract/run.mjs --write-floor`.",
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

/**
 * The contract that asks "does the installed eve satisfy the ranges evestack's
 * own manifests declare *today*". It is a fact about our package.json files, not
 * about eve's API, so /compat excludes it from its headline and reports "14 API
 * contracts, 213 assertions" where this page reported "15 contracts, 225
 * assertions" for the same run. Both were right and neither said so, which left
 * two numbers for one suite on two pages a reader clicks between.
 *
 * Same id and same reasoning as contract/render-compat.mjs — kept in sync by
 * being spelled out in both places rather than by a shared import, because the
 * renderer is deliberately standalone. Tolerated if absent: a rename degrades to
 * "the whole suite describes eve", which is a true sentence.
 */
const PIN_CONTRACT_ID = "version/installed-satisfies-every-declared-range";

/**
 * Every recorded report that skipped at least one contract, newest first. Read
 * from contract/history/*.json — the same files /compat renders — so this page
 * cannot claim a skip pattern the matrix does not show. A checkout without a
 * history directory degrades to saying nothing about skips.
 */
function historySkips() {
  const dir = join(REPO_ROOT, "contract", "history");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("eve-") && f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((r) => (r.counts?.skippedContracts ?? 0) > 0)
    .map((r) => ({
      version: r.eveVersion,
      skipped: r.counts.skippedContracts,
      assertions: r.counts.assertions,
    }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

function renderRegion(report) {
  const { contracts, assertions, skippedContracts = 0 } = report.counts;
  const out = [];

  // Derived, never typed. /compat's denominator is this one minus the
  // repo-scoped pin contract; computing it here is what stops the two pages
  // drifting into two unexplained numbers again.
  const pin = report.contracts.find((c) => c.id === PIN_CONTRACT_ID);
  const apiContracts = contracts - (pin ? 1 : 0);
  const apiAssertions = assertions - (pin ? pin.assertions.length : 0);

  out.push("{/* Generated by scripts/gen-compatibility.mjs. Do not edit inside these markers. */}");
  out.push("");
  // Wrapped by hand rather than by a wrapper: it is one sentence whose only
  // variables are three short numbers, and a real wrapper would reflow the
  // whole line on a version bump, turning a two-digit change into a five-line
  // diff nobody can skim.
  out.push(`All ${contracts} contracts hold against eve \`${report.eve.version}\` — ${assertions} assertions,`);
  out.push("no network, no model call, no database.");
  out.push("");
  if (pin) {
    out.push(
      `**[/compat](/compat) counts ${apiContracts} and ${apiAssertions} for this same run**, and that is not a ` +
        "second suite.",
    );
    out.push(
      `The matrix excludes \`${PIN_CONTRACT_ID}\` (${pin.assertions.length} assertions) because it asks whether the ` +
        "eve under test",
    );
    out.push(
      "satisfies the ranges *this repo declares today* — a fact about our manifests, not about eve's API, and one",
    );
    out.push(
      `no older release can satisfy. ${contracts} is the whole suite; ${apiContracts} is the part that describes eve.`,
    );
    out.push("");
  }
  // Skips are the third outcome and were invisible on this page: a skipped
  // contract is neither a pass nor a failure, and a reader counting green ticks
  // has no way to know one did not run. Both the current run and the recorded
  // history are read for them, so the sentence cannot go stale.
  out.push(
    skippedContracts === 0
      ? "No contract was **skipped** on this run — every one of them executed."
      : `${skippedContracts} contract${skippedContracts === 1 ? " was" : "s were"} **skipped** on this run: neither a pass nor a failure, and neither counted above.`,
  );
  const skipped = historySkips();
  if (skipped.length > 0) {
    const newest = skipped[0];
    const oldest = skipped[skipped.length - 1];
    const span = newest.version === oldest.version ? `\`${newest.version}\`` : `\`${oldest.version}\`–\`${newest.version}\``;
    const counts = [...new Set(skipped.map((s) => s.assertions))].sort((a, b) => a - b).join("/");
    out.push(
      `Back-certifying an older release does skip it — ${skipped.length} recorded report${skipped.length === 1 ? "" : "s"} ` +
        `(${span}) each carry a skip, and run ${counts} assertions instead of ${assertions}.`,
    );
    out.push("Those are the ⊘ cells on [/compat](/compat).");
  }
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

/**
 * The declared-versions table, read straight out of templates/default's
 * manifest. `peerRange` is looked up on a publishable package rather than
 * hardcoded, so widening it in one place cannot leave the page claiming the
 * old one.
 */
function renderPins() {
  const template = JSON.parse(readFileSync(join(REPO_ROOT, "templates", "default", "package.json"), "utf8"));
  const deps = { ...template.dependencies, ...template.devDependencies };

  // Discovered, not listed. The hardcoded trio here said `@evestack/budget`,
  // `@evestack/composio`, `@evestack/sandbox-opensandbox` while the contract
  // report found nine ranges across five manifests — `@evestack/schedules` had
  // been added and this table never learned about it. Scanning packages/ means
  // the next one cannot go missing either.
  const peers = [];
  for (const entry of readdirSync(join(REPO_ROOT, "packages")).sort()) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(REPO_ROOT, "packages", entry, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const range = manifest.peerDependencies?.eve;
    if (range !== undefined) peers.push({ name: manifest.name, range });
  }

  const evePin = deps.eve;
  const ranges = [...new Set(peers.map((p) => p.range))];
  const peerRange = ranges[0];
  if (evePin === undefined) die("templates/default/package.json does not declare eve.");
  if (peerRange === undefined) die("no package under packages/ declares an eve peer range.");
  // Two different peer ranges cannot honestly share one row, and silently
  // printing the first would be the same class of bug this function just fixed.
  if (ranges.length > 1) {
    die(
      `packages/ declares more than one eve peer range (${ranges.join(", ")}).\n` +
        "  Reconcile them, or teach renderPins to emit a row per range.",
    );
  }

  // The resolved beta is a fact about the lockfile, not the manifest, so it is
  // read from the installed tree — the manifest only ever says `beta`, and
  // which beta that is happens to be the single most load-bearing detail on
  // this page.
  //
  // Read by path rather than through createRequire: @workflow/world-postgres
  // declares an `exports` map that does not include `./package.json`, so
  // `require.resolve("@workflow/world-postgres/package.json")` throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED and the version silently vanished from the
  // table. The importer's node_modules is where pnpm links it.
  let worldResolved = null;
  try {
    worldResolved = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "templates", "default", "node_modules", "@workflow", "world-postgres", "package.json"),
        "utf8",
      ),
    ).version;
  } catch {
    // Not installed (a docs-only checkout). Say the range and stop, rather than
    // printing a resolved version nobody verified.
  }

  const out = [];
  out.push("{/* Generated by scripts/gen-compatibility.mjs. Do not edit inside these markers. */}");
  out.push("");
  out.push("| Package | Declared as | Where |");
  out.push("| --- | --- | --- |");
  out.push(`| \`eve\` | \`${evePin}\` | \`templates/default/package.json\` |`);
  out.push(
    `| \`eve\` (peer range) | \`${peerRange}\` | ${peers.map((p) => `\`${p.name}\``).join(", ")} |`,
  );
  out.push(
    `| \`@workflow/world-postgres\` | \`${deps["@workflow/world-postgres"]}\`` +
      `${worldResolved ? ` → resolves to \`${worldResolved}\`` : ""} | \`templates/default/package.json\` |`,
  );
  out.push(
    `| \`ai\` | \`${deps.ai}\`, plus an \`overrides\` entry pinning the whole tree to it | ` +
      "`templates/default/package.json` |",
  );
  out.push(`| Node | \`${template.engines?.node ?? ">=24"}\` | \`engines\` in every manifest |`);
  out.push("");
  out.push(
    `\`${evePin}\` is a caret on a \`0.x\` version, so it admits the next patch and refuses \`0.31.0\`. That is`,
  );
  out.push("the intended reading: eve is pre-1.0, and pre-1.0 a breaking change lands in a **minor**");
  out.push("version. Widening that range by hand is how you ship an untested framework to everyone who ran");
  out.push("`npx create-evestack`.");

  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* splice                                                                      */
/* -------------------------------------------------------------------------- */

function splice(source, region, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);

  if (start === -1) die(`docs/compatibility.mdx is missing the start marker:\n  ${startMarker}`);
  if (end === -1) die(`docs/compatibility.mdx is missing the end marker:\n  ${endMarker}`);
  if (end < start) die(`${endMarker} appears before ${startMarker} in docs/compatibility.mdx.`);
  // Two start markers would make the splice silently pick the first region and
  // leave a second stale one behind, which --check would then never notice.
  if (source.indexOf(startMarker) !== source.lastIndexOf(startMarker)) {
    die(`docs/compatibility.mdx contains more than one ${startMarker}`);
  }
  if (source.indexOf(endMarker) !== source.lastIndexOf(endMarker)) {
    die(`docs/compatibility.mdx contains more than one ${endMarker}`);
  }

  return `${source.slice(0, start + startMarker.length)}\n\n${region}\n\n${source.slice(end)}`;
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
const next = splice(
  splice(source, renderPins(), PINS_START, PINS_END),
  renderRegion(report),
  START,
  END,
);

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
