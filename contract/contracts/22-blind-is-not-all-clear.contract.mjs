/**
 * A signal that could not look must never read as all-clear.
 *
 * ── The finding this is for ──────────────────────────────────────────────────
 *
 * One design habit, found four separate times by four people looking at four
 * unrelated subsystems, each fixed on its own:
 *
 *   1. GET /api/fleet answered {"wedged":0,"unknown":0,"checked":0} whether the
 *      stack was healthy or the agent was dead. The same bytes for "I examined
 *      the fleet and it is well" and "I examined nothing".
 *   2. The turn failure rate scored a running or wedged turn as 0 — a SUCCESS —
 *      while keeping it in the denominator, so a crashed agent IMPROVED the
 *      number on the page you open to find out whether the agent has crashed.
 *   3. GET /api/health answered healthy for two hours against a database it
 *      could not read.
 *   4. The trace-ingest monitor reported spans arriving on an install whose
 *      ingest endpoint was refusing every batch with a 503.
 *
 * Four independent discoveries of one habit is not four bugs, and patching four
 * sites does not stop the fifth. The audit that wrote this contract found the
 * fifth immediately: the fleet BANNER, the component instance 1 was fixed FOR,
 * caught a failed sweep and returned null — byte-for-byte what it renders when
 * nothing is wrong.
 *
 * ── What this contract is, and what it is not ────────────────────────────────
 *
 * The behavioural half lives in
 * packages/dashboard/test/blind-is-not-all-clear.test.mjs, where a stub pool can
 * turn the database off and drive the real alert engine, the real fleet sweep
 * and the real /api/health handler. That is where the four originals are caught
 * by MEANING rather than by shape, and this contract asserts that file is still
 * there and still asserts over populations rather than over a list.
 *
 * What is here is everything that half cannot reach: the CLI, which has its own
 * verdict surfaces and its own exit codes; and the chains that cross a package
 * boundary, where each link is defensible alone and the property only exists
 * end to end.
 *
 * Scope is `repo`: it describes this checkout, not eve.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";

const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

/** A function body, from its opening brace to a closing brace in column one. */
function body(source, signature) {
  const at = source.indexOf(signature);
  if (at === -1) return null;
  const end = source.indexOf("\n}", at);
  return end === -1 ? source.slice(at) : source.slice(at, end);
}

/**
 * The dashboard's behavioural half. Named here so it cannot be deleted quietly:
 * contract/floor.json protects this suite from shrinking and nothing protects
 * that file, so this contract is what notices.
 */
const BEHAVIOURAL = "packages/dashboard/test/blind-is-not-all-clear.test.mjs";

/**
 * Assertions in that file which must stay written over a POPULATION.
 *
 * Each fragment is the part that makes the assertion grow by itself. Rewriting
 * the alert sweep as a list of nine alert ids would still pass today and would
 * stop covering alert number ten, which is the whole failure this contract
 * exists to prevent: a guard that has to be remembered is a guard that will not
 * be.
 */
const POPULATION_ASSERTIONS = [
  ['a.state === "ok"', "every alert produced, not a list of alert ids"],
  ["declaredHealths()", "every SessionHealth read out of lib/fleet.ts, not restated"],
  ["UNFINISHED_OUTCOMES", "every unfinished outcome, read from the metric catalog"],
];

