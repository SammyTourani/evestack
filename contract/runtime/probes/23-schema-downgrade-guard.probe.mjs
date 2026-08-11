/**
 * The downgrade guard, EXECUTED.
 *
 * sql/traces.sql and sql/facts.sql each open with a DO block that raises
 * SQLSTATE EV001 and applies nothing when the installed schema version is
 * higher than the one the file installs. It is the whole defence against an
 * older image half-downgrading a newer database — measured on a live install,
 * the marker read `spans v4` while `resolve_span_ancestry` was the v3 body and
 * fresh spans went back to resolving as `turn_0`, with the marker still
 * claiming v4 so the migration that would have repaired it could never re-run.
 *
 * NOTHING IN THIS REPOSITORY HAD EVER RUN THAT RAISE. test/schema-guard.test.mjs
 * reads the two files as text and asserts their structure, which is worth
 * having and cannot observe behaviour; it said the behaviour was proved by
 * probes 06 and 07, and that was false. Both of those move the marker
 * BACKWARD — 06 deletes the spans row, 07 sets facts to 0 — to check that the
 * migration re-runs. Neither ever sets a version ABOVE target, so neither can
 * reach `installed > target` at all.
 *
 * What that left open, measured against the tree as it stood: change the
 * guard's `component = 'spans'` to `'spanz'` and leave the migration and the
 * stamp alone, and `installed` is NULL forever, the comparison is never true,
 * and the guard is a permanent no-op. Invert the comparison and it fires on
 * every fresh install instead. Both passed the whole offline suite. Only
 * applying the file against a real server tells those apart from a guard that
 * works, which is what this does.
 *
 * ── Why it builds its own database ──────────────────────────────────────────
 *
 * The scenario needs a COMMITTED marker ahead of the file, and the operator's
 * database is the one thing that must not be left holding one: for as long as
 * it did, every other writer applying these files would be refused. So each
 * guarded file gets a scratch database of its own, is applied to it for real,
 * and the database is dropped at the end. Nothing this probe does is visible in
 * the database it was pointed at, beyond the CREATE DATABASE itself.
 *
 * That also buys the control this check would be worthless without. A refusal
 * proves nothing on its own — a file that raised on EVERY database would pass a
 * check that only looks for the raise. So the file is applied to a fresh
 * database FIRST and has to succeed and stamp its own version, and only then is
 * the marker moved ahead. The two halves together are the property: refuses
 * when the database is newer, applies when it is not.
 *
 * ── What "nothing was applied" is asserted as ───────────────────────────────
 *
 * Not the absence of one named function, which would be a list to maintain per
 * file. The schema is emptied down to the marker table before the refused
 * apply, and afterwards it must still hold nothing but the marker — against a
 * recorded count of what the same file created on the same connection when it
 * was allowed to run. A guard that raises after its file has already created
 * half a schema is not a guard, and psql's statement-per-transaction is exactly
 * how that happens.
 *
 * The guarded files are DISCOVERED, by the same predicate contract 22 uses, so
 * a third one is covered the day it grows a guard rather than the day somebody
 * remembers to add it here. Each is applied on its own empty database, which
 * measurement says both of today's files support: sql/facts.sql applies
 * standalone, its references to evestack.spans being inside plpgsql bodies that
 * Postgres does not resolve until they are called.
 */
import { readFileSync, readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, "../../../packages/dashboard");
const SQL_DIR = join(DASHBOARD, "sql");

/** This repository's SQLSTATE for "your database is newer than this build". */
const EV001 = "EV001";

/** Scratch databases this probe creates are named for it, and dropped by it. */
const PREFIX = "evestack_guard_probe_";

const read = (file) => readFileSync(join(SQL_DIR, file), "utf8");

/**
 * The files that carry a guard, found rather than listed.
 *
 * Same predicate as contract 22 and test/schema-guard.test.mjs, so all three
 * agree on what "guarded" means and none of them can be looking at a smaller
 * set than the others.
 */
function guardedFiles() {
  return readdirSync(SQL_DIR)
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => read(file).includes(EV001))
    .sort();
}

