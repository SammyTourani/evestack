/**
 * A schedule run's recorded duration must equal the time it actually took.
 *
 * `finishRun()` in packages/evestack-schedules/src/store.ts wrote:
 *
 *   duration_ms = EXTRACT(MILLISECONDS FROM (now() - started_at))::int
 *               + EXTRACT(SECONDS      FROM (now() - started_at))::int * 1000
 *
 * Both of those read the **seconds field** of the interval rather than the
 * interval. `MILLISECONDS` is that field × 1000, and `SECONDS` wraps at 59. So
 * the sum double-counted everything under a minute and threw away whole minutes
 * above one. Nothing errored, nothing was null, and the dashboard's schedules
 * page rendered the wrong number as fact.
 *
 * This is a probe rather than a unit test because the claim is entirely about
 * PostgreSQL's `EXTRACT` semantics. Asserting it in JavaScript would only test a
 * restatement of the bug. It has to run against a real server, and CI already
 * provides one.
 *
 * The negative control matters as much as the assertion: it runs the OLD
 * expression against the same rows and requires it to be WRONG. A probe that
 * passes for both expressions is not measuring anything, and this file would be
 * easy to write that way — the two agree at exactly 1.000s, which is the
 * duration a lazily-chosen fixture would have used.
 *
 * Mirrors the `schedule_runs` columns in store.ts. Drift between them should be
 * read as this probe going stale, not as a discovery.
 */
import { randomUUID } from "node:crypto";

/** Production expression, verbatim from store.ts `finishRun()`. */
const CURRENT = "(EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int";

/** What shipped through @evestack/schedules 0.1.0. Kept only to be refuted. */
const PREVIOUS =
  "EXTRACT(MILLISECONDS FROM (now() - started_at))::int" +
  " + EXTRACT(SECONDS FROM (now() - started_at))::int * 1000";

/**
 * Durations chosen so the old form fails in both of its distinct ways:
 *   5.25s — under a minute, where MILLISECONDS + SECONDS roughly doubles
 *   95s   — 1m35s, where the seconds field is 35 and the minute is dropped
 *   125s  — 2m05s, where the seconds field is 5 and *both* minutes are dropped
 *
 * Seconds fields are integers on purpose. `EXTRACT(SECONDS)::int` on a x.5
 * value would depend on PostgreSQL's half-away-from-zero rounding, and a probe
 * should not rest on that. A 1.0s case is also excluded: the two expressions
 * agree there, which is exactly the fixture a careless version of this file
 * would have picked.
 */
const CASES = [
  { label: "5.25s", interval: "5.25 seconds", expectedMs: 5250 },
  { label: "95s", interval: "95 seconds", expectedMs: 95000 },
  { label: "125s", interval: "125 seconds", expectedMs: 125000 },
];

/**
 * now() advances between the INSERT and the UPDATE, so the measured value is
 * the fixture plus a real, tiny elapsed. 250ms is far below the smallest
 * disagreement being asserted (5000ms) and far above statement latency.
 */
const TOLERANCE_MS = 250;

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  return client;
}

export default {
  id: "schedules/duration-is-the-whole-interval",
  title: "a schedule run's duration_ms equals its real elapsed time",
  needs: ["postgres"],
  why:
    "duration_ms summed EXTRACT(MILLISECONDS) and EXTRACT(SECONDS), both of which read only the " +
    "seconds field of the interval. Runs under a minute recorded roughly double; runs over a " +
    "minute silently lost every whole minute. The dashboard rendered it as measured fact.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await connect();
      await client.end();
      return [];
    } catch (error) {
      return [`cannot reach Postgres: ${error.message}`];
    }
  },

  async run(t) {
    const client = await connect();
    const schema = `probe_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`
        CREATE TABLE ${schema}.schedule_runs (
          id          bigserial   PRIMARY KEY,
          name        text        NOT NULL,
          fire_at     timestamptz NOT NULL,
          started_at  timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz,
          duration_ms integer,
          status      text        NOT NULL DEFAULT 'running'
        )
      `);

      for (const testCase of CASES) {
        const inserted = await client.query(
          `INSERT INTO ${schema}.schedule_runs (name, fire_at, started_at)
           VALUES ($1, now(), now() - interval '${testCase.interval}')
           RETURNING id`,
          [`probe-${testCase.label}`],
        );
        const id = inserted.rows[0].id;

        const measured = await client.query(
          `UPDATE ${schema}.schedule_runs
              SET duration_ms = ${CURRENT}
            WHERE id = $1
        RETURNING duration_ms`,
          [id],
        );
        const actual = measured.rows[0].duration_ms;

        const correct = Math.abs(actual - testCase.expectedMs) <= TOLERANCE_MS;
        t.ok(
          correct,
          `${testCase.label}: duration_ms is the whole interval`,
          correct
            ? {}
            : { expected: `~${testCase.expectedMs}ms (±${TOLERANCE_MS})`, actual: `${actual}ms` },
        );

        // Negative control. The old expression must still be wrong on this same
        // row — otherwise the assertion above proves nothing about the change.
        //
        // The claim asserted is "the old form does not report the real elapsed
        // time", not "the old form reports exactly N". Predicting N means
        // hand-deriving PostgreSQL's field semantics into this file, and a
        // mistake there would fail CI for a reason that has nothing to do with
        // the code under test. The observed value is reported either way.
        const legacy = await client.query(
          `SELECT ${PREVIOUS} AS value FROM ${schema}.schedule_runs WHERE id = $1`,
          [id],
        );
        const before = legacy.rows[0].value;

        const stillWrong = Math.abs(before - testCase.expectedMs) > TOLERANCE_MS;
        t.ok(
          stillWrong,
          `${testCase.label}: the previous expression is reproducibly wrong`,
          stillWrong
            ? {}
            : {
                expected: `the old form to disagree with ${testCase.expectedMs}ms`,
                actual: `${before}ms — it agrees, so this case is measuring nothing`,
              },
        );
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await client.end();
    }
  },
};
