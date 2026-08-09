/**
 * eve's timestamps are naive. A bare `now()` beside one is a silent time shift.
 *
 * ── The bug this is for ──────────────────────────────────────────────────────
 *
 * `workflow.workflow_runs.created_at`, `.started_at`, `.completed_at` and
 * `.updated_at` are `timestamp without time zone` holding UTC — world-postgres's
 * schema, checked against a running database rather than assumed. `now()` is a
 * `timestamptz`. Put them in one comparison and Postgres converts the naive side
 * using the SERVER's TimeZone, so the stored value is read as a local wall clock
 * that happens to look like UTC.
 *
 * Measured, under TimeZone='America/New_York', against a turn that started
 * twenty minutes ago:
 *
 *     started_at < now() - interval '15 minutes'                   -> false
 *     started_at < (now() AT TIME ZONE 'utc') - interval '15 min'  -> true
 *
 * and under UTC both answer true, which is the whole reason it survived. The
 * "Wedged turns" monitor could not fire at all for anyone west of Greenwich, and
 * the 24-hour Monitors window silently included the wrong rows. lib/fleet.ts had
 * already paid for this once — "the CLI port of this file hit it for real: a
 * session quiet for three hours looked five hours in the future and the sweep
 * returned nothing" — and the lesson reached that one file.
 *
 * ── Why CI could not catch it, despite trying ────────────────────────────────
 *
 * ci.yml sets TZ=America/New_York on two jobs, explicitly so that "a runner that
 * is always UTC" cannot hide this class of bug. That works for JavaScript and
 * does nothing here: TZ is the Node process's zone, while the conversion above
 * happens inside Postgres, whose session TimeZone comes from the server. The
 * service container runs UTC, so every SQL comparison in CI is evaluated in the
 * one timezone where the bug is invisible.
 *
 * A runtime probe could set the session zone and catch it for real, and that is
 * worth having. This is the cheaper half and it runs offline on every commit:
 * the property is textual, so it can be read straight off the source.
 *
 * ── What is deliberately allowed ─────────────────────────────────────────────
 *
 * `extract(epoch from ...)` is not a comparison. Postgres reads a naive value as
 * UTC for that, so `extract(epoch from created_at)` and
 * `extract(epoch from now())` are already on one scale — verified against the
 * running server, both returning 1786253460 for the same instant under a
 * non-UTC session. lib/monitors.ts's width_bucket bounds depend on that, and
 * "fixing" them would subtract the offset from one side only and shift every
 * bucket boundary. So epoch extraction is exempt, by name, rather than by
 * accident.
 *
 * Scope is `repo`: it describes this checkout, not eve.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";

/**
 * Where SQL against the workflow schema is written. The CLI is included: it
 * carries its own copy of the fleet sweep, and it is the file that hit this bug
 * first.
 */
const SOURCES = [
  ...readdirSync(join(REPO_ROOT, "packages", "dashboard", "lib"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `packages/dashboard/lib/${f}`),
  "packages/evestack-cli/src/sessions.mjs",
];

/** The table whose timestamps are naive. */
const NAIVE_TABLE = /workflow(?:Schema\})?\.workflow_runs/;

/**
 * A `now()` that is already safe:
 *   - `(now() AT TIME ZONE 'utc')`  — the conversion this contract is about
 *   - `extract(epoch from now()`    — not a comparison; see the header
 */
