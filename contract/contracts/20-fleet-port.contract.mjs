/**
 * The CLI's fleet sweep and the dashboard's must ask the same question.
 *
 * ── The bug this is for ──────────────────────────────────────────────────────
 *
 * `packages/evestack-cli/src/sessions.mjs` opens by saying it is
 *
 *     "a port of packages/dashboard/lib/fleet.ts — same candidate query, same
 *      thresholds, same decision order"
 *
 * and closes with "if the classification changes in one place it must change in
 * both". It was not the same candidate query. fleet.ts's HAVING has a second
 * term the port never got:
 *
 *     AND COUNT(t.id) FILTER (
 *           WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
 *             AND t.completed_at IS NULL
 *         ) > 0
 *
 * — at least one turn genuinely unfinished. fleet.ts's own comment says what
 * dropping it costs: "Nothing downstream re-checks the question … That is the
 * 166-of-174 false positive."
 *
 * In the CLI it produced the same thing with a worse label. A finished session
 * keeps `status = 'running'`, so it stayed a candidate; eve answers its pruned
 * stream with 200 and `x-eve-stream-tail-index: -1`; `foldSnapshot([])` returns
 * `{waiting: false, terminal: false, pendingRequests: []}`; and
 * `classifySession` reads "not waiting and not terminal" as a turn in flight.
 * Past STUCK_TURN_MS `evestack doctor` prints `wedged` — "a turn started and
 * never finished — nothing in eve will resume it" — about a conversation that
 * ended normally. Measured, not inferred: foldSnapshot([]) with a three-hour
 * idle classifies wedged.
 *
 * ── Why the unit tests could not have caught it ──────────────────────────────
 *
 * test/diagnosis.test.mjs covers classifySession thoroughly, including the case
 * named "a session waiting with nothing outstanding is idle, not wedged". Those
 * tests pass, and they passed while this was broken, because the classifier was
 * never wrong. The candidate query decides WHO REACHES the classifier, it needs
 * a database to run, and nothing tested it. The tests covered the function that
 * was right and not the query that was wrong.
 *
 * ── Why a contract and not an import ─────────────────────────────────────────
 *
 * The duplication is forced and documented: the dashboard is containerised from
 * a build context where a `workspace:*` dependency fails the image build, and
 * the CLI publishes standalone. So the two SQL strings cannot be one string, and
 * the only thing that can hold them together is a check that reads both files
 * and compares them. That is this. It is the same shape of risk the pricing
 * table carries in packages/evestack-budget/README.md.
 *
 * Scope is `repo`: it describes this checkout, not eve.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";

const FLEET = "packages/dashboard/lib/fleet.ts";
const CLI = "packages/evestack-cli/src/sessions.mjs";

/**
 * Comments are stripped before anything is matched.
 *
 * Both files explain these invariants at length in prose that quotes the SQL —
 * this file does it too — so a naive `includes()` would find every term in the
 * commentary and pass on a file whose actual query had been gutted. Stripping
 * first is what makes the check about the code.
 */
function code(rel) {
  const source = readFileSync(join(REPO_ROOT, rel), "utf8");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments, including the headers
    .replace(/^[ \t]*--.*$/gm, " ") // SQL line comments inside the template literals
    .replace(/^[ \t]*\/\/.*$/gm, " "); // JS line comments
}

/**
 * The properties both sweeps must share, each one a defect that has already
 * shipped somewhere in this repository.
 */