export default {
  id: "health/a-signal-that-could-not-look-never-reads-as-all-clear",
  title: "verdict surfaces keep an unknown, and the checks that could not run are counted",
  scope: "repo",
  assumption:
    "Nothing about eve. This is a property of evestack's own reporting surfaces: every one of " +
    "them can be asked a question it cannot answer, and the cheapest thing to write in that " +
    "case is the value that means everything is fine.",
  evestackUse:
    "Four separate reports of the same defect: /api/fleet reporting 0 wedged from a sweep that " +
    "examined nothing, a failure rate that fell as turns wedged, /api/health answering healthy " +
    "for two hours against an unreadable database, and a trace-ingest monitor reporting spans " +
    "arriving into an endpoint that was refusing every batch. Each was found by a different " +
    "person in a different subsystem, which is what makes it a habit rather than a bug.",

  async check(_eve, t) {
    /* ── the behavioural half is still there, and still general ──────────── */

    let guard = null;
    try {
      guard = read(BEHAVIOURAL);
    } catch {
      // fall through: the assertion below is the report
    }
    t.ok(guard !== null, `${BEHAVIOURAL} exists`, {
      expected: "the behavioural half of this guard",
      actual: "missing. The four originals are only caught by running the real modules.",
    });

    if (guard !== null) {
      const glob = read("packages/dashboard/package.json");
      t.contains(glob, "test/*.test.mjs", "the dashboard test script still globs test/*.test.mjs");
      for (const [fragment, why] of POPULATION_ASSERTIONS) {
        t.contains(guard, fragment, `the guard still asserts over ${why}`);
      }
    }

    /* ── the CLI: every part state is counted, not just the bad one ──────── */

    /*
     * `evestack status` has three part states and used to tally two. `down`
     * filtered on `fail`, so a `warn` — the state a probe returns when it
     * reached the thing and could not finish checking it — printed one yellow
     * dot and was then folded into the bold green "Everything is up.", into
     * `"ok": true`, and into exit 0.
     *
     * The vocabulary is read out of the glyph map rather than listed here, so a
     * fourth state is covered on the day it is added.
     */
    const status = read("packages/evestack-cli/src/status.mjs");
    const glyphs = /const GLYPH = \{([^}]*)\}/.exec(status);
    t.ok(glyphs !== null, "status.mjs still declares its part states in one place", {
      expected: "a GLYPH map naming every part state",
      actual: "not found; this contract can no longer enumerate them",
    });

    const partStates = glyphs === null ? [] : [...glyphs[1].matchAll(/(\w+):/g)].map((m) => m[1]);
    const verdict = body(status, "export async function status(");
    for (const state of partStates.filter((s) => s !== "ok")) {
      t.contains(
        verdict ?? "",
        `=== "${state}"`,
        `the status verdict counts parts in the '${state}' state rather than reading past them`,
      );
    }

    /* ── the CLI: the doctor's closing sentence knows what it did not see ── */

    /*
     * `evestack doctor` ends with "Nothing is currently costing you a run." and
     * that line filtered on CRITICAL alone. Every check that COULD NOT RUN is a
     * WARNING or an INFO, so a run in which nothing could be examined printed a
     * clean bill of health and exited 0. Raising them to CRITICAL would be the
     * wrong fix: they are not faults, and paging on them teaches people to
     * ignore CRITICAL. Naming the incompleteness on its own axis is the right
     * one.
     */
    const findings = read("packages/evestack-cli/src/findings.mjs");
    const render = read("packages/evestack-cli/src/render.mjs");

    t.contains(findings, "export function blindSpots", "findings.mjs names the could-not-run set");

    const marked = findings.split("\n").filter((line) => line.trim() === "true,").length;
    t.ok(marked >= 4, "every check that can fail to run is marked as one", {
      expected: "at least 4 findings constructed with the blind flag",
      actual: `${marked}. An unmarked one is invisible to the verdict.`,
    });

    const closing = body(render, "function verdict(");
    t.contains(
      closing ?? "",
      "blindSpots",
      "the doctor verdict narrows its claim to what this run could examine",
    );

    /* ── the chain that crosses packages: a refusal reaches the health check ─ */

    /*
     * sql/traces.sql and sql/facts.sql each open with a guard that raises
     * SQLSTATE EV001 and applies nothing when the installed schema is newer than
     * the one this build ships. Every link is defensible on its own and the
     * property only exists end to end: the SQL refuses, lib/facts.ts is the only
     * thing that can detect the refusal without attempting it, and /api/health
     * is the only thing anybody polls. Break any link and the container reports
     * healthy while its trace pages are empty and OTLP ingest answers 503 —
     * measured, for two hours.
     *
     * The guarded files are discovered rather than listed, so a third one is
     * covered the day it grows a guard.
     */
    const sqlDir = "packages/dashboard/sql";
    const guarded = readdirSync(join(REPO_ROOT, sqlDir))
      .filter((file) => file.endsWith(".sql"))
      .filter((file) => read(`${sqlDir}/${file}`).includes("EV001"));

    t.ok(guarded.length > 0, "at least one sql file refuses to downgrade a newer database", {
      expected: "an EV001 guard",
      actual: "none found; the rest of this block would assert nothing",
    });

    const facts = read("packages/dashboard/lib/facts.ts");
    for (const file of guarded) {
      const component = file.replace(/\.sql$/, "");
      t.contains(
        facts,
        component,
        `lib/facts.ts can detect that ${file}'s component is ahead of this build`,
      );
    }

    const health = read("packages/dashboard/app/api/health/route.ts");
    t.contains(health, "schemaVersionsAhead", "/api/health asks whether the database is ahead");
    t.contains(health, "degraded", "/api/health has a not-ok status for an unmigratable database");

    /*
     * And the catch is not a hole in the same wall. A liveness route that
     * answers ok from inside an error handler is the shortest possible spelling
     * of this whole defect.
     */
    const LIVENESS = ["app/api/health/route.ts", "app/api/health/detail/route.ts"];
    for (const rel of LIVENESS) {
      let source;
      try {
        source = read("packages/dashboard/" + rel);
      } catch {
        continue; // a route that moved is contract 16's problem
      }
      // The exported handler only. A module-level helper may legitimately
      // swallow and return a neutral value; what must never happen is the
      // RESPONSE being built inside an error path.
      const handler = source.slice(source.indexOf("export async function GET"));
      const afterCatch = handler.slice(handler.indexOf("} catch"));
      t.ok(!/ok:\s*true/.test(afterCatch), rel + " does not answer ok from inside a catch", {
        expected: "no ok: true after the first catch",
        actual: afterCatch.replace(/\s+/g, " ").slice(0, 160),
      });
    }
  },
};
