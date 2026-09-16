import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

test(
  "recovery evidence and versioned regression review on PostgreSQL",
  { skip: !process.env.EVESTACK_TEST_POSTGRES_URL },
  async (t) => {
    const admin = new pg.Client({
      connectionString: process.env.EVESTACK_TEST_POSTGRES_URL,
    });
    await admin.connect();
    const name = `recovery_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.EVESTACK_TEST_POSTGRES_URL);
    url.pathname = `/${name}`;
    const original = process.env.WORKFLOW_POSTGRES_URL;
    process.env.WORKFLOW_POSTGRES_URL = url.href;
    const { getPool, closePool } = await import("../lib/db.ts");
    const { getTaskRecovery } = await import("../lib/task-recovery.ts");
    const { checkReadiness } = await import("../lib/readiness.ts");
    t.after(async () => {
      await closePool();
      if (original === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
      else process.env.WORKFLOW_POSTGRES_URL = original;
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    });
    const db = getPool();
    await db.query(`CREATE SCHEMA workflow; CREATE TABLE workflow.workflow_runs(id text PRIMARY KEY,status text,attributes jsonb,error_code text,created_at timestamptz DEFAULT now(),completed_at timestamptz);
    INSERT INTO workflow.workflow_runs(id,status,attributes) VALUES('task-a','running','{"$eve.type":"session"}');`);
    const addTurn = async (id, status, model, age, error = null) =>
      db.query(
        `INSERT INTO workflow.workflow_runs(id,status,attributes,error_code,created_at,completed_at) VALUES($1,$2,$3,$4,now()-($5::int*interval '1 minute'),now()-($5::int*interval '1 minute'))`,
        [
          id,
          status,
          JSON.stringify({
            "$eve.type": "turn",
            "$eve.parent": "task-a",
            ...(model ? { "$eve.model": model } : {}),
          }),
          error,
          age,
        ],
      );
    await addTurn(
      "failed-turn",
      "failed",
      "model-fixture",
      3,
      "PROVIDER_LIMIT",
    );
    await addTurn("completed-turn", "completed", "model-fixture", 2);
    await t.test(
      "a subsequent completed turn does not erase the failure and a missing trace schema is explicit",
      async () => {
        const result = await getTaskRecovery("task-a");
        assert.equal(result.failure.code, "PROVIDER_LIMIT");
        assert.equal(result.completedTurn.id, "completed-turn");
        assert.equal(result.coverage.traces, "unavailable");
        assert.equal(result.coverage.turns, "available");
        assert.equal(result.response, null);
        assert.equal(
          (await db.query("SELECT to_regnamespace('evestack') AS schema"))
            .rows[0].schema,
          null,
          "reading evidence must not create the trace schema",
        );
        assert.equal(await getTaskRecovery("missing-task"), null);
      },
    );
    await t.test("readiness executes a read-only workflow probe", async () => {
      const result = await checkReadiness("database");
      assert.equal(result.status, "verified");
      assert.equal(result.ready, true);
    });
    await db.query(
      `CREATE SCHEMA evestack; CREATE TABLE evestack.spans(span_id text PRIMARY KEY,name text,status_code smallint,status_message text,start_time timestamptz DEFAULT now(),end_time timestamptz,resolved_session_id text,attributes jsonb DEFAULT '{}');`,
    );
    const span = async (
      id,
      name,
      status,
      session = "task-a",
      attributes = {},
      ended = true,
      age = 0,
    ) =>
      db.query(
        `INSERT INTO evestack.spans(span_id,name,status_code,resolved_session_id,attributes,end_time,start_time,status_message) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() END,now()-($7::int*interval '1 minute'),'fixture trace error')`,
        [id, name, status, session, JSON.stringify(attributes), ended, age],
      );
    await span(
      "good-action",
      "execute_tool fetch_report",
      1,
      "task-a",
      {},
      true,
      2,
    );
    await span("unknown-action", "execute_tool send_email", 0);
    await span("unfinished", "execute_tool unfinished", 1, "task-a", {}, false);
    await span("foreign", "execute_tool foreign_secret", 1, "task-b", {
      "ai.response.text": "foreign private text",
    });
    await span("failure", "chat fixture", 2, "task-a", {
      "ai.response.text": "Partial response " + "a".repeat(9000),
    });
    await t.test(
      "only explicitly successful finished tools qualify, and foreign task spans are excluded",
      async () => {
        const result = await getTaskRecovery("task-a");
        assert.equal(result.successfulAction.name, "execute_tool fetch_report");
        assert.equal(result.traceError.name, "chat fixture");
        assert.equal(result.response.text.length, 8000);
        assert.equal(result.response.truncated, true);
        assert.equal(result.coverage.tracesRead, 4);
        assert.equal(JSON.stringify(result).includes("foreign"), false);
      },
    );
    await addTurn("no-model", "completed", null, 0);
    await t.test(
      "a terminal turn with no model evidence is not called a successful turn",
      async () => {
        const result = await getTaskRecovery("task-a");
        assert.equal(result.failure.code, "no_recorded_model_call");
        assert.equal(result.completedTurn.id, "completed-turn");
      },
    );
    await t.test(
      "long histories report bounded coverage and older omitted records",
      async () => {
        await db.query(`INSERT INTO workflow.workflow_runs(id,status,attributes,created_at) SELECT 'extra-'||n,'running','{"$eve.type":"turn","$eve.root":"task-a"}'::jsonb,now()+n*interval '1 second' FROM generate_series(1,105)n;
      INSERT INTO evestack.spans(span_id,name,status_code,resolved_session_id,start_time) SELECT 'extra-'||n,'execute_tool recent',0,'task-a',now()+n*interval '1 second' FROM generate_series(1,55)n;`);
        const result = await getTaskRecovery("task-a");
        assert.equal(result.coverage.turnsRead, 100);
        assert.equal(result.coverage.tracesRead, 50);
        assert.equal(result.coverage.turnsTruncated, true);
        assert.equal(result.coverage.tracesTruncated, true);
        assert.equal(result.failure, null);
        assert.equal(result.successfulAction, null);
      },
    );
    const cases = await import("../lib/regressions.ts");
    const actor = { approver: "fixture-operator", via: "basic" };
    const baseline = await getTaskRecovery("task-a");
    const caseInput = {
      id: randomUUID(),
      title: "Repository evidence must identify its source",
      correction: "The original response did not name a verified source.",
      expected:
        "Include a source link and distinguish unknown access from a missing repository.",
      baselineId: "task-a",
      baselineHash: cases.evidenceFingerprint(baseline),
    };
    await t.test(
      "a case pins real server evidence, and a repeated create is idempotent",
      async () => {
        const saved = await cases.createRegressionCase(
          { ...caseInput, baseline: { spoofed: true } },
          actor,
        );
        const repeated = await cases.createRegressionCase(caseInput, actor);
        assert.equal(saved.case_id, repeated.case_id);
        assert.equal(saved.revision, 1);
        assert.equal(saved.baseline.session.id, "task-a");
        assert.equal(saved.baseline.spoofed, undefined);
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM evestack.regression_versions",
            )
          ).rows[0].n,
          1,
        );
        assert.equal(saved.actor, "fixture-operator");
        await assert.rejects(
          () =>
            cases.createRegressionCase(
              {
                ...caseInput,
                title: "A changed request with an already used id",
              },
              actor,
            ),
          cases.RegressionConflictError,
        );
      },
    );
    await t.test(
      "concurrent case edits produce one new revision and preserve the original snapshot",
      async () => {
        const edits = await Promise.allSettled(
          ["First edited expectation", "Second edited expectation"].map(
            (expected) =>
              cases.editRegressionCase(
                caseInput.id,
                {
                  revision: 1,
                  title: caseInput.title,
                  correction: caseInput.correction,
                  expected,
                },
                actor,
              ),
          ),
        );
        assert.equal(edits.filter((x) => x.status === "fulfilled").length, 1);
        assert.equal(
          edits.filter(
            (x) =>
              x.status === "rejected" &&
              x.reason instanceof cases.RegressionConflictError,
          ).length,
          1,
        );
        const saved = await cases.getRegressionCase(caseInput.id);
        assert.equal(saved.current.revision, 2);
        assert.equal(saved.versions.length, 2);
        assert.equal(saved.current.baseline_hash, caseInput.baselineHash);
        assert.equal(
          saved.versions.find((x) => x.revision === 1).expected,
          caseInput.expected,
        );
      },
    );
    await db.query(`INSERT INTO workflow.workflow_runs(id,status,attributes) VALUES('task-b','running','{"$eve.type":"session"}');
    INSERT INTO workflow.workflow_runs(id,status,attributes,completed_at) VALUES('candidate-turn','completed','{"$eve.type":"turn","$eve.parent":"task-b","$eve.model":"candidate-model"}',now());`);
    let candidate = await getTaskRecovery("task-b");
    const candidateInput = {
      id: randomUUID(),
      revision: 2,
      candidateId: "task-b",
      candidateHash: cases.evidenceFingerprint(candidate),
      verdict: "observed_pass",
      note: "Operator inspected the linked report and verified the repository source.",
    };
    await t.test(
      "candidate evidence changed after preview is refused without recording a judgment",
      async () => {
        await db.query(
          "UPDATE workflow.workflow_runs SET error_code='NEW_FAILURE' WHERE id='candidate-turn'",
        );
        await assert.rejects(
          () =>
            cases.reviewRegressionCandidate(
              caseInput.id,
              candidateInput,
              actor,
            ),
          cases.RegressionConflictError,
        );
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM evestack.regression_reviews",
            )
          ).rows[0].n,
          0,
        );
        candidate = await getTaskRecovery("task-b");
        candidateInput.candidateHash = cases.evidenceFingerprint(candidate);
        candidateInput.verdict = "observed_fail";
      },
    );
    await t.test(
      "manual judgments pin a revision and snapshot, deduplicate retries, and survive later edits",
      async () => {
        const saved = await cases.reviewRegressionCandidate(
          caseInput.id,
          candidateInput,
          actor,
        );
        const repeated = await cases.reviewRegressionCandidate(
          caseInput.id,
          candidateInput,
          actor,
        );
        assert.equal(saved.id, repeated.id);
        assert.equal(saved.verdict, "observed_fail");
        assert.equal(saved.candidate.failure.code, "NEW_FAILURE");
        await cases.editRegressionCase(
          caseInput.id,
          {
            revision: 2,
            title: caseInput.title,
            correction: caseInput.correction,
            expected: "A newer expectation needs its own candidate review.",
          },
          actor,
        );
        const current = await cases.getRegressionCase(caseInput.id);
        assert.equal(current.current.revision, 3);
        assert.equal(current.reviews.length, 1);
        assert.equal(current.reviews[0].revision, 2);
        assert.equal(current.reviews.filter((x) => x.revision === 3).length, 0);
        await assert.rejects(
          () =>
            cases.reviewRegressionCandidate(
              caseInput.id,
              { ...candidateInput, id: randomUUID() },
              actor,
            ),
          cases.RegressionConflictError,
        );
      },
    );
    await t.test(
      "the baseline cannot masquerade as a candidate and judgments require evidence notes",
      async () => {
        await assert.rejects(
          () =>
            cases.reviewRegressionCandidate(
              caseInput.id,
              {
                ...candidateInput,
                id: randomUUID(),
                revision: 3,
                candidateId: "task-a",
                candidateHash: caseInput.baselineHash,
              },
              actor,
            ),
          cases.RegressionInputError,
        );
        await assert.rejects(
          () =>
            cases.reviewRegressionCandidate(
              caseInput.id,
              { ...candidateInput, id: randomUUID(), revision: 3, note: "ok" },
              actor,
            ),
          cases.RegressionInputError,
        );
        await assert.rejects(
          () =>
            cases.reviewRegressionCandidate(
              caseInput.id,
              {
                ...candidateInput,
                id: randomUUID(),
                revision: 3,
                verdict: "automated_pass",
              },
              actor,
            ),
          cases.RegressionInputError,
        );
      },
    );

    await t.test(
      "a failed version insert rolls back the case head and a newer schema refuses this writer",
      async () => {
        await db.query(`CREATE FUNCTION evestack.reject_case_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture version audit failure'; END $$;
      CREATE TRIGGER reject_case_version BEFORE INSERT ON evestack.regression_versions FOR EACH ROW EXECUTE FUNCTION evestack.reject_case_version();`);
        const rejectedId = randomUUID();
        await assert.rejects(
          () =>
            cases.createRegressionCase({ ...caseInput, id: rejectedId }, actor),
          /fixture version audit failure/,
        );
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM evestack.regression_cases WHERE id=$1",
              [rejectedId],
            )
          ).rows[0].n,
          0,
        );
        await db.query(
          "DROP TRIGGER reject_case_version ON evestack.regression_versions",
        );
        const { readFile } = await import("node:fs/promises");
        const sql = await readFile(
          new URL("../sql/regressions.sql", import.meta.url),
          "utf8",
        );
        await db.query(sql);
        await db.query(
          "UPDATE evestack.schema_version SET version=2 WHERE component='regressions'",
        );
        await assert.rejects(() => db.query(sql), /newer than this dashboard/);
        await db.query("ROLLBACK");
        assert.equal(
          (
            await db.query(
              "SELECT version FROM evestack.schema_version WHERE component='regressions'",
            )
          ).rows[0].version,
          2,
        );
        await assert.rejects(
          () =>
            cases.editRegressionCase(
              caseInput.id,
              {
                revision: 3,
                title: caseInput.title,
                correction: caseInput.correction,
                expected: caseInput.expected,
              },
              actor,
            ),
          cases.RegressionConflictError,
        );
        assert.equal(
          (
            await db.query(
              "SELECT revision FROM evestack.regression_cases WHERE id=$1",
              [caseInput.id],
            )
          ).rows[0].revision,
          3,
        );
      },
    );
  },
);