const INVARIANTS = [
  {
    name: "an unfinished-turn filter, so a finished session is never a candidate",
    // Whitespace- and case-insensitive: fleet.ts writes SQL in upper case and
    // the CLI in lower, and a formatter must not be able to break this.
    pattern:
      /count\s*\(\s*t\.id\s*\)\s*filter\s*\(\s*where\s+t\.attributes->>'\$eve\.type'\s+in\s*\(\s*'turn'\s*,\s*'subagent'\s*\)\s+and\s+t\.completed_at\s+is\s+null\s*\)\s*>\s*0/is,
    why:
      "without it a session whose turns have all closed is probed, its pruned stream folds to " +
      "silence, and silence is indistinguishable from a turn in flight — 166 of 174 in the " +
      "dashboard, and `wedged` in the CLI",
  },
  {
    name: "a UTC-safe now(), because eve's timestamps are naive",
    pattern: /\(\s*now\s*\(\s*\)\s+at\s+time\s+zone\s+'utc'\s*\)/is,
    why:
      "workflow_runs timestamps are `timestamp without time zone` holding UTC; a bare now() is " +
      "read in the server's zone and shifts the idle window by the offset. The CLI hit this one " +
      "for real: a session quiet for three hours looked five hours in the future",
  },
  {
    name: "completed_at is the test for finished, never status",
    pattern: /t\.completed_at\s+is\s+null/is,
    why:
      "a cancelled turn, a failed turn and a turn that never reached the provider have all " +
      "FINISHED; counting them as work in flight re-reports failures as wedges",
  },
  {
    name: "candidates are running sessions, not runs of every kind",
    pattern: /'\$eve\.type'\s*=\s*'session'/is,
    why:
      "eve writes an untagged companion run per session that never completes; one counted as a " +
      "candidate would report the whole fleet as broken",
  },
];

export default {
  id: "fleet/the-cli-port-asks-the-dashboard-s-question",
  title: "the CLI's fleet sweep carries every term the dashboard's does",
  scope: "repo",
  assumption:
    "packages/evestack-cli/src/sessions.mjs says it is a port of lib/fleet.ts with the 'same " +
    "candidate query', and the duplication is forced — the dashboard's image build cannot carry " +
    "a workspace dependency and the CLI publishes standalone. Two copies of one query that " +
    "nothing compares is a copy that will drift, and it did: the port shipped without the " +
    "unfinished-turn filter, which is the single line fleet.ts credits with removing 166 of 174 " +
    "false positives.",
  evestackUse:
    "`evestack doctor` reported healthy, finished conversations as CRITICAL wedged — 'a turn " +
    "started and never finished' — which is the one error that teaches an operator to stop " +
    "reading the output. The unit tests could not see it: they cover classifySession, which was " +
    "never wrong, while the untested candidate query decided who reached it.",

  async check(_eve, t) {
    const files = { [FLEET]: code(FLEET), [CLI]: code(CLI) };

    // ANTI-VACUITY. Every assertion below is a regex against a string, and an
    // empty string fails them all in a way that reads like a real defect —
    // while a comment-stripper that ate too much would produce exactly that.
    // These two floors say the files were read and still contain a query.
    for (const [rel, source] of Object.entries(files)) {
      t.ok(source.length > 2000, `${rel} was read and still has a body after comments are stripped`, {
        expected: "> 2000 characters of code",
        actual: `${source.length} — the file moved, or the comment stripper is eating code`,
      });
      t.ok(
        /workflow_runs/i.test(source) && /having/i.test(source),
        `${rel} still contains a grouped candidate query over workflow_runs`,
        {
          expected: "a HAVING clause against workflow_runs",
          actual: "none found — the sweep was rewritten and this contract is now checking nothing",
        },
      );
    }

    for (const invariant of INVARIANTS) {
      for (const [rel, source] of Object.entries(files)) {
        t.ok(invariant.pattern.test(source), `${rel} has ${invariant.name}`, {
          expected: String(invariant.pattern),
          actual: `not found in the code. ${invariant.why}`,
        });
      }
    }

    // The thresholds, which are plain numbers in both files and just as easy to
    // let drift. Read out of the source rather than imported: lib/fleet.ts is
    // TypeScript the contract tier does not compile.
    const threshold = (rel, name) => {
      const match = files[rel].match(new RegExp(`${name}\\s*(?::\\s*number)?\\s*=\\s*([^;\\n]+)`));
      if (!match) return null;
      try {
        // Arithmetic only — these are written as `30 * 60 * 1000`.
        return /^[\d\s*+_]+$/.test(match[1]) ? Number(eval(match[1])) : null;
      } catch {
        return null;
      }
    };

    for (const name of ["IDLE_BEFORE_SUSPECT_MS", "STUCK_TURN_MS"]) {
      const cli = threshold(CLI, name);
      const dashboard = threshold(FLEET, name);
      t.ok(
        cli !== null && dashboard !== null && cli === dashboard,
        `${name} is the same in both sweeps`,
        {
          expected: `equal, and both readable — the header promises "same thresholds"`,
          actual: `${CLI}=${cli}, ${FLEET}=${dashboard}`,
        },
      );
    }
  },
};
