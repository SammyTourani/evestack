/**
 * The failing-streak the Schedules page renders, against a real PostgreSQL.
 *
 * `packages/dashboard/lib/schedules.ts` is 230 lines and nothing imported it:
 * not a unit test, not a contract, not a probe. Probe 04 covers
 * `packages/evestack-schedules/src/store.ts`, which is the WRITER — a different
 * file, a different query, and no help at all if the reader is wrong.
 *
 * `getSchedules()` is a four-CTE query whose middle stage is a LATERAL with a
 * window function in it, and it typechecks perfectly whatever it returns. The
 * streak is the part worth pinning:
 *
 *     COALESCE(MIN(depth) FILTER (WHERE status <> 'failed'), MAX(depth) + 1) - 1
 *
 * `depth` is 1-based counting back from the newest run, so the whole expression
 * is "how many failures in a row at the head of the list", with the COALESCE
 * covering the case where every run in range failed and there is no non-failed
 * row to find. Two off-by-ones live in that line, the `- 1` and the `+ 1`, and
 * an error in either produces a number that still looks like a plausible streak
 * — which is precisely the kind of wrong that ships.
 *
 * ── Why the fixtures are the shapes they are ─────────────────────────────────
 *
 * Each one is a boundary the expression can get wrong independently:
 *
 *   clean       newest run succeeded            -> 0   (MIN(depth) = 1, minus 1)
 *   recovering  ok on top of five failures      -> 0   (a streak is a PREFIX, not
 *                                                       a count of failures)
 *   failing3    three failures then an ok       -> 3   (MIN(depth) = 4, minus 1)
 *   allFailed   more failures than STREAK_DEPTH -> 200 (the COALESCE fallback,
 *                                                       capped at the window)
 *
 * `recovering` is the one a careless implementation gets wrong: it has MORE
 * failures than `failing3` and a shorter streak. A query that counted failures
 * instead of measuring the prefix would answer 5 and 3, both plausible.
 *
 * `allFailed` is the only fixture that reaches the `MAX(depth) + 1` arm, and it
 * needs STREAK_DEPTH + 1 rows to do it — generated in one INSERT rather than
 * looped, because 201 round trips to prove one COALESCE is not a trade anyone
 * would make twice.
 */
const NAME_PREFIX = "probe-streak-";
/** Must match STREAK_DEPTH in packages/dashboard/lib/schedules.ts. */
const STREAK_DEPTH = 200;

const FIXTURES = [
  { key: "clean", statuses: ["completed", "completed", "completed"], failing: 0 },
  { key: "recovering", statuses: ["completed", "failed", "failed", "failed", "failed", "failed"], failing: 0 },
  { key: "failing3", statuses: ["failed", "failed", "failed", "completed", "completed"], failing: 3 },
];

const name = (key) => `${NAME_PREFIX}${key}`;

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  // See probe 04: a pg.Client with no 'error' listener turns a dead socket into
  // an uncaughtException, which kills the runner and takes every other probe's
  // result with it rather than failing this one.
  client.on("error", () => {});
  return client;
}

