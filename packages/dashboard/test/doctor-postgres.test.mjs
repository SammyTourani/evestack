import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import pg from "pg";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/"))
      return next(
        new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href,
        context,
      );
    return next(specifier, context);
  },
});

test(
  "dashboard queue diagnosis shares CLI findings with a read-only snapshot",
  { skip: !process.env.EVESTACK_TEST_POSTGRES_URL },
  async (t) => {
    const admin = new pg.Client({
      connectionString: process.env.EVESTACK_TEST_POSTGRES_URL,
    });
    await admin.connect();
    const name = `doctor_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.EVESTACK_TEST_POSTGRES_URL);
    url.pathname = `/${name}`;
    const original = process.env.WORKFLOW_POSTGRES_URL;
    process.env.WORKFLOW_POSTGRES_URL = url.href;
    const { getPool, closePool } = await import("../lib/db.ts");
    t.after(async () => {
      await closePool();
      if (original === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
      else process.env.WORKFLOW_POSTGRES_URL = original;
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    });
    const { diagnoseQueue } = await import("../lib/queue-diagnosis.ts");
    const { GET } = await import("../app/api/doctor/route.ts");
    const db = getPool();
    await t.test(
      "missing storage stays unavailable and caller-selected databases/schemas are refused",
      async () => {
        const unavailable = await GET(
          new Request("http://localhost/api/doctor"),
        );
        assert.equal(unavailable.status, 503);
        assert.match(
          (await unavailable.json()).error,
          /No repair was attempted/,
        );
        assert.equal(
          (
            await db.query(
              "SELECT to_regnamespace('graphile_worker') AS schema",
            )
          ).rows[0].schema,
          null,
        );
        assert.equal(
          (
            await GET(
              new Request(
                "http://localhost/api/doctor?url=postgres://private.example/db",
              ),
            )
          ).status,
          400,
        );
      },
    );
    await db.query(`CREATE SCHEMA graphile_worker; CREATE SCHEMA workflow;
    CREATE TABLE graphile_worker._private_jobs (
      id bigserial PRIMARY KEY, job_queue_id integer, task_id integer, payload jsonb,
      priority integer DEFAULT 0, run_at timestamptz DEFAULT now(), attempts integer DEFAULT 0,
      max_attempts integer DEFAULT 3, last_error text, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(), key text, locked_at timestamptz, locked_by text,
      is_available boolean GENERATED ALWAYS AS ((locked_at IS NULL) AND (attempts<max_attempts)) STORED);
    CREATE TABLE workflow.workflow_runs (id text PRIMARY KEY,status text,name text,attributes jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    INSERT INTO workflow.workflow_runs(id,status,name,attributes) VALUES('stranded','running','turn','{"$eve.type":"turn","$eve.root":"fixture-task"}'),('replaced','running','turn','{}');`);
    const add = (run, attempts = 3, error = null) =>
      db.query(
        "INSERT INTO graphile_worker._private_jobs(payload,attempts,last_error,key) VALUES($1,$2,$3,$4)",
        [
          {
            data: Buffer.from(JSON.stringify({ runId: run })).toString(
              "base64",
            ),
          },
          attempts,
          error,
          `key-${run}`,
        ],
      );
    await add("stranded");
    await add("replaced");
    await add("replaced", 0);
    await add("failed", 3, "Fixture provider refusal");
    const snapshot = async () =>
      (
        await db.query(
          "SELECT to_jsonb(j) AS value FROM graphile_worker._private_jobs j ORDER BY id",
        )
      ).rows;
    const before = await snapshot();
    await t.test(
      "a missing optional migration table does not abort diagnosis and exhausted replacement jobs are distinguished",
      async () => {
        const result = await diagnoseQueue();
        assert.equal(result.readOnly, true);
        assert.equal(result.migration, null);
        assert.equal(result.counts.jobs, 4);
        assert.equal(result.counts.attempts_exhausted, 3);
        assert.equal(result.counts.available, 1);
        assert.equal(result.coverage.agent, "not_probed");
        assert.ok(
          result.findings.some(
            (f) => f.id === "stranded-runs" && f.severity === "critical",
          ),
        );
        assert.ok(
          result.findings.some(
            (f) => f.id === "sessions-not-probed" && f.blind,
          ),
        );
        // Compare the actual CLI classifier, not a copied expected message.
        const { diagnose } = await import("../../evestack-cli/src/doctor.mjs");
        const cli = await diagnose({
          connectionString: url.href,
          probes: 0,
          limit: 20,
        });
        assert.deepEqual(
          result.findings.map(({ id, severity, title, action, blind }) => ({
            id,
            severity,
            title,
            action,
            blind,
          })),
          cli.findings.map(({ id, severity, title, action, blind }) => ({
            id,
            severity,
            title,
            action,
            blind,
          })),
        );
        assert.deepEqual(
          await snapshot(),
          before,
          "no job was retried or unlocked",
        );
      },
    );
    await t.test(
      "bounded findings disclose omitted rows and preserve the full queue count",
      async () => {
        for (let i = 0; i < 23; i++)
          await add(`extra-${i}`, 3, "long error " + "x".repeat(5000));
        const result = await diagnoseQueue();
        assert.equal(result.counts.jobs, 27);
        assert.equal(result.coverage.candidates.exhausted, 20);
        assert.ok(result.coverage.possiblyTruncated.includes("exhausted"));
        assert.equal(result.coverage.displayTruncated, true);
        for (const finding of result.findings)
          for (const row of finding.evidence)
            for (const value of Object.values(row))
              assert.ok(value.length <= 500);
      },
    );
    await t.test(
      "the database enforces the transaction's read-only guarantee",
      async () => {
        await db.query(
          "ALTER TABLE graphile_worker._private_jobs RENAME TO stored_jobs",
        );
        await db.query(`CREATE FUNCTION graphile_worker.must_be_read_only() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN
      IF current_setting('transaction_read_only') <> 'on' THEN RAISE EXCEPTION 'diagnostic query is writable'; END IF;
      RETURN true; END $$;
      CREATE VIEW graphile_worker._private_jobs AS SELECT * FROM graphile_worker.stored_jobs WHERE graphile_worker.must_be_read_only()`);
        assert.equal((await diagnoseQueue()).readOnly, true);
        await db.query(
          "DROP VIEW graphile_worker._private_jobs; DROP FUNCTION graphile_worker.must_be_read_only(); ALTER TABLE graphile_worker.stored_jobs RENAME TO _private_jobs",
        );
      },
    );
    await t.test(
      "unsupported queue columns fail explicitly without returning stored secrets",
      async () => {
        await db.query(
          "ALTER TABLE graphile_worker._private_jobs DROP COLUMN payload",
        );
        const response = await GET(new Request("http://localhost/api/doctor"));
        assert.equal(response.status, 503);
        assert.doesNotMatch(
          JSON.stringify(await response.json()),
          /Fixture provider refusal|long error/,
        );
      },
    );
  },
);