const SAFE = [
  /now\s*\(\s*\)\s*AT\s+TIME\s+ZONE\s+'utc'/i,
  /extract\s*\(\s*epoch\s+from\s+now\s*\(\s*\)/i,
];

/**
 * Pull out template literals and ordinary strings that look like SQL against the
 * naive table. Crude on purpose: a parser here would be a second implementation
 * of JavaScript, and the question is only "does this blob of SQL mention
 * workflow_runs".
 */
function sqlBlocks(source) {
  const blocks = [];
  for (const match of source.matchAll(/`([^`]*)`/g)) {
    if (!NAIVE_TABLE.test(match[1])) continue;
    // SQL comments stripped FIRST, and the first version of this contract did
    // not — so it failed on lib/fleet.ts, whose `-- comparing one to a bare
    // now() makes Postgres read it in the server's zone` is the comment
    // explaining this exact defect, in the one file that never had it. Contract
    // 20 strips for the same reason: in this repository the prose quotes the
    // SQL, so a scanner that reads comments is reading the documentation.
    blocks.push(match[1].replace(/^[ \t]*--.*$/gm, " "));
  }
  return blocks;
}

/** Every `now()` in a blob, with a little context on each side. */
function nowSites(sql) {
  const sites = [];
  for (const match of sql.matchAll(/now\s*\(\s*\)/gi)) {
    const from = Math.max(0, match.index - 40);
    sites.push({
      index: match.index,
      context: sql.slice(from, match.index + 60).replace(/\s+/g, " ").trim(),
    });
  }
  return sites;
}

export default {
  id: "time/naive-timestamps-are-never-compared-to-a-bare-now",
  title: "every now() in a workflow_runs query is converted to UTC or is an epoch extraction",
  scope: "repo",
  assumption:
    "workflow.workflow_runs timestamps are `timestamp without time zone` holding UTC. Comparing " +
    "one to a bare now() makes Postgres read it in the server's zone, which shifts it by the " +
    "offset and in the wrong direction: a turn that started twenty minutes ago reads as starting " +
    "in the future. Measured at four hours under America/New_York, and identical under UTC, " +
    "which is why CI — whose Postgres service runs UTC — could not see it.",
  evestackUse:
    "The 'Wedged turns' monitor could not fire at all outside UTC: `started_at < now() - " +
    "interval '15 minutes'` was false for every genuinely wedged turn. lib/monitors.ts's 24-hour " +
    "window and its buckets counted the wrong rows for the same reason. lib/fleet.ts already " +
    "carried the conversion, so the repository knew — in one file out of four.",

  async check(_eve, t) {
    let queriesSeen = 0;
    let sitesSeen = 0;

    for (const rel of SOURCES) {
      let source;
      try {
        source = readFileSync(join(REPO_ROOT, rel), "utf8");
      } catch {
        continue; // a file that moved is contract 16's problem
      }

      for (const sql of sqlBlocks(source)) {
        queriesSeen += 1;
        for (const site of nowSites(sql)) {
          sitesSeen += 1;
          const safe = SAFE.some((pattern) => pattern.test(site.context));
          t.ok(safe, `${rel}: now() is converted or extracted — …${site.context}…`, {
            ...(safe
              ? {}
              : {
                  expected: "(now() AT TIME ZONE 'utc'), or extract(epoch from now())",
                  actual:
                    "a bare now() compared against a naive UTC column. Postgres will read the " +
                    "stored value in the server's zone and the window silently shifts by the " +
                    "offset — four hours in America/New_York, in the direction that makes past " +
                    "events look future",
                }),
          });
        }
      }
    }

    // ANTI-VACUITY, twice. This contract is a loop over things it found, so a
    // regex that stopped matching — a renamed table, a query moved out of a
    // template literal — reports zero violations by having nothing to inspect,
    // which is indistinguishable from success.
    t.ok(queriesSeen >= 5, `found ${queriesSeen} queries against workflow_runs to inspect`, {
      expected: ">= 5 — lib/{alerts,monitors,fleet,queries}.ts and the CLI all query it",
      actual: `${queriesSeen}; the scan is not finding the SQL and every check above is vacuous`,
    });
    t.ok(sitesSeen >= 5, `found ${sitesSeen} now() call sites inside them`, {
      expected: ">= 5",
      actual: `${sitesSeen}; the queries were found but now() was not, so nothing was checked`,
    });
  },
};
