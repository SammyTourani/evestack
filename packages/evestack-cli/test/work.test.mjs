import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  tasks,
  routines,
  readiness,
  dashboardRequest,
  dashboardSettings,
  routeSegment,
} from "../src/work.mjs";
import { main } from "../src/cli.mjs";

const password = "fixture-only-password";
const settings = (base) =>
  dashboardSettings(
    (key) =>
      ({
        EVESTACK_PUBLIC_URL: base,
        EVESTACK_AUTH_USER: "operator",
        EVESTACK_AUTH_PASSWORD: password,
      })[key],
  );
const sink = () => ({
  text: "",
  write(value) {
    this.text += value;
    return true;
  },
});
const json = (res, value, status = 200) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));

async function fixture(run) {
  const seen = [];
  let handle = (_req, res) =>
    json(res, { ok: true, tasks: [], nextCursor: null });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    });
    handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cwd = mkdtempSync(join(tmpdir(), "evestack-work-"));
  writeFileSync(
    join(cwd, ".env.local"),
    `EVESTACK_PUBLIC_URL=${base}\nEVESTACK_AUTH_USER=operator\nEVESTACK_AUTH_PASSWORD=${password}\n`,
  );
  const invoke = async (fn, args) => {
    const stdout = sink(),
      stderr = sink();
    return {
      code: await fn(args, { cwd, stdout, stderr }),
      stdout: stdout.text,
      stderr: stderr.text,
    };
  };
  try {
    await run({
      base,
      cwd,
      seen,
      invoke,
      respond: (fn) => {
        handle = fn;
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("dashboard credentials use a validated origin and never allow remote plaintext or URL credentials", () => {
  assert.equal(
    settings("http://localhost:4000/api/ingest/v1/traces").base,
    "http://localhost:4000",
  );
  assert.equal(settings("http://[::1]:4000").base, "http://[::1]:4000");
  assert.equal(
    settings("https://stack.example.test").base,
    "https://stack.example.test",
  );
  for (const url of [
    "http://stack.example.test",
    "https://u:p@stack.example.test",
    "file:///tmp/secret",
    "garbage",
  ])
    assert.throws(() => settings(url));
  assert.throws(
    () => dashboardSettings(() => undefined),
    /username and password/,
  );
  assert.throws(() =>
    dashboardSettings(
      (key) =>
        ({ EVESTACK_AUTH_USER: "bad:user", EVESTACK_AUTH_PASSWORD: password })[
          key
        ],
    ),
  );
  assert.equal(
    dashboardSettings(
      (key) =>
        ({
          EVESTACK_DASHBOARD_URL: "http://127.0.0.1:8000/api/ingest",
          EVESTACK_AUTH_PASSWORD: password,
        })[key],
    ).base,
    "http://127.0.0.1:8000",
  );
});

test("route ids cannot normalize into another route", () => {
  assert.equal(routeSegment("task/a?b#c"), "task%2Fa%3Fb%23c");
  for (const id of [".", "..", "", null, "x\n", "a".repeat(301)])
    assert.throws(() => routeSegment(id));
});

test("task list preserves cursors and search and sends Basic authentication with its actual origin", async () =>
  fixture(async ({ base, seen, respond, invoke }) => {
    respond((_req, res) =>
      json(res, {
        ok: true,
        tasks: [
          {
            id: "task/1",
            outcome: "completed",
            title: "Useful\u001b[31m title",
          },
        ],
        nextCursor: "cursor+/=",
      }),
    );
    const result = await invoke(tasks, [
      "--limit=7",
      "--search=a&b",
      "--cursor=before+/=",
    ]);
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes("\u001b"));
    assert.match(result.stdout, /chat\?session=task%2F1/);
    assert.match(result.stdout, /Next cursor: cursor\+\//);
    const url = new URL(seen[0].url, base);
    assert.equal(url.searchParams.get("q"), "a&b");
    assert.equal(url.searchParams.get("cursor"), "before+/=");
    assert.equal(url.searchParams.get("limit"), "7");
    assert.equal(seen[0].headers.authorization, settings(base).authorization);
    assert.equal(seen[0].headers.origin, base);
    assert.ok(!result.stdout.includes(password));
  }));

test("read-only commands retain evidence coverage and use shared dashboard routes", async () =>
  fixture(async ({ seen, invoke, respond }) => {
    const recovery = {
      ok: true,
      recovery: { coverage: { turns: { truncated: true } } },
      evidenceHash: "hash",
    };
    respond((_req, res) => json(res, recovery));
    assert.deepEqual(
      JSON.parse(
        (await invoke(tasks, ["recovery", "task/x", "--json"])).stdout,
      ),
      recovery,
    );
    assert.equal(seen.at(-1).url, "/api/tasks/task%2Fx/recovery");
    respond((_req, res) =>
      json(res, {
        ok: true,
        task: {
          session: { id: "one", title: "First", status: "idle" },
          runs: [{}],
          runsTruncated: true,
        },
      }),
    );
    assert.match((await invoke(tasks, ["one"])).stdout, /older runs omitted/);
    respond((_req, res) =>
      json(res, {
        ok: true,
        routines: [{ id: "routine-one", name: "Brief", enabled: false }],
        clock: { running: false },
      }),
    );
    const listing = await invoke(routines, []);
    assert.match(listing.stdout, /paused/);
    assert.match(listing.stdout, /\/routines\n/);
    assert.doesNotMatch(listing.stdout, /\/routines\/routine-one/);
    respond((_req, res) =>
      json(res, {
        ok: true,
        routine: { id: "routine-one" },
        runs: [],
        clock: { running: false },
      }),
    );
    assert.equal(
      JSON.parse((await invoke(routines, ["routine-one", "--json"])).stdout)
        .clock.running,
      false,
    );
    assert.equal(seen.at(-1).url, "/api/routines/routine-one");
    respond((_req, res) =>
      json(res, {
        ok: true,
        checks: [
          {
            name: "Model",
            status: "unknown",
            ready: false,
            detail: "Run a real task.",
          },
        ],
      }),
    );
    assert.match(
      (await invoke(readiness, ["--check=model"])).stdout,
      /Model: unknown/,
    );
    assert.equal(seen.at(-1).url, "/api/readiness?check=model");
    assert.ok(seen.every((request) => request.method === "GET"));
  }));

test("start, reply and stop report acceptance without claiming completion and never retry", async () =>
  fixture(async ({ cwd, seen, invoke, respond }) => {
    writeFileSync(
      join(cwd, "message.txt"),
      "Review the repository. Literal $(example) and `text`.",
    );
    respond((_req, res) =>
      json(res, { ok: true, sessionId: "task-1", status: "accepted" }, 202),
    );
    for (const args of [
      ["start", "--message-file=message.txt"],
      ["reply", "task-1", "--message-file=message.txt"],
      ["stop", "task-1"],
    ]) {
      const result = await invoke(tasks, args);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /does not confirm/);
      assert.match(result.stdout, /session=task-1/);
    }
    assert.equal(seen.length, 3);
    assert.deepEqual(
      seen.map((r) => r.url),
      [
        "/api/control/sessions",
        "/api/control/sessions/task-1/message",
        "/api/control/sessions/task-1/cancel",
      ],
    );
    assert.equal(
      seen[0].body.message,
      "Review the repository. Literal $(example) and `text`.",
    );
    assert.deepEqual(seen[2].body, {});
    respond((req) => req.socket.destroy());
    const uncertain = await invoke(tasks, [
      "start",
      "--message-file=message.txt",
      "--json",
    ]);
    assert.equal(uncertain.code, 1);
    assert.equal(JSON.parse(uncertain.stdout).delivery, "unknown");
    assert.equal(seen.length, 4);
    respond((_req, res) => json(res, { ok: true }, 202));
    assert.equal(
      JSON.parse((await invoke(tasks, ["stop", "task-1", "--json"])).stdout)
        .delivery,
      "unknown",
    );
  }));

test("unsupported, repeated and mismatched flags and invalid files cause no request", async () =>
  fixture(async ({ cwd, seen, invoke }) => {
    const invalid = [
      ["--limit=0"],
      ["--limit=101"],
      ["--limit=3", "--limit=4"],
      ["--search=" + "x".repeat(201)],
      ["start", "--message-file=missing"],
      ["start"],
      ["stop", "id", "--search=ignored"],
      ["id", "--limit=3"],
      ["--check=agent"],
      ["--surprise"],
      ["recovery", ".."],
    ];
    for (const args of invalid) {
      const result = await invoke(tasks, [...args, "--json"]);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stdout).delivery, "not_sent");
    }
    for (const bytes of [
      Buffer.alloc(65537),
      Buffer.from([255]),
      Buffer.from("  "),
    ]) {
      writeFileSync(join(cwd, "bad.txt"), bytes);
      assert.equal(
        (await invoke(tasks, ["start", "--message-file=bad.txt"])).code,
        1,
      );
    }
    assert.equal((await invoke(readiness, ["--check=unexpected"])).code, 1);
    assert.equal((await invoke(routines, ["--cursor=ignored"])).code, 1);
    assert.equal(seen.length, 0);
  }));

test("a redirect is never followed and arbitrary origins never receive credentials", async () =>
  fixture(async ({ base, seen, respond }) => {
    respond((_req, res) =>
      res.writeHead(302, { location: base + "/api/target" }).end(),
    );
    await assert.rejects(
      dashboardRequest(settings(base), "/api/tasks"),
      /redirected/,
    );
    assert.equal(seen.length, 1);
    await assert.rejects(
      dashboardRequest(settings(base), "https://elsewhere.invalid/api/tasks"),
      /Only this dashboard/,
    );
    await assert.rejects(
      dashboardRequest(settings(base), "/not-an-api"),
      /Only this dashboard/,
    );
    assert.equal(seen.length, 1);
  }));

test("HTTP failures redact credentials and retain rejected versus uncertain delivery", async () =>
  fixture(async ({ base, respond, seen }) => {
    respond((_req, res) =>
      json(
        res,
        {
          ok: false,
          error: `Bad ${password} ${settings(base).authorization}\u001b[31m`,
        },
        401,
      ),
    );
    await assert.rejects(
      dashboardRequest(settings(base), "/api/control/sessions", {
        method: "POST",
        body: {},
      }),
      (error) =>
        error.delivery === "rejected" &&
        !error.message.includes(password) &&
        !error.message.includes(settings(base).authorization) &&
        !error.message.includes("\u001b"),
    );
    respond((_req, res) =>
      json(res, { ok: false, error: "Agent response lost" }, 502),
    );
    await assert.rejects(
      dashboardRequest(settings(base), "/api/control/sessions", {
        method: "POST",
        body: {},
      }),
      (error) => error.delivery === "unknown",
    );
    respond((_req, res) =>
      json(
        res,
        {
          ok: false,
          error: "A different task was started",
          startedSessionId: "unexpected-task",
        },
        409,
      ),
    );
    await assert.rejects(
      dashboardRequest(settings(base), "/api/control/sessions/task/message", {
        method: "POST",
        body: {},
      }),
      (error) => error.delivery === "unknown",
    );
    respond((_req, res) => res.writeHead(200).end("<html>Login</html>"));
    await assert.rejects(
      dashboardRequest(settings(base), "/api/tasks"),
      /unreadable response/,
    );
    assert.equal(seen.length, 4);
  }));

test("both declared and streamed responses are bounded and a timeout does not retry a mutation", async () =>
  fixture(async ({ base, respond, seen }) => {
    respond((_req, res) =>
      res.writeHead(200, { "content-length": 3 * 1024 * 1024 }).end("x"),
    );
    await assert.rejects(
      dashboardRequest(settings(base), "/api/tasks"),
      /2 MiB/,
    );
    respond((_req, res) => {
      res.writeHead(200);
      res.write("x".repeat(2 * 1024 * 1024));
      res.end("x");
    });
    await assert.rejects(
      dashboardRequest(settings(base), "/api/tasks"),
      /2 MiB/,
    );
    respond(() => {});
    await assert.rejects(
      dashboardRequest(settings(base), "/api/control/sessions", {
        method: "POST",
        body: {},
        timeoutMs: 50,
      }),
      (error) => error.delivery === "unknown",
    );
    assert.equal(seen.length, 3);
  }));

test("top-level routing reaches each work command and help requires no project", async () => {
  for (const command of ["tasks", "routines", "readiness"]) {
    const stdout = sink(),
      stderr = sink();
    assert.equal(
      await main([command, "--help"], { cwd: tmpdir(), stdout, stderr }),
      0,
    );
    assert.match(stdout.text, /dashboard's authenticated API/);
    assert.equal(stderr.text, "");
  }
});
