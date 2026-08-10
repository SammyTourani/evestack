/**
 * A throwaway PostgreSQL database, so a probe can drive the SHIPPED queries.
 *
 * ─ Why a database and not a schema ─
 *
 * The dashboard's queries name their schemas: `workflow.workflow_runs` and
 * `evestack.spans` are written into the SQL, not assembled from a variable. A
 * probe that wants to run one of them against fixtures has three options, and
 * two of them are bad:
 *
 *   - write the fixtures into the live `workflow` schema. That is eve's table.
 *     No probe in this tier writes there and none should start.
 *   - copy the query into the probe and repoint it at a scratch schema. This is
 *     what contract/runtime/probes/06-session-keyset-and-tool-calls.probe.mjs
 *     did, and it is why that probe stayed green straight through the `turn_0`
 *     join bug that blanked every session page: the probe was asserting about
 *     its own copy of the SQL, which was correct, while the shipped copy was
 *     not. A restated query cannot fail for the reason the real one fails.
 *   - give the code a whole database of its own, with the real schema names in
 *     it, and point `WORKFLOW_POSTGRES_URL` at that. Then `getSessionTree` runs
 *     verbatim — same text, same schema names, same `ensure*` bootstrap — over
 *     rows the probe controls.
 *
 * This is the third. It costs a CREATE DATABASE, which the scaffolded Postgres
 * role can do (`create-evestack` generates the container's POSTGRES_USER, so it
 * owns the cluster); `unavailable()` below says so plainly when it cannot,
 * rather than letting the probe fail with a permissions error that reads like a
 * product defect.
 *
 * ─ What the caller still has to do ─
 *
 * Nothing here knows what a fixture looks like. It hands back a URL and a
 * `dispose()`. Applying the shipped DDL, creating eve's tables and pointing the
 * dashboard's pool at the result belongs to the probe, because those are the
 * things a probe should be asserting about rather than inheriting.
 */
import { randomBytes } from "node:crypto";

/** Same shape every probe in this tier uses to talk to the configured server. */
async function connect(connectionString) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/**
 * The reasons this cannot be used, as `available()` wants them: an empty array
 * means go ahead.
 *
 * CREATE privilege is checked by asking the server rather than by trying and
 * reading the error, so the skip reason names the role and the missing grant.
 */
export async function fixtureDatabaseUnavailable() {
  if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
  let client;
  try {
    client = await connect(process.env.WORKFLOW_POSTGRES_URL);
  } catch (error) {
    return [`cannot reach Postgres: ${error.message}`];
  }
  try {
    const { rows } = await client.query(
      "SELECT current_user AS role, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    );
    const role = rows[0];
    if (!role) return ["cannot read pg_roles for the connected role"];
    if (role.rolsuper === true) return [];
    if (role.rolcreatedb === true) return [];
    return [
      `the role ${role.role} may not CREATE DATABASE, and this probe needs a throwaway one ` +
        "so it can run the shipped queries at their real schema names",
    ];
  } catch (error) {
    return [`cannot reach Postgres: ${error.message}`];
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Create the database and hand back how to reach it and how to remove it.
 *
 * The name carries the probe that asked and eight random bytes, so two probes
 * in the same run — or two runs against the same server — cannot collide, and
 * a leftover is traceable to whoever leaked it.
 */
export async function createFixtureDatabase(label) {
  const name = `probe_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 24)}_${randomBytes(4).toString("hex")}`;
  const admin = await connect(process.env.WORKFLOW_POSTGRES_URL);
  try {
    // Not parameterisable: an identifier is not a value. Quoted instead, and
    // the name above is generated rather than taken from anywhere a caller
    // could reach.
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end().catch(() => {});
  }

  const url = new URL(process.env.WORKFLOW_POSTGRES_URL);
  url.pathname = `/${name}`;

  return {
    name,
    url: url.toString(),

    /**
     * Drop it, and do not leave the run red if the drop is the only thing that
     * failed.
     *
     * `WITH (FORCE)` because a pool that was pointed here may still hold an
     * idle socket: without it, DROP DATABASE fails with "is being accessed by
     * other users" and the fixture survives the run. Callers should still close
     * their pool first — this is the belt, not the braces.
     */
    async dispose() {
      let closer;
      try {
        closer = await connect(process.env.WORKFLOW_POSTGRES_URL);
        await closer.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        return null;
      } catch (error) {
        return `could not drop the fixture database ${name}: ${error.message}`;
      } finally {
        await closer?.end().catch(() => {});
      }
    },
  };
}

/**
 * eve's `workflow.workflow_runs`, as world-postgres declares the columns this
 * repository reads.
 *
 * Written out here rather than copied from a migration because world-postgres
 * ships no SQL file to read: the table is created by its own bootstrap at
 * runtime. The columns and their types are pinned by
 * contract/contracts/06-run-attributes.contract.mjs and by
 * contract/contracts/21-naive-timestamps.contract.mjs, and the one that matters
 * most is repeated here so it cannot drift silently: `created_at` is
 * `timestamp` WITHOUT time zone and keeps microseconds. A fixture that used
 * timestamptz would round nothing and quietly make the cursor assertions
 * vacuous.
 */
export const WORKFLOW_RUNS_DDL = `
  CREATE SCHEMA IF NOT EXISTS workflow;
  CREATE TABLE IF NOT EXISTS workflow.workflow_runs (
    id           varchar PRIMARY KEY,
    name         text,
    status       text NOT NULL,
    error        text,
    error_code   text,
    created_at   timestamp NOT NULL,
    started_at   timestamp,
    completed_at timestamp,
    updated_at   timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    attributes   jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  -- Read by sql/facts.sql through a LEFT JOIN LATERAL, so its ABSENCE is a
  -- failed refresh rather than a zero. Present here for that reason alone;
  -- nothing in this repository writes it.
  CREATE TABLE IF NOT EXISTS workflow.workflow_steps (
    run_id       varchar NOT NULL,
    step_id      text    NOT NULL,
    step_name    text    NOT NULL,
    status       text    NOT NULL DEFAULT 'completed',
    attempt      integer NOT NULL DEFAULT 1,
    started_at   timestamp,
    completed_at timestamp,
    created_at   timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    updated_at   timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    error        text,
    PRIMARY KEY (run_id, step_id)
  );
`;
