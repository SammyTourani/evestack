import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import pg from "pg";
import { fileURLToPath, pathToFileURL } from "node:url";

// Creates and drops only its own disposable database. CI runs this against native PostgreSQL.
test(
  "routine durability, concurrency and ambiguous dispatch on PostgreSQL",
  { skip: !process.env.EVESTACK_TEST_POSTGRES_URL },
  async (t) => {
    const admin = new pg.Client({
      connectionString: process.env.EVESTACK_TEST_POSTGRES_URL,
    });
    await admin.connect();
    const name = `routine_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.EVESTACK_TEST_POSTGRES_URL);
    url.pathname = `/${name}`;
    const originalUrl = process.env.WORKFLOW_POSTGRES_URL;
    const originalSink = process.env.EVESTACK_ALERT_WEBHOOK_URL;
    process.env.EVESTACK_ALERT_WEBHOOK_URL = "";
    process.env.WORKFLOW_POSTGRES_URL = url.href;
    const { getPool, closePool } = await import("../lib/db.ts");
    const routines = await import("../lib/routines.ts");
    const { dispatchRoutineRun, tickRoutines } = await import(
      "../lib/routine-dispatcher.ts"
    );
    const actor = { approver: "fixture", via: "basic" };
    const input = {
      name: "Read-only fixture",
      prompt: "Report fixture state",
      cron: "* * * * *",
      timeZone: "UTC",
      enabled: false,
    };
    t.after(async () => {
      await closePool();
      if (originalSink === undefined)
        delete process.env.EVESTACK_ALERT_WEBHOOK_URL;
      else process.env.EVESTACK_ALERT_WEBHOOK_URL = originalSink;
      if (originalUrl === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
      else process.env.WORKFLOW_POSTGRES_URL = originalUrl;
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    });
    const db = () => getPool();
    const create = () => routines.saveRoutine(input, actor);
    const settle = async () => {
      await db().query(
        "UPDATE evestack.routine_runs SET state='completed',finished_at=now() WHERE state IN ('claimed','dispatching','running','awaiting_approval','unknown'); UPDATE evestack.routines SET enabled=false",
      );
    };
    async function enabled() {
      const routine = await create();
      await routines.runRoutineNow(routine.id, randomUUID(), actor);
      await settle();
      return routines.saveRoutine(
        {
          ...input,
          enabled: true,
          resultReviewed: true,
          revision: routine.revision,
        },
        actor,
        routine.id,
      );
    }
    await routines.ensureRoutines();
    // Use the pinned world's migrations: a text status fixture accepted values
    // that PostgreSQL's real workflow.status enum rejects during reconciliation.
    const templateRequire = createRequire(
      new URL("../../../templates/default/package.json", import.meta.url),
    );
    const cli = pathToFileURL(templateRequire.resolve("@workflow/world-postgres/cli")).href;
    const setup = spawnSync(process.execPath, [
      "--input-type=module", "--eval",
      `const { setupDatabase } = await import(${JSON.stringify(cli)}); await setupDatabase();`,
    ], { env: process.env, encoding: "utf8", timeout: 30000 });
    assert.equal(setup.status, 0, "The pinned workflow schema must bootstrap successfully");
    await db().query(
      "ALTER TABLE workflow.workflow_runs ALTER COLUMN name SET DEFAULT 'routine-fixture', ALTER COLUMN deployment_id SET DEFAULT 'routine-fixture'",
    );

    await t.test(
      "a terminal stream reconciles success and failed children with the real status enum",
      async () => {
        await settle();
        const server = createServer((_req, res) => {
          res.writeHead(200, {
            "content-type": "application/x-ndjson",
            "x-eve-stream-tail-index": "0",
          });
          res.end(JSON.stringify({ type: "session.completed", data: {} }) + "\n");
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const previous = process.env.EVESTACK_AGENT_URL;
        process.env.EVESTACK_AGENT_URL = `http://127.0.0.1:${server.address().port}`;
        try {
          for (const childStatus of ["completed", "failed", "cancelled"]) {
            const routine = await create();
            const run = await routines.runRoutineNow(routine.id, randomUUID(), actor);
            const session = `completion_${randomUUID()}`;
            await db().query(
              "UPDATE evestack.routine_runs SET state='running',session_id=$2 WHERE id=$1",
              [run.id, session],
            );
            await db().query(
              "INSERT INTO workflow.workflow_runs(id,status,attributes) VALUES($1,$2,$3)",
              [session + '_child', childStatus, JSON.stringify({ "$eve.root": session })],
            );
            await tickRoutines();
            const history = await routines.routineHistory(routine.id);
            assert.equal(history.runs[0].error, null);
            assert.equal(history.runs[0].state, childStatus === "completed" ? "completed" : "failed");
          }
        } finally {
          if (previous === undefined) delete process.env.EVESTACK_AGENT_URL;
          else process.env.EVESTACK_AGENT_URL = previous;
          await new Promise((resolve) => server.close(resolve));
          await settle();
        }
      },
    );
    await t.test(
      "new routines are paused and enabling requires a successful test",
      async () => {
        const routine = await create();
        assert.equal(routine.enabled, false);
        await assert.rejects(
          routines.saveRoutine(
            { ...input, enabled: true, resultReviewed: true, revision: 1 },
            actor,
            routine.id,
          ),
          /Run this prompt once/,
        );
      },
    );
    await t.test(
      "manual request retries share a durable id; a second run is refused",
      async () => {
        const routine = await create();
        const key = randomUUID();
        const [a, b] = await Promise.all([
          routines.runRoutineNow(routine.id, key, actor),
          routines.runRoutineNow(routine.id, key, actor),
        ]);
        assert.equal(a.id, b.id);
        await assert.rejects(
          routines.runRoutineNow(routine.id, randomUUID(), actor),
          /already has an active/,
        );
        await settle();
      },
    );
    await t.test(
      "two separate processes claim one scheduled occurrence",
      async () => {
        const routine = await enabled();
        await db().query(
          "UPDATE evestack.routines SET next_due=now()-interval '2 minutes' WHERE id=$1",
          [routine.id],
        );
        const worker = () =>
          new Promise((resolve, reject) => {
            const code =
              "const {claimDueRoutine}=await import('./lib/routines.ts');const {closePool}=await import('./lib/db.ts');console.log(JSON.stringify(await claimDueRoutine()));await closePool();";
            const child = spawn(
              process.execPath,
              [
                "--import",
                "./test/register-ts-resolve.mjs",
                "--input-type=module",
                "-e",
                code,
              ],
              {
                cwd: fileURLToPath(new URL("..", import.meta.url)),
                env: { ...process.env },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let out = "",
              err = "";
            child.stdout.on("data", (d) => (out += d));
            child.stderr.on("data", (d) => (err += d));
            child.on("error", reject);
            child.on("exit", (c) =>
              c === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)),
            );
          });
        const claims = (await Promise.all([worker(), worker()])).filter(
          Boolean,
        );
        assert.equal(claims.length, 1);
        assert.equal(claims[0].routine_id, routine.id);
        assert.equal(claims[0].trigger, "catchup");
        assert.ok(claims[0].snapshot.catchupFrom);
        const results = await Promise.all(
          claims.flatMap((run) => [
            routines.beginRoutineDispatch(run),
            routines.beginRoutineDispatch(run),
          ]),
        );
        assert.equal(results.filter(Boolean).length, 1);
        await settle();
      },
    );
    await t.test(
      "a pause before dispatch retires the claim without sending",
      async () => {
        const routine = await enabled();
        await db().query(
          "UPDATE evestack.routines SET next_due=now()-interval '1 minute' WHERE id=$1",
          [routine.id],
        );
        const run = await routines.claimDueRoutine();
        await routines.saveRoutine(
          { ...input, revision: routine.revision, enabled: false },
          actor,
          routine.id,
        );
        assert.equal(await routines.beginRoutineDispatch(run), false);
        assert.equal(
          (
            await db().query(
              "SELECT state FROM evestack.routine_runs WHERE id=$1",
              [run.id],
            )
          ).rows[0].state,
          "skipped",
        );
      },
    );
    await t.test(
      "stale edits are rejected and the accepted revision is audited",
      async () => {
        const routine = await create();
        await routines.saveRoutine(
          { ...input, revision: 1, name: "Updated" },
          actor,
          routine.id,
        );
        await assert.rejects(
          routines.saveRoutine({ ...input, revision: 1 }, actor, routine.id),
          /changed in another window/,
        );
        assert.equal(
          (
            await db().query(
              "SELECT count(*)::int n FROM evestack.routine_audit WHERE routine_id=$1",
              [routine.id],
            )
          ).rows[0].n,
          2,
        );
      },
    );
    await t.test(
      "accepted-but-lost HTTP response remains unknown and is never dispatched twice",
      async () => {
        await settle();
        let sends = 0;
        const server = createServer((req) => {
          sends++;
          req.socket.destroy();
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const before = process.env.EVESTACK_AGENT_URL;
        process.env.EVESTACK_AGENT_URL = `http://127.0.0.1:${server.address().port}`;
        try {
          const routine = await create();
          const run = await routines.runRoutineNow(
            routine.id,
            randomUUID(),
            actor,
          );
          await dispatchRoutineRun(run);
          await dispatchRoutineRun(run);
          assert.equal(sends, 1);
          const history = await routines.routineHistory(routine.id);
          assert.equal(history.runs[0].state, "unknown");
          assert.equal(history.routine.enabled, false);
          const audit = (
            await db().query(
              "SELECT action,actor_via FROM evestack.routine_audit WHERE routine_id=$1 ORDER BY id DESC LIMIT 1",
              [routine.id],
            )
          ).rows[0];
          assert.equal(audit.action, `dispatch-uncertain:${run.id}`);
          assert.equal(audit.actor_via, "dispatcher");
          await assert.rejects(
            routines.runRoutineNow(routine.id, randomUUID(), actor),
            /uncertain run/,
          );
        } finally {
          if (before === undefined) delete process.env.EVESTACK_AGENT_URL;
          else process.env.EVESTACK_AGENT_URL = before;
          await new Promise((resolve) => server.close(resolve));
        }
        await settle();
      },
    );
    await t.test(
      "a crashed dispatch becomes unknown and pauses its routine",
      async () => {
        const routine = await enabled();
        const run = await routines.runRoutineNow(
          routine.id,
          randomUUID(),
          actor,
        );
        await routines.beginRoutineDispatch(run);
        await db().query(
          "UPDATE evestack.routine_runs SET updated_at=now()-interval '3 minutes' WHERE id=$1",
          [run.id],
        );
        await tickRoutines();
        const history = await routines.routineHistory(routine.id);
        assert.equal(
          history.runs.find((row) => row.id === run.id).state,
          "unknown",
        );
        assert.equal(history.routine.enabled, false);
        await routines.resolveUncertainRoutineRun(
          routine.id,
          run.id,
          "Checked all recent tasks; no task remains active.",
          actor,
        );
        const resolved = await routines.routineHistory(routine.id);
        assert.equal(
          resolved.runs.find((row) => row.id === run.id).state,
          "resolved",
        );
        assert.equal(resolved.routine.enabled, false);
      },
    );
    await t.test(
      "a failed uncertainty audit rolls back both state and pause",
      async () => {
        await settle();
        const routine = await enabled();
        const run = await routines.runRoutineNow(
          routine.id,
          randomUUID(),
          actor,
        );
        await routines.beginRoutineDispatch(run);
        await db().query(
          "CREATE FUNCTION evestack.reject_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$; CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON evestack.routine_audit FOR EACH ROW EXECUTE FUNCTION evestack.reject_fixture_audit()",
        );
        try {
          await assert.rejects(
            routines.markRoutineDispatchUncertain(run, "fixture"),
            /fixture audit failure/,
          );
          const history = await routines.routineHistory(routine.id);
          assert.equal(history.routine.enabled, true);
          assert.equal(
            history.runs.find((row) => row.id === run.id).state,
            "dispatching",
          );
        } finally {
          await db().query(
            "DROP TRIGGER fixture_audit_failure ON evestack.routine_audit; DROP FUNCTION evestack.reject_fixture_audit()",
          );
          await settle();
        }
      },
    );
    await t.test(
      "successful dispatch reconciles pending input and preserves cancellation as failure",
      async () => {
        await settle();
        let phase = "waiting";
        let sends = 0;
        const id = `session_${randomUUID()}`;
        const server = createServer((req, res) => {
          if (req.method === "POST") {
            sends++;
            res.writeHead(202, { "content-type": "application/json" });
            res.end(JSON.stringify({ sessionId: id }));
            return;
          }
          const events =
            phase === "waiting"
              ? [
                  { type: "turn.started", data: { turnId: "turn_fixture" } },
                  {
                    type: "input.requested",
                    data: {
                      requests: [
                        {
                          requestId: "approve_fixture",
                          kind: "tool-approval",
                          prompt: "Inspect this proposed effect",
                          options: [
                            { id: "approve", label: "Approve" },
                            { id: "deny", label: "Deny" },
                          ],
                          allowFreeform: false,
                        },
                      ],
                    },
                  },
                  {
                    type: "session.waiting",
                    data: { continuationToken: "fixture-token" },
                  },
                ]
              : [
                  { type: "turn.cancelled", data: {} },
                  { type: "session.completed", data: {} },
                ];
          res.writeHead(200, {
            "content-type": "application/x-ndjson",
            "x-eve-stream-tail-index": String(events.length - 1),
          });
          res.end(
            events.map((event) => JSON.stringify(event)).join("\n") + "\n",
          );
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const before = process.env.EVESTACK_AGENT_URL;
        process.env.EVESTACK_AGENT_URL = `http://127.0.0.1:${server.address().port}`;
        try {
          const routine = await create();
          const run = await routines.runRoutineNow(
            routine.id,
            randomUUID(),
            actor,
          );
          await dispatchRoutineRun(run);
          assert.equal(sends, 1);
          await db().query(
            "INSERT INTO workflow.workflow_runs(id,status,attributes) VALUES($1,'running',$2)",
            [
              id,
              JSON.stringify({
                "$eve.type": "session",
                "$eve.title": "Fixture pending task",
              }),
            ],
          );
          await tickRoutines();
          let history = await routines.routineHistory(routine.id);
          assert.equal(history.runs[0].state, "awaiting_approval");
          assert.equal(history.runs[0].session_id, id);
          const { listPendingDecisions } = await import(
            "../lib/pending-decisions.ts"
          );
          const queue = await listPendingDecisions();
          assert.equal(queue.items[0].request.requestId, "approve_fixture");
          assert.equal(queue.unknown.length, 0);
          await assert.rejects(
            routines.runRoutineNow(routine.id, randomUUID(), actor),
            /active/,
          );
          phase = "cancelled";
          await tickRoutines();
          history = await routines.routineHistory(routine.id);
          assert.equal(history.runs[0].state, "failed");
          await assert.rejects(
            routines.saveRoutine(
              {
                ...input,
                enabled: true,
                resultReviewed: true,
                revision: routine.revision,
              },
              actor,
              routine.id,
            ),
            /Run this prompt once/,
          );
        } finally {
          if (before === undefined) delete process.env.EVESTACK_AGENT_URL;
          else process.env.EVESTACK_AGENT_URL = before;
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
    await t.test("database outage cannot start an unclaimed task", async () => {
      await closePool();
      process.env.WORKFLOW_POSTGRES_URL =
        "postgres://fixture:fixture@127.0.0.1:1/unavailable";
      try {
        await assert.rejects(routines.claimDueRoutine());
      } finally {
        await closePool();
        process.env.WORKFLOW_POSTGRES_URL = url.href;
      }
    });
    await t.test(
      "saved budget revisions reach the enforcing hook and lowering a cap blocks the next turn",
      async () => {
        const settings = await import("@evestack/budget/settings");
        const { resolveConfig } = await import(
          "../../evestack-budget/dist/config.js"
        );
        const { budgetHook } = await import(
          "../../evestack-budget/dist/hook.js"
        );
        const { closeSpendStore } = await import(
          "../../evestack-budget/dist/store.js"
        );
        const config = resolveConfig({
          databaseUrl: url.href,
          dashboardControls: true,
          model: "openai/gpt-5-mini",
        });
        const identity = { actor: "fixture", via: "basic" };
        try {
          assert.equal(
            (await settings.readBudgetSettings(url.href)).settings,
            null,
          );
          await settings.saveBudgetSettings(
            url.href,
            { sessionUsd: 0, dailyUsd: 10, timeZone: "UTC" },
            0,
            identity,
          );
          const current = await settings.runtimeBudgetConfig(config);
          assert.equal(current.sessionUsd, 0);
          assert.equal(current.mode, "fail");
          assert.equal(current.failClosed, true);
          let view = await settings.readBudgetSettings(url.href);
          assert.equal(view.consumers[0].revision, 1);
          assert.equal(view.consumers[0].observed.model, "openai/gpt-5-mini");
          assert.doesNotMatch(
            JSON.stringify(view.consumers),
            /databaseUrl|authPassword|authUser/,
          );
          const hook = budgetHook(config);
          const ctx = {
            session: {
              id: "budget_fixture",
              auth: { current: { principalId: "fixture" } },
            },
          };
          const event = { data: { turnId: "turn_budget_fixture" } };
          await assert.rejects(
            hook.events["turn.started"](event, ctx),
            /before it called the model/,
          );
          await settings.saveBudgetSettings(
            url.href,
            { sessionUsd: 2, dailyUsd: 10, timeZone: "UTC" },
            1,
            identity,
          );
          await assert.doesNotReject(hook.events["turn.started"](event, ctx));
          view = await settings.readBudgetSettings(url.href);
          assert.equal(view.consumers[0].revision, 2);
          const { readBudgetPolicy } = await import("../lib/budget-policy.ts");
          const policy = await readBudgetPolicy();
          assert.equal(policy.configuration.source, "saved");
          assert.equal(policy.configuration.revision, 2);
          assert.equal(policy.limits.sessionUsd, 2);
          assert.equal(policy.limits.unpricedModel, "stop");
          await assert.rejects(
            settings.saveBudgetSettings(
              url.href,
              { sessionUsd: 3, dailyUsd: 10, timeZone: "UTC" },
              1,
              identity,
            ),
            /changed in another window/,
          );
          const audit = (
            await db().query(
              "SELECT count(*)::int n FROM evestack.budget_settings_audit",
            )
          ).rows[0].n;
          assert.equal(audit, 2);
          const unavailable = {
            ...config,
            databaseUrl: "postgres://fixture:fixture@127.0.0.1:1/unavailable",
          };
          await assert.rejects(settings.runtimeBudgetConfig(unavailable));
        } finally {
          await settings.closeBudgetSettingsPools();
          await closeSpendStore();
        }
      },
    );
    await t.test(
      "task detail reads the latest 500 runs and labels the history window",
      async () => {
        const id = `bounded_${randomUUID()}`;
        await db().query(
          "INSERT INTO workflow.workflow_runs(id,status,attributes) VALUES($1,'completed',$2)",
          [
            id,
            JSON.stringify({
              "$eve.type": "session",
              "$eve.title": "Long task fixture",
            }),
          ],
        );
        await db().query(
          `INSERT INTO workflow.workflow_runs(id,status,attributes,created_at,completed_at)
      SELECT $1 || '_' || lpad(n::text,4,'0'),'completed',jsonb_build_object('$eve.type','turn','$eve.root',$1::text,'$eve.parent',$1::text),timestamp '2026-01-01' + n * interval '1 minute',timestamp '2026-01-01' + n * interval '1 minute'
      FROM generate_series(1,550) n`,
          [id],
        );
        const { getTask } = await import("../lib/tasks.ts");
        const task = await getTask(id);
        assert.equal(task.session.title, "Long task fixture");
        assert.equal(task.runs.length, 500);
        assert.equal(task.runsTruncated, true);
        assert.equal(task.runsWindow, "latest");
        assert.ok(task.runs.some((run) => run.id === `${id}_0550`));
        assert.ok(!task.runs.some((run) => run.id === `${id}_0001`));
        assert.equal(await getTask("missing_task_fixture"), null);
      },
    );
    await t.test(
      "routine notifications deduplicate claims, retry with a stable ID, and audit manual retries",
      async () => {
        const notifications = await import("../lib/routine-notifications.ts");
        let requests = [];
        let refuse = false;
        const receiver = createServer((req, res) => {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            requests.push({
              id: req.headers["x-evestack-notification-id"],
              body: JSON.parse(body),
            });
            if (requests.length === 1) {
              req.socket.destroy();
              return;
            }
            res.writeHead(refuse ? 503 : 200).end("fixture");
          });
        });
        await new Promise((resolve) =>
          receiver.listen(0, "127.0.0.1", resolve),
        );
        process.env.EVESTACK_ALERT_WEBHOOK_URL = `http://127.0.0.1:${receiver.address().port}/fixture-secret`;
        try {
          await settle();
          const routine = await create();
          const run = await routines.runRoutineNow(
            routine.id,
            randomUUID(),
            actor,
          );
          const completed = {
            ...run,
            state: "completed",
            session_id: "notification-task",
          };
          await Promise.all([
            routines.routineTransaction((client) =>
              notifications.queueRoutineNotification(client, completed),
            ),
            routines.routineTransaction((client) =>
              notifications.queueRoutineNotification(client, completed),
            ),
          ]);
          let history = await notifications.routineNotificationHistory(
            routine.id,
          );
          assert.equal(history.length, 1);
          await Promise.all([
            notifications.deliverRoutineNotifications(),
            notifications.deliverRoutineNotifications(),
          ]);
          assert.equal(requests.length, 1);
          history = await notifications.routineNotificationHistory(routine.id);
          assert.equal(history[0].state, "pending");
          await db().query(
            "UPDATE evestack.routine_notifications SET next_attempt=now()-interval '1 second' WHERE id=$1",
            [history[0].id],
          );
          await Promise.all([
            notifications.deliverRoutineNotifications(),
            notifications.deliverRoutineNotifications(),
          ]);
          await notifications.deliverRoutineNotifications();
          assert.equal(requests.length, 2);
          assert.equal(requests[0].id, requests[1].id);
          assert.equal(requests[1].body.sessionId, "notification-task");
          assert.doesNotMatch(
            JSON.stringify(requests[1].body),
            /fixture-secret|Report fixture state/,
          );
          history = await notifications.routineNotificationHistory(routine.id);
          assert.equal(history[0].state, "sent");
          await routines.routineTransaction(async (client) => {
            await notifications.queueRoutineNotification(
              client,
              { ...run, state: "awaiting_approval" },
              ["decision-a"],
            );
            await notifications.queueRoutineNotification(
              client,
              { ...run, state: "awaiting_approval" },
              ["decision-a"],
            );
            await notifications.queueRoutineNotification(
              client,
              { ...run, state: "awaiting_approval" },
              ["decision-b"],
            );
          });
          history = await notifications.routineNotificationHistory(routine.id);
          assert.equal(history.length, 3);
          const pending = history.find((row) => row.state === "pending");
          await db().query(
            "UPDATE evestack.routine_notifications SET attempts=4 WHERE id=$1",
            [pending.id],
          );
          refuse = true;
          await notifications.deliverRoutineNotifications();
          history = await notifications.routineNotificationHistory(routine.id);
          assert.equal(
            history.find((row) => row.id === pending.id).state,
            "failed",
          );
          await routines.retryRoutineNotification(
            routine.id,
            pending.id,
            actor,
          );
          await assert.rejects(
            routines.retryRoutineNotification(routine.id, pending.id, actor),
            /Only a failed notification/,
          );
          refuse = false;
          await notifications.deliverRoutineNotifications();
          history = await notifications.routineNotificationHistory(routine.id);
          assert.equal(
            history.find((row) => row.id === pending.id).state,
            "sent",
          );
          const audit = await db().query(
            "SELECT action FROM evestack.routine_audit WHERE routine_id=$1 AND action=$2",
            [routine.id, `notification-retry:${pending.id}`],
          );
          assert.equal(audit.rows.length, 1);
          process.env.EVESTACK_ALERT_WEBHOOK_URL = "";
          const count = requests.length;
          await db().query(
            "UPDATE evestack.routine_notifications SET next_attempt=now()-interval '1 second' WHERE state='pending'",
          );
          await notifications.deliverRoutineNotifications();
          assert.equal(requests.length, count);
        } finally {
          process.env.EVESTACK_ALERT_WEBHOOK_URL = "";
          await new Promise((resolve) => receiver.close(resolve));
          await settle();
        }
      },
    );
  },
);