/** `target constant integer := N` — the first one is the guard's own. */
function targetOf(sql) {
  const found = /target\s+constant\s+integer\s*:=\s*(\d+)/.exec(sql);
  return found ? Number(found[1]) : null;
}

/**
 * The component name the file STAMPS.
 *
 * Read from the stamp and deliberately not from the guard's own SELECT. The
 * marker this probe writes has to be the one a real installation would carry,
 * and the stamp is what writes that; taking the name from the guard would hand
 * a guard reading `component = 'spanz'` a row under exactly that name and let
 * it raise, which is the one mistake this probe exists to catch.
 */
function componentOf(sql) {
  const found = /INSERT INTO evestack\.schema_version \(component, version\)\s*VALUES \('(\w+)'/.exec(sql);
  return found ? found[1] : null;
}

async function client(url) {
  const { default: pg } = await import("pg");
  const connected = new pg.Client({ connectionString: url });
  await connected.connect();
  await connected.query("SET statement_timeout = '60s'");
  // An idle client that loses its socket emits 'error'; unhandled, it takes the
  // whole probe runner down with it.
  connected.on("error", () => {});
  return connected;
}

/**
 * The same server, a different database.
 *
 * CREATE DATABASE cannot run inside a transaction block and cannot run from the
 * database being created, so the connection that issues it has to be somewhere
 * else. `postgres` is the maintenance database every server ships with.
 */
function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * Everything in schema `evestack` except the marker table itself.
 *
 * Relations and routines both, because a file can be refused after creating
 * either. The marker is excluded because this probe puts it there on purpose —
 * and so is its primary key, which is a relation of its own and would otherwise
 * report a database this probe emptied as holding one surviving object.
 */
async function inventory(connected) {
  const { rows } = await connected.query(`
    SELECT c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'evestack'
       AND c.relname <> 'schema_version'
       AND NOT EXISTS (
         SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
          WHERE i.indexrelid = c.oid AND t.relname = 'schema_version')
    UNION ALL
    SELECT p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'evestack'
  `);
  return rows.map((row) => row.name);
}

export default {
  id: "schema/downgrade-guard-refuses-a-newer-database",
  title: "the EV001 guard raises, applies nothing, and says so on /api/health",
  needs: ["postgres"],
  why:
    "sql/traces.sql and sql/facts.sql refuse to apply against a database whose schema version " +
    "is higher than their own, and that refusal is the only thing standing between an older " +
    "image and a half-downgraded database. Nothing had ever executed it: a guard reading a " +
    "component nothing stamps, or comparing the wrong way round, is a permanent no-op that " +
    "passes every offline check. This applies both files to a scratch database of their own, " +
    "for real, with the marker moved ahead of them.",

  async available() {
    const url = process.env.WORKFLOW_POSTGRES_URL;
    if (!url) return ["WORKFLOW_POSTGRES_URL is not set"];
    const files = guardedFiles();
    if (files.length === 0) return ["no sql file in packages/dashboard/sql raises " + EV001];
    for (const file of files) {
      const sql = read(file);
      if (targetOf(sql) === null) return [`sql/${file} declares no target constant`];
      if (componentOf(sql) === null) return [`sql/${file} names no schema_version component`];
    }
    try {
      const connected = await client(withDatabase(url, "postgres"));
      const { rows } = await connected.query(
        "SELECT rolsuper OR rolcreatedb AS may_create FROM pg_roles WHERE rolname = current_user",
      );
      await connected.end();
      if (!rows[0]?.may_create) {
        return [
          "the connected role may not CREATE DATABASE, and this probe will not move a live " +
            "database's schema marker ahead of the image reading it",
        ];
      }
      return [];
    } catch (error) {
      return ["cannot reach Postgres: " + error.message];
    }
  },

  async run(t) {
    const url = process.env.WORKFLOW_POSTGRES_URL;
    const cwd = process.cwd();
    const priorUrl = process.env.WORKFLOW_POSTGRES_URL;
    const priorUser = process.env.EVESTACK_AUTH_USER;
    const priorPassword = process.env.EVESTACK_AUTH_PASSWORD;

    // lib/facts.ts and lib/traces.ts read their own sql/ off disk, relative to
    // the process working directory.
    process.chdir(DASHBOARD);
    await import(join(DASHBOARD, "test/register-ts-resolve.mjs"));
    // The health route imports through the "@/…" tsconfig alias, which Node
    // does not know about. Same hook, same reason, as the dashboard's own
    // test/schema-guard.test.mjs. A bare specifier like "@evestack/schedules"
    // does not start with "@/" and is untouched.
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.startsWith("@/")) {
          const candidate = new URL(`${specifier.slice(2)}.ts`, `file://${DASHBOARD}/`);
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });

    const db = await import(join(DASHBOARD, "lib/db.ts"));
    const { GET: health } = await import(join(DASHBOARD, "app/api/health/route.ts"));

    // /api/health short-circuits to `unconfigured` without these, before it
    // reaches the database at all.
    process.env.EVESTACK_AUTH_USER ??= "probe";
    process.env.EVESTACK_AUTH_PASSWORD ??= "probe-password";

    const admin = await client(withDatabase(url, "postgres"));
    const created = [];

    try {
      for (const file of guardedFiles()) {
        const sql = read(file);
        const target = targetOf(sql);
        const component = componentOf(sql);
        const name = PREFIX + Math.random().toString(16).slice(2, 10);

        await admin.query(`CREATE DATABASE ${name}`);
        created.push(name);
        const scratch = await client(withDatabase(url, name));

        try {
          /* ── the control: on a database it understands, the file applies ── */

          let applied = null;
          try {
            await scratch.query(sql);
          } catch (error) {
            applied = error;
          }
          t.ok(applied === null, `sql/${file} applies to an empty database`, {
            expected: "no error",
            actual: applied ? `${applied.code}: ${applied.message}` : "no error",
          });
          if (applied) continue;

          const built = await inventory(scratch);
          t.ok(built.length > 0, `sql/${file} creates something when it is allowed to run`, {
            expected: "at least one relation or routine in schema evestack",
            actual: `${built.length}; with nothing to lose, the refusal below would prove nothing`,
          });

          const { rows: stamped } = await scratch.query(
            "SELECT version FROM evestack.schema_version WHERE component = $1",
            [component],
          );
          t.ok(
            Number(stamped[0]?.version) === target,
            `sql/${file} stamps ${component} at the version its guard enforces`,
            { expected: String(target), actual: String(stamped[0]?.version ?? "no row") },
          );

          /* ── the scenario: a database one version newer than this file ──── */

          // Emptied to the marker so that "nothing was applied" is a question
          // the database can answer, rather than one about which of two
          // identical CREATE ... IF NOT EXISTS outcomes happened.
          await scratch.query("DROP SCHEMA evestack CASCADE");
          await scratch.query("CREATE SCHEMA evestack");
          await scratch.query(
            "CREATE TABLE evestack.schema_version (component text PRIMARY KEY," +
              " version integer NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
          );
          await scratch.query("INSERT INTO evestack.schema_version (component, version) VALUES ($1, $2)", [
            component,
            target + 1,
          ]);

          let raised = null;
          try {
            await scratch.query(sql);
          } catch (error) {
            raised = error;
          }
          // The file opens with BEGIN, and the simple query protocol stops at
          // the first error — so its COMMIT never ran and this session is
          // sitting in an aborted transaction until it is told otherwise.
          await scratch.query("ROLLBACK").catch(() => {});

          t.ok(raised !== null, `sql/${file} refuses a database one version newer than itself`, {
            expected: `SQLSTATE ${EV001}`,
            actual: "the file applied itself over a newer database without complaint",
          });
          t.ok(raised?.code === EV001, `the refusal carries SQLSTATE ${EV001}`, {
            expected: EV001,
            actual: String(raised?.code),
            // Matching on the code and not the prose is what lets lib/db.ts
            // classify it under any Postgres locale.
          });
          const message = String(raised?.message ?? "");
          t.ok(
            new RegExp(`\\b${target + 1}\\b`).test(message) && new RegExp(`\\b${target}\\b`).test(message),
            "the message names the version installed and the version understood",
            {
              expected: `both ${target + 1} and ${target}`,
              actual: message.slice(0, 200) || "no message",
            },
          );

          const after = await inventory(scratch);
          t.ok(after.length === 0, `sql/${file} applied NOTHING when it was refused`, {
            expected: "an empty evestack schema",
            actual:
              after.length === 0
                ? "empty"
                : `${after.length} object(s) survived the refusal: ${after.slice(0, 8).join(", ")}` +
                  " — the guard raised after its own file had already changed the database",
          });

          const { rows: still } = await scratch.query(
            "SELECT version FROM evestack.schema_version WHERE component = $1",
            [component],
          );
          t.ok(
            Number(still[0]?.version) === target + 1,
            "the refused file did not write its own lower version over the marker",
            { expected: String(target + 1), actual: String(still[0]?.version ?? "no row") },
          );

          /* ── and the endpoint anybody actually polls ────────────────────── */

          // The route asks whether eve's schema is present before it asks
          // anything about versions; on this database it is not, and a stub is
          // enough because to_regclass is all it does with it.
          await scratch.query("CREATE SCHEMA IF NOT EXISTS workflow");
          await scratch.query("CREATE TABLE IF NOT EXISTS workflow.workflow_runs (id text PRIMARY KEY)");
          await scratch.end();

          // The pool is process-wide and other probes share this process, so it
          // is closed on the way in as well as on the way out.
          await db.closePool();
          process.env.WORKFLOW_POSTGRES_URL = withDatabase(url, name);
          let body = null;
          let status = 0;
          try {
            const response = await health();
            status = response.status;
            body = await response.json();
          } finally {
            await db.closePool();
            process.env.WORKFLOW_POSTGRES_URL = priorUrl;
          }

          t.ok(status === 503, `/api/health reports a ${component}-ahead database as unhealthy`, {
            expected: "503, which is the status Docker's HEALTHCHECK reads",
            actual: String(status),
          });
          t.ok(body?.status === "degraded" && body?.reason === "schema-too-new", "…and says which failure it is", {
            expected: "degraded / schema-too-new",
            actual: `${body?.status} / ${body?.reason}`,
          });
          t.ok(body?.database === "connected", "…without blaming Postgres, which is fine", {
            expected: "connected",
            actual: String(body?.database),
          });
          t.ok(
            new RegExp(`${component} is at v${target + 1}`).test(String(body?.error)),
            "…naming the component and the version it is ahead by",
            { expected: `${component} is at v${target + 1}`, actual: String(body?.error).slice(0, 200) },
          );
          const unavailable = body?.unavailable ?? [];
          const available = body?.available ?? [];
          for (const route of ["/traces", "/api/ingest/v1/traces", "/api/metrics/query"]) {
            t.ok(unavailable.includes(route), `…and that ${route} cannot be served`, {
              expected: route + " listed as unavailable",
              actual: unavailable.join(", ") || "nothing listed",
            });
          }
          t.ok(available.includes("/monitors"), "…while the half that reads only workflow tables stays up", {
            expected: "/monitors listed as available",
            actual: available.join(", ") || "nothing listed",
          });
          t.ok(
            available.every((route) => !unavailable.includes(route)),
            "…and no route is listed as both working and not",
            { expected: "disjoint lists", actual: `available: ${available.join(", ")}` },
          );
        } finally {
          await scratch.end().catch(() => {});
        }
      }
    } finally {
      await db.closePool().catch(() => {});
      process.env.WORKFLOW_POSTGRES_URL = priorUrl;
      if (priorUser === undefined) delete process.env.EVESTACK_AUTH_USER;
      else process.env.EVESTACK_AUTH_USER = priorUser;
      if (priorPassword === undefined) delete process.env.EVESTACK_AUTH_PASSWORD;
      else process.env.EVESTACK_AUTH_PASSWORD = priorPassword;
      for (const name of created) {
        // FORCE so a connection this probe failed to close cannot leave a
        // database behind; it is Postgres 13 and up, and the plain form is the
        // fallback rather than the other way round.
        await admin
          .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
          .catch(async () => admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {}));
      }
      await admin.end().catch(() => {});
      process.chdir(cwd);
    }
  },
};
