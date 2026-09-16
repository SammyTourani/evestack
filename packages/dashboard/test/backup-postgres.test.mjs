import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

// No agent, clock or notification dispatcher is imported. Only databases named
// by this test are created/dropped; the configured database is the admin entry.
test("whole-database archive preserves operator history and rolls back a damaged restore", {
  skip: !process.env.EVESTACK_TEST_POSTGRES_URL ||
    !(process.env.EVESTACK_TEST_PG_BIN || process.env.EVESTACK_TEST_PG_CONTAINER),
}, async (t) => {
  const base = new URL(process.env.EVESTACK_TEST_POSTGRES_URL);
  const admin = new pg.Client({ connectionString: base.href });
  await admin.connect();
  const prefix = `backup_test_${randomUUID().replaceAll("-", "")}`;
  const names = [prefix, `${prefix}_restored`, `${prefix}_damaged`];
  const created = [];
  const clients = [];
  const temp = mkdtempSync(join(tmpdir(), "evestack-backup-"));
  const previous = process.env.WORKFLOW_POSTGRES_URL;
  const { closePool } = await import("../lib/db.ts");
  const budget = await import("@evestack/budget/settings");
  t.after(async () => {
    await closePool();
    await budget.closeBudgetSettingsPools();
    await Promise.all(clients.map((client) => client.end()));
    for (const name of created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    if (previous === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
    else process.env.WORKFLOW_POSTGRES_URL = previous;
    rmSync(temp, { recursive: true, force: true });
  });
  for (const name of names) {
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const url = new URL(base);
    url.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    clients.push(client);
  }
  const [source, restored, damaged] = clients;
  const url = new URL(base);
  url.pathname = `/${names[0]}`;
  process.env.WORKFLOW_POSTGRES_URL = url.href;

  const vector = (await source.query("SELECT name FROM pg_available_extensions WHERE name='vector'")).rowCount > 0;
  if (process.env.EVESTACK_TEST_REQUIRE_VECTOR === "1") assert.ok(vector, "the CI image must exercise pgvector");
  if (vector) await source.query("CREATE EXTENSION vector");
  t.diagnostic(vector ? "Restoring pgvector values and HNSW index." : "Native fixture has no pgvector; numeric array fallback only. CI requires pgvector.");
  // Representative workflow records; this rehearsal verifies storage, not the
  // upstream engine's startup/resumption behavior (covered by runtime probes).
  await source.query(`CREATE SCHEMA workflow; CREATE SCHEMA graphile_worker; CREATE SCHEMA workflow_drizzle;
    CREATE TABLE workflow.workflow_runs(id text PRIMARY KEY,status text,attributes jsonb,error_code text,created_at timestamptz DEFAULT now(),completed_at timestamptz);
    INSERT INTO workflow.workflow_runs(id,status,attributes) VALUES ('original','running','{"$eve.type":"session"}'),('candidate','running','{"$eve.type":"session"}');
    CREATE TABLE graphile_worker.backup_fixture(id bigserial PRIMARY KEY,payload jsonb);
    INSERT INTO graphile_worker.backup_fixture(payload) VALUES ('{"pending":true}');
    CREATE TABLE workflow_drizzle.backup_fixture(version integer PRIMARY KEY);
    INSERT INTO workflow_drizzle.backup_fixture VALUES(1);
    CREATE SCHEMA evestack;
    CREATE TABLE evestack.memories(id bigserial PRIMARY KEY,content text NOT NULL,tags text[] DEFAULT '{}',session_id text,principal_id text,embedding ${vector ? "vector(3)" : "double precision[]"},created_at timestamptz DEFAULT now());
    INSERT INTO evestack.memories(content,session_id,principal_id,embedding) VALUES('Retained fact','original','telegram:alice','${vector ? "[1,2,3]" : "{1,2,3}"}'),('Removed fact','original',NULL,NULL);
    CREATE TABLE evestack.spans(span_id text PRIMARY KEY,name text,status_code smallint,status_message text,start_time timestamptz DEFAULT now(),end_time timestamptz,resolved_session_id text,attributes jsonb DEFAULT '{}');
    INSERT INTO evestack.spans(span_id,name,status_code,resolved_session_id,attributes,end_time) VALUES('span-1','execute_tool read_file',1,'original','{"ai.response.text":"Fixture result"}',now());`);
  if (vector) await source.query("CREATE INDEX memory_embedding_fixture ON evestack.memories USING hnsw(embedding vector_cosine_ops)");
  await source.query(readFileSync(new URL("../sql/approvals.sql", import.meta.url), "utf8"));
  await source.query("INSERT INTO evestack.approvals(session_id,request_id,option_id,approver,approver_via) VALUES('original','decision-1','deny','fixture','basic')");
  const actor = { approver: "fixture", via: "basic" };
  const memory = await import("../lib/memories.ts");
  const reviews = await import("../lib/memory-reviews.ts");
  const fact = await memory.getMemory("1");
  await reviews.reviewMemory("1", { hash: fact.hash, verdict: "stale", note: "Review history must survive a full restore." }, actor);
  await memory.deleteMemory("2", actor, (await memory.getMemory("2")).hash);
  const skills = await import("../lib/skill-reviews.ts");
  await skills.recordSkillReview("fixture-skill", "b".repeat(64), "c".repeat(64), "reviewed", "Read the fixture source.", actor);
  const routines = await import("../lib/routines.ts");
  const routine = await routines.saveRoutine({ name: "Paused fixture", prompt: "Read fixture only", cron: "0 9 * * *", timeZone: "America/Toronto", enabled: false }, actor);
  const run = await routines.runRoutineNow(routine.id, randomUUID(), actor);
  await source.query("UPDATE evestack.routine_runs SET state='unknown',error='Fixture lost acknowledgement' WHERE id=$1", [run.id]);
  await source.query("INSERT INTO evestack.routine_notifications(id,run_id,routine_id,event_key,sink_key,sink_kind,payload,state) VALUES($1,$2,$3,'unknown','fixture-hash','webhook','{}','failed')", [randomUUID(),run.id,routine.id]);
  await budget.saveBudgetSettings(url.href, { sessionUsd: 0, dailyUsd: 2, timeZone: "America/Toronto" }, 0, { actor: "fixture", via: "basic" });
  const cases = await import("../lib/regressions.ts");
  const { getTaskRecovery } = await import("../lib/task-recovery.ts");
  const caseId = randomUUID();
  await cases.createRegressionCase({ id: caseId, title: "Preserve the source", correction: "Cite the actual evidence in the response.", expected: "Include the inspected file and source reference.", baselineId: "original", baselineHash: cases.evidenceFingerprint(await getTaskRecovery("original")) }, actor);
  await cases.reviewRegressionCandidate(caseId, { id: randomUUID(), revision: 1, candidateId: "candidate", candidateHash: cases.evidenceFingerprint(await getTaskRecovery("candidate")), verdict: "needs_review", note: "Candidate is fixture data, not an executed evaluation." }, actor);

  const schemas = ["workflow", "workflow_drizzle", "graphile_worker", "evestack"];
  const ident = (name) => '"' + name.replaceAll('"', '""') + '"';
  async function inventory(db) {
    const tables = (await db.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1) ORDER BY schemaname,tablename", [schemas])).rows;
    const rows = {};
    for (const table of tables) {
      const name = `${ident(table.schemaname)}.${ident(table.tablename)}`;
      rows[name] = (await db.query(`SELECT to_jsonb(t)::text AS record FROM ${name} t ORDER BY record`)).rows;
    }
    const sequences = {};
    for (const seq of (await db.query("SELECT schemaname,sequencename FROM pg_sequences WHERE schemaname=ANY($1) ORDER BY schemaname,sequencename", [schemas])).rows) {
      const name = `${ident(seq.schemaname)}.${ident(seq.sequencename)}`;
      sequences[name] = (await db.query(`SELECT last_value,is_called FROM ${name}`)).rows;
    }
    const indexes = (await db.query("SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=ANY($1) ORDER BY schemaname,tablename,indexname", [schemas])).rows;
    const constraints = (await db.query("SELECT n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1) ORDER BY n.nspname,c.relname,k.conname", [schemas])).rows;
    return { rows, sequences, indexes, constraints };
  }
  function command(tool, database, args, input) {
    const container = process.env.EVESTACK_TEST_PG_CONTAINER;
    const env = { ...process.env, PGHOST: container ? "127.0.0.1" : base.hostname, PGPORT: container ? "5432" : base.port || "5432", PGUSER: decodeURIComponent(base.username), PGPASSWORD: decodeURIComponent(base.password), PGDATABASE: database, PGCONNECT_TIMEOUT: "10" };
    const exe = container ? "docker" : join(process.env.EVESTACK_TEST_PG_BIN, tool);
    const argv = container ? ["exec", "-i", ...["PGHOST","PGPORT","PGUSER","PGPASSWORD","PGDATABASE","PGCONNECT_TIMEOUT"].flatMap((key) => ["-e",key]), container, tool, ...args] : args;
    return spawnSync(exe, argv, { env, input, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  }
  const before = await inventory(source);
  assert.ok(Object.keys(before.rows).length >= 20, "all operator feature tables must be present");
  const dump = command("pg_dump", names[0], ["--format=custom", "--no-owner", "--no-privileges"]);
  assert.equal(dump.status, 0, dump.stderr?.toString());
  assert.equal(dump.stdout.subarray(0,5).toString(), "PGDMP");
  const archive = join(temp, "fixture.dump");
  writeFileSync(archive, dump.stdout, { mode: 0o600 });
  const list = command("pg_restore", names[1], ["--list"], readFileSync(archive));
  assert.equal(list.status, 0, list.stderr?.toString());
  assert.match(list.stdout.toString(), /routine_notifications/);
  const restoreArgs = ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges"];
  const result = command("pg_restore", names[1], [...restoreArgs, `--dbname=${names[1]}`], readFileSync(archive));
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.deepEqual(await inventory(restored), before);
  assert.deepEqual(await inventory(source), before, "a restore rehearsal must not modify the source");
  assert.equal((await restored.query("SELECT enabled FROM evestack.routines")).rows[0].enabled, false);
  assert.equal((await restored.query("SELECT state FROM evestack.routine_runs")).rows[0].state, "unknown");
  // Reapplying additive SQL preserves restored history and constraint identity.
  for (const file of ["routines", "approvals", "memory-audit", "regressions"]) {
    await restored.query(readFileSync(new URL(`../sql/${file}.sql`, import.meta.url), "utf8"));
  }
  assert.deepEqual(await inventory(restored), before);
  const broken = command("pg_restore", names[2], [...restoreArgs, `--dbname=${names[2]}`], dump.stdout.subarray(0, Math.floor(dump.stdout.length / 2)));
  assert.notEqual(broken.status, 0, "a truncated archive must fail");
  assert.equal(Object.keys((await inventory(damaged)).rows).length, 0, "single-transaction restore leaves no partial operator tables");
  t.diagnostic(`Compared all rows in ${Object.keys(before.rows).length} tables, ${Object.keys(before.sequences).length} sequences, indexes and constraints; no worker or model was started.`);
});