export default {
  id: "schedules/the-failing-streak-is-a-prefix-not-a-count",
  title: "getSchedules' streak, totals and pause state against a real database",
  needs: ["postgres"],
  why:
    "lib/schedules.ts is imported by no test, contract or probe, and its streak is a LATERAL " +
    "window function with two off-by-ones in one line. A streak that counted failures instead " +
    "of measuring the run at the head of the list would report a schedule that has recovered as " +
    "still failing, on the page an operator uses to decide whether to intervene.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    return [];
  },

  async run(t) {
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const DASHBOARD = join(HERE, "..", "..", "..", "packages", "dashboard");

    const client = await connect();
    try {
      // The writer's own DDL, applied through the writer. Hand-rolling a CREATE
      // TABLE here would let this probe pass against a shape the product does
      // not ship — the same reason ci.yml runs world-postgres's bootstrap rather
      // than writing the workflow schema itself.
      await client.query("CREATE SCHEMA IF NOT EXISTS evestack");
      await client.query(`
        CREATE TABLE IF NOT EXISTS evestack.schedule_runs (
          id bigserial PRIMARY KEY, name text NOT NULL, cron text,
          fire_at timestamptz NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz, duration_ms integer,
          status text NOT NULL DEFAULT 'running', error text,
          caught_up boolean NOT NULL DEFAULT false, session_id text
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS evestack.schedule_state (
          name text PRIMARY KEY, paused boolean NOT NULL DEFAULT false,
          paused_at timestamptz, paused_by text,
          updated_at timestamptz NOT NULL DEFAULT now()
        )`);

      // Any leftovers from an interrupted run, before inserting.
      await client.query(`DELETE FROM evestack.schedule_runs WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);
      await client.query(`DELETE FROM evestack.schedule_state WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);

      // fire_at descends with the array index, so index 0 IS the newest run and
      // the fixture reads in the same order the page does.
      for (const fixture of FIXTURES) {
        for (const [i, status] of fixture.statuses.entries()) {
          await client.query(
            `INSERT INTO evestack.schedule_runs (name, cron, fire_at, status)
             VALUES ($1, '0 * * * *', now() - ($2 || ' hours')::interval, $3)`,
            [name(fixture.key), String(i + 1), status],
          );
        }
      }

      // STREAK_DEPTH + 1 failures in one statement.
      await client.query(
        `INSERT INTO evestack.schedule_runs (name, cron, fire_at, status)
         SELECT $1, '0 * * * *', now() - (g || ' hours')::interval, 'failed'
         FROM generate_series(1, $2) AS g`,
        [name("allFailed"), STREAK_DEPTH + 1],
      );

      const expected = new Map([
        ...FIXTURES.map((f) => [name(f.key), { failing: f.failing, total: f.statuses.length }]),
        [name("allFailed"), { failing: STREAK_DEPTH, total: STREAK_DEPTH + 1 }],
      ]);

      // The repo's one TypeScript-resolution shim, then the real module.
      await import(join(DASHBOARD, "test/register-ts-resolve.mjs"));
      const schedules = await import(join(DASHBOARD, "lib/schedules.ts"));

      const view = await schedules.getSchedules();

      t.ok(view.tableExists === true, "getSchedules found the schedule tables", {
        ...(view.tableExists ? {} : { expected: "tableExists true", actual: "false — the DDL above did not take" }),
      });

      const byName = new Map(view.schedules.map((s) => [s.name, s]));

      // ANTI-VACUITY. Every assertion below looks a fixture up by name, and a
      // missing one would skip silently — which is exactly how a query that
      // dropped schedules through an inner join would read as passing.
      const present = [...expected.keys()].filter((n) => byName.has(n));
      t.ok(
        present.length === expected.size,
        `all ${expected.size} fixture schedules came back from getSchedules`,
        present.length === expected.size
          ? {}
          : {
              expected: [...expected.keys()].join(", "),
              actual: `only ${present.join(", ") || "none"} — a schedule with runs must never drop off the page`,
            },
      );

      for (const [n, want] of expected) {
        const row = byName.get(n);
        if (!row) continue; // already failed above; do not double-report
        t.ok(
          Number(row.failingStreak) === want.failing,
          `${n}: the failing streak is ${want.failing}`,
          Number(row.failingStreak) === want.failing
            ? { actual: `${row.failingStreak}` }
            : {
                expected: `${want.failing}`,
                actual: `${row.failingStreak} — the streak is the run of failures at the HEAD of the list, not the number of failures in it`,
              },
        );
        t.ok(
          Number(row.totalRuns) === want.total,
          `${n}: the all-time total is ${want.total}`,
          Number(row.totalRuns) === want.total ? {} : { expected: `${want.total}`, actual: `${row.totalRuns}` },
        );
      }

      /* ── pausing round-trips ───────────────────────────────────────────── */
      // setPaused is the only write on the Schedules page, and POST
      // /api/schedules/[name] is called by nothing in the repo either.
      const target = name("clean");
      await schedules.setPaused(target, true, "probe");
      const paused = (await schedules.getSchedules()).schedules.find((s) => s.name === target);
      t.ok(
        paused?.paused === true && paused?.pausedBy === "probe",
        "setPaused(true) is visible to the next read, with the actor recorded",
        paused?.paused === true && paused?.pausedBy === "probe"
          ? {}
          : {
              expected: "paused true, pausedBy 'probe'",
              actual: `paused=${paused?.paused} pausedBy=${paused?.pausedBy}`,
            },
      );

      await schedules.setPaused(target, false, "probe");
      const resumed = (await schedules.getSchedules()).schedules.find((s) => s.name === target);
      t.ok(
        resumed?.paused === false,
        "setPaused(false) resumes it rather than leaving the row behind",
        resumed?.paused === false ? {} : { expected: "paused false", actual: `${resumed?.paused}` },
      );

      // A schedule with no state row must read as not paused, not as null or
      // undefined: the page renders a toggle from this and LEFT JOIN gives NULL
      // for every schedule nobody has ever paused, which is most of them.
      const untouched = byName.get(name("failing3"));
      t.ok(
        untouched?.paused === false,
        "a schedule that has never been paused reads as not paused, not null",
        untouched?.paused === false
          ? {}
          : { expected: "false", actual: `${untouched?.paused} — a LEFT JOIN NULL reaching the UI` },
      );
    } finally {
      await client.query(`DELETE FROM evestack.schedule_runs WHERE name LIKE $1`, [`${NAME_PREFIX}%`]).catch(() => {});
      await client.query(`DELETE FROM evestack.schedule_state WHERE name LIKE $1`, [`${NAME_PREFIX}%`]).catch(() => {});
      await client.end().catch(() => {});
    }
  },
};
