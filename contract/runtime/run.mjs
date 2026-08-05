#!/usr/bin/env node
/**
 * The runtime tier: checks that require the stack to actually be running.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `contract/run.mjs` reads eve's compiled package and asserts that things we
 * wrote down are still there. That is cheap, offline, and runs against every
 * published release — and it is structurally blind to an entire class of bug,
 * because a static assertion cannot observe behaviour.
 *
 * Look at what has actually gone wrong in this project. Denying a tool approval
 * killed the durable session. The trace tier read an attribute that is never
 * exported, so it had never worked at all. OpenSandbox silently dropped every
 * newline and made a *new* sandbox on reattach while reporting success. An
 * IVFFlat index on an empty table returned zero rows for a query that plainly
 * matched. `attach` corrupted the file it edited and printed "Done."
 *
 * Every one of those was found by running something and looking at the result.
 * None of them is findable by inspecting a package. They share a shape, and it
 * is the shape this file exists to catch: **the system reports success and is
 * wrong**. A 200 with the wrong body. A migration that "succeeded" onto an index
 * that cannot answer. A rewrite that "worked" and produced a file that does not
 * parse.
 *
 * ── What belongs here ────────────────────────────────────────────────────────
 *
 * Probes that need Postgres, a booted agent, or a real filesystem — and that are
 * DETERMINISTIC. No model calls: nothing here may depend on what a language
 * model chose to say, because a check that is right three times in four gets
 * muted, and a muted check is worse than an absent one. Model-dependent
 * verification is `eve eval`, gated on a key, run separately.
 *
 * Usage:
 *   node contract/runtime/run.mjs                 all probes
 *   node contract/runtime/run.mjs --only=memory   probes whose id matches
 *   node contract/runtime/run.mjs --format=json   machine-readable
 *   node contract/runtime/run.mjs --list          names only, run nothing
 *
 * Requires WORKFLOW_POSTGRES_URL. Probes that need more than Postgres say so
 * and SKIP rather than fail when their prerequisite is absent — but see the
 * note on --require below: skipping is a local convenience and must never be
 * how CI passes.
 *
 *   --require=postgres,agent   fail instead of skipping when these are missing
 *
 * Exit codes: 0 all probes passed · 1 a probe failed · 2 could not start.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const format = (args.find((a) => a.startsWith("--format="))?.slice(9) ?? "human").toLowerCase();
const only = args.find((a) => a.startsWith("--only="))?.slice(7) ?? null;
const listOnly = args.includes("--list");
const required = new Set(
  (args.find((a) => a.startsWith("--require="))?.slice(10) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/* -------------------------------------------------------------------------- */
/* recorder                                                                    */
/* -------------------------------------------------------------------------- */

function createRecorder() {
  const checks = [];
  return {
    checks,
    /** Assert, and keep going — a probe reports everything it observed. */
    ok(passed, detail, extra = {}) {
      checks.push({ detail, passed: Boolean(passed), ...extra });
    },
    /** Record an observation with no verdict. Shows in --verbose output and in
     *  JSON, so a failing run carries the context that explains it. */
    note(detail) {
      checks.push({ detail, passed: true, note: true });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* load                                                                        */
/* -------------------------------------------------------------------------- */

async function loadProbes() {
  const dir = join(HERE, "probes");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".probe.mjs"))
    .sort();
  const probes = [];
  for (const file of files) {
    const module = await import(pathToFileURL(join(dir, file)).href);
    for (const probe of Array.isArray(module.default) ? module.default : [module.default]) {
      probes.push({ ...probe, file: `contract/runtime/probes/${file}` });
    }
  }
  return probes;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const all = await loadProbes();
  const selected = only === null ? all : all.filter((p) => p.id.includes(only));

  if (listOnly) {
    for (const p of selected) process.stdout.write(`${p.id.padEnd(40)} needs: ${p.needs.join(", ")}\n`);
    process.exit(0);
  }

  const results = [];
  for (const probe of selected) {
    // A probe declares what it needs; the probe itself decides whether that is
    // available. `--require` turns "not available" from a skip into a failure,
    // which is how CI runs: a runtime tier that silently skips every probe
    // because Postgres never came up would report a green run having checked
    // nothing at all, and that is the exact failure mode this whole file is
    // about.
    let missing = [];
    try {
      missing = (await probe.available()) ?? [];
    } catch (error) {
      missing = [`could not determine availability: ${error.message}`];
    }

    if (missing.length > 0) {
      const isRequired = probe.needs.some((n) => required.has(n));
      results.push({
        id: probe.id,
        title: probe.title,
        why: probe.why,
        file: probe.file,
        needs: probe.needs,
        status: isRequired ? "fail" : "skip",
        checks: isRequired ? missing.map((m) => ({ detail: m, passed: false })) : [],
        skipReason: missing.join("; "),
      });
      continue;
    }

    const recorder = createRecorder();
    let crash = null;
    const started = Date.now();
    try {
      await probe.run(recorder);
    } catch (error) {
      crash = error instanceof Error ? (error.stack ?? error.message) : String(error);
      recorder.checks.push({
        detail: "the probe itself threw — this is a failure, not an excuse",
        passed: false,
        actual: error instanceof Error ? error.message : String(error),
      });
    }

    const failed = recorder.checks.filter((c) => !c.passed);
    results.push({
      id: probe.id,
      title: probe.title,
      why: probe.why,
      file: probe.file,
      needs: probe.needs,
      status: failed.length === 0 ? "pass" : "fail",
      durationMs: Date.now() - started,
      checks: recorder.checks,
      crash,
    });
  }

  const report = {
    ok: results.every((r) => r.status !== "fail"),
    counts: {
      probes: results.length,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      checks: results.reduce((n, r) => n + r.checks.filter((c) => !c.note).length, 0),
      failedChecks: results.reduce((n, r) => n + r.checks.filter((c) => !c.passed).length, 0),
    },
    probes: results,
  };

  if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(render(report));

  process.exit(report.ok ? 0 : 1);
}

function render(report) {
  const out = ["", "evestack runtime probes", ""];
  for (const p of report.probes) {
    const mark = p.status === "pass" ? "PASS" : p.status === "skip" ? "SKIP" : "FAIL";
    const tally =
      p.status === "skip"
        ? p.skipReason
        : `${p.checks.filter((c) => !c.note).length} checks${p.durationMs ? ` · ${p.durationMs}ms` : ""}`;
    out.push(`  ${mark}  ${p.id.padEnd(38)} ${tally}`);
    if (p.status !== "fail") continue;
    out.push(`        ${p.why}`);
    for (const c of p.checks) {
      if (c.passed && !c.note) continue;
      out.push(`        ${c.note ? "·" : "✗"} ${c.detail}`);
      if (c.expected !== undefined) out.push(`            expected  ${c.expected}`);
      if (c.actual !== undefined) out.push(`            actual    ${c.actual}`);
    }
    out.push("");
  }
  const { probes, failed, skipped, checks } = report.counts;
  const skipNote = skipped > 0 ? `, ${skipped} skipped` : "";
  out.push(
    report.ok
      ? `  ${probes - skipped} probes, ${checks} checks — all green${skipNote}`
      : `  ${failed} of ${probes} probes failed${skipNote}`,
  );
  if (skipped > 0 && report.ok) {
    out.push("  A skipped probe checked nothing. In CI, pass --require to turn skips into failures.");
  }
  out.push("");
  return `${out.join("\n")}\n`;
}

main().catch((error) => {
  process.stderr.write(`runtime probes could not start: ${error.stack ?? error.message}\n`);
  process.exit(2);
});
