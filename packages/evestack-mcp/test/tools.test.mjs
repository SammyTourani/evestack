import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { McpServer } from "../dist/server.js";
import { MAX_OUTPUT_BYTES_ENV } from "../dist/truncate.js";

/**
 * What the tool layer puts on the wire, and what it refuses to put in a result.
 *
 * Three things live here that truncate.test.mjs is the wrong home for:
 *
 *  1. promote_session_to_eval is the one tool that FAILS instead of truncating.
 *     Its result is a TypeScript file the caller is told to save, and half a
 *     TypeScript file does not compile.
 *  2. An explicit `null` argument means the same thing as an absent one —
 *     schema.ts:95-99 says so, and the validator honours it. These prove the
 *     request that reaches the dashboard honours it too.
 *  3. /api/approvals reports whether IT truncated, which is a different
 *     truncation from this server's byte cap and has to survive the trip.
 *
 * All three need the whole stack, so all three use a loopback `node:http`
 * dashboard that records exactly what it was sent.
 */

const SESSION_ID = "wrun_01KZ8CQ5012M1M9P6YE7YG3FJ3";
const started = [];
after(() => {
  for (const server of started) server.close();
});

/** A generated eval of roughly `chars` characters, in the shape lib/promote-eval.ts emits. */
function evalSource(chars) {
  let source = `import { defineEval } from "eve/evals";\n\nexport default defineEval({\n  async test(t) {\n`;
  for (let i = 0; source.length < chars; i++) {
    source +=
      `    const turn${i} = await t.send("turn ${i}: run the pending migration and report the row count");\n` +
      `    turn${i}.calledTool("shell.exec");\n    turn${i}.succeeded();\n`;
  }
  return `${source}  },\n});\n`;
}

/**
 * Answers every route the tools use, and remembers each request.
 * `evalChars` sizes what /api/evals/promote returns.
 */
async function dashboard({
  evalChars = 400,
  env = {},
  approvalsBody = null,
  approveBody = null,
  routes = {},
} = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      // `headers` so the auth tests at the bottom can read what actually left
      // this process. Recording the request and asserting on a config object
      // instead is how a header that is never set passes its own test.
      seen.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        body: raw,
        headers: req.headers,
      });
      const answer =
        routes[url.pathname] ??
        (url.pathname.startsWith("/api/evals/promote/")
          ? {
              filename: `${SESSION_ID}.eval.ts`,
              source: evalSource(evalChars),
              warnings: [],
            }
          : url.pathname === "/api/approvals" && approvalsBody
            ? approvalsBody
            : url.pathname.endsWith("/approve") && approveBody
              ? approveBody
              : {
                  ok: true,
                  tasks: [],
                  nextCursor: null,
                  approvals: [],
                  count: 0,
                  sessionId: SESSION_ID,
                  answered: [],
                  audited: true,
                });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  started.push(server);

  const mcp = new McpServer(
    loadConfig({
      EVESTACK_MCP_DASHBOARD_URL: `http://127.0.0.1:${server.address().port}`,
      EVESTACK_MCP_ALLOW_CONTROL: "1",
      EVESTACK_MCP_ALLOW_APPROVALS: "1",
      ...env,
    }),
  );
  await mcp.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      clientInfo: { name: "tools-test", version: "1" },
    },
  });

  const call = async (name, args) => {
    const { response } = await mcp.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return response;
  };
  return { call, seen, last: () => seen.at(-1) };
}

test("task search and cursor use the task API and retain pagination", async () => {
  const { call, last } = await dashboard({
    routes: {
      "/api/tasks": {
        tasks: [{ id: "older-task", title: "Release checklist" }],
        nextCursor: "next-page",
      },
    },
  });
  const response = await call("list_sessions", {
    q: "release & review",
    cursor: "prior/page",
    limit: 7,
  });
  assert.equal(response.isError, false);
  assert.equal(response.structuredContent.sessions[0].id, "older-task");
  assert.equal(response.structuredContent.nextCursor, "next-page");
  assert.equal(last().path, "/api/tasks");
  const query = new URLSearchParams(last().search);
  assert.equal(query.get("q"), "release & review");
  assert.equal(query.get("cursor"), "prior/page");
  assert.equal(query.get("limit"), "7");
});
test("task detail preserves bounded history and budget activation provenance", async () => {
  const configuration = { source: "saved", revision: 3, consumers: [] };
  const { call } = await dashboard({
    routes: {
      [`/api/tasks/${SESSION_ID}`]: {
        task: {
          session: { id: SESSION_ID },
          runs: [{ id: "turn-1" }],
          runsTruncated: true,
          runsWindow: "latest",
          evidenceUrl: "/sessions/fixture",
        },
      },
      "/api/budget": {
        ok: true,
        configuration,
        session: { costUsd: 1 },
        limits: { sessionUsd: 2 },
      },
    },
  });
  const response = await call("get_session", { sessionId: SESSION_ID });
  assert.equal(response.isError, false);
  assert.equal(response.structuredContent.rollup.id, SESSION_ID);
  assert.equal(response.structuredContent.runs[0].id, "turn-1");
  assert.equal(response.structuredContent.runsTruncated, true);
  assert.deepEqual(
    response.structuredContent.budgetConfiguration,
    configuration,
  );
});
test("missing budget data is unavailable, not a healthy empty spend report", async () => {
  const { call } = await dashboard({
    routes: { "/api/budget": { ok: false, error: "No budget data yet" } },
  });
  const costs = await call("get_costs", {});
  assert.equal(costs.isError, true);
  assert.match(costs.structuredContent.error, /No budget data/);
  const session = await call("get_session", { sessionId: SESSION_ID });
  assert.match(
    session.structuredContent.usageUnavailableReason,
    /No budget data/,
  );
});
test("routine and decision reads retain uncertainty and use only GET", async () => {
  const id = "baac86a9-8cf3-4006-9c1d-3156d822491c";
  const queue = {
    items: [],
    unknown: [{ sessionId: SESSION_ID, error: "unreachable" }],
    nextOffset: 20,
    candidates: 21,
  };
  const { call, seen } = await dashboard({
    routes: {
      "/api/routines": { routines: [{ id }], clock: { running: false } },
      [`/api/routines/${id}`]: {
        routine: { id },
        runs: [{ state: "unknown" }],
      },
      "/api/approvals/pending": queue,
    },
  });
  assert.equal(
    (await call("list_routines", {})).structuredContent.clock.running,
    false,
  );
  assert.equal(
    (await call("get_routine", { routineId: id })).structuredContent.runs[0]
      .state,
    "unknown",
  );
  assert.deepEqual(
    (await call("pending_decisions", { offset: 20 })).structuredContent,
    queue,
  );
  assert.equal(new URLSearchParams(seen.at(-1).search).get("offset"), "20");
  assert.ok(seen.every((request) => request.method === "GET"));
});

// ---------------------------------------------------------------------------
// promote_session_to_eval refuses rather than hand back source that will not compile
// ---------------------------------------------------------------------------

test("AN OVERSIZED EVAL IS REFUSED, not clipped mid-file", async () => {
  // Before this, a 72,080-character eval came back clipped to 61,636 characters,
  // ending inside a string literal inside an unclosed function body — while the
  // tool description told the caller to save it to evals/<filename>. The cap was
  // right and the notice was accurate; what came back still could not be used.
  const { call } = await dashboard({ evalChars: 72_000 });
  const response = await call("promote_session_to_eval", {
    sessionId: SESSION_ID,
  });

  assert.equal(
    response.isError,
    true,
    "a file that cannot compile is a failure, not a result",
  );
  assert.equal(
    response.structuredContent.source,
    undefined,
    "no clipped source is handed back at all",
  );

  const { error, detail } = response.structuredContent;
  assert.match(error, /Nothing was returned, deliberately/);
  assert.match(error, new RegExp(MAX_OUTPUT_BYTES_ENV));
  // The two escape hatches have to be IN the message: this is the only thing the
  // caller gets, so a refusal that does not say how to get the file is just a
  // failure.
  assert.match(error, /raise EVESTACK_MCP_MAX_OUTPUT_BYTES to at least \d+/);
  assert.match(error, /\/api\/evals\/promote\//);
  assert.ok(
    detail.sourceCharacters > 70_000,
    `sourceCharacters was ${detail.sourceCharacters}`,
  );
  assert.ok(detail.raiseCapTo > detail.maxOutputBytes);
});

test("raising the cap to what the refusal asks for makes the same call succeed, whole", async () => {
  // The number in the refusal has to be actionable, not indicative — so take it
  // literally and check it is enough.
  const first = await dashboard({ evalChars: 72_000 });
  const refused = await first.call("promote_session_to_eval", {
    sessionId: SESSION_ID,
  });
  const raiseTo = refused.structuredContent.detail.raiseCapTo;

  const second = await dashboard({
    evalChars: 72_000,
    env: { [MAX_OUTPUT_BYTES_ENV]: String(raiseTo) },
  });
  const response = await second.call("promote_session_to_eval", {
    sessionId: SESSION_ID,
  });

  assert.equal(response.isError, false);
  assert.equal(
    response.structuredContent._truncated,
    undefined,
    "and nothing was cut at that size",
  );
  assert.ok(
    response.structuredContent.source.endsWith("});\n"),
    "the file ends where the file ends",
  );
  assert.doesNotMatch(
    response.structuredContent.source,
    /characters dropped by/,
  );
});

test("an eval that fits is returned untouched, as before", async () => {
  const { call } = await dashboard({ evalChars: 2_000 });
  const response = await call("promote_session_to_eval", {
    sessionId: SESSION_ID,
  });

  assert.equal(response.isError, false);
  assert.equal(
    response.structuredContent.saveTo,
    `evals/${SESSION_ID}.eval.ts`,
  );
  assert.ok(response.structuredContent.source.endsWith("});\n"));
});

// ---------------------------------------------------------------------------
// An explicit null means absent, all the way to the wire
// ---------------------------------------------------------------------------

test("AN EXPLICIT NULL IS DROPPED, exactly as an omitted argument is", async () => {
  // schema.ts:95-99: "an explicit null is the only way a client can spell
  // 'present but empty' — and for these tools it means the same thing as
  // absent." The validator agreed; the request builder did not. `limit: null`
  // became the literal query `?limit=null`, which /api/approvals reads as
  // Number("null") and answers 400; `mode: null` and `decision: null` went out
  // as JSON nulls that their control routes reject the same way. Every one of
  // those calls succeeds with the argument simply left out.
  const { call, last } = await dashboard();

  await call("list_approvals", { sessionId: null, limit: null });
  const withNulls = last().search;
  await call("list_approvals", {});
  assert.equal(
    withNulls,
    last().search,
    "nulls must produce the same query string as omission",
  );
  assert.equal(
    withNulls,
    "",
    "and that query string is empty, not '?limit=null'",
  );

  await call("start_session", { message: "hello", mode: null });
  const bodyWithNull = last().body;
  await call("start_session", { message: "hello" });
  assert.equal(bodyWithNull, last().body);
  assert.deepEqual(JSON.parse(bodyWithNull), { message: "hello" });

  await call("approve_or_deny", {
    sessionId: SESSION_ID,
    decision: null,
    requestId: null,
    optionId: null,
    text: null,
    message: null,
  });
  assert.deepEqual(
    JSON.parse(last().body),
    {},
    "no key at all, rather than five nulls",
  );

  await call("send_message", {
    sessionId: SESSION_ID,
    message: "hi",
    continuationToken: null,
  });
  assert.deepEqual(JSON.parse(last().body), { message: "hi" });

  await call("cancel_run", { sessionId: SESSION_ID, turnId: null });
  assert.deepEqual(JSON.parse(last().body), {});
});

test("a real limit still reaches the route", async () => {
  // The null fix must not turn into "the limit is never sent", which would be
  // the same bug pointing the other way.
  const { call, last } = await dashboard();
  await call("list_approvals", { sessionId: SESSION_ID, limit: 25 });
  assert.match(last().search, /sessionId=wrun_01KZ8CQ5012M1M9P6YE7YG3FJ3/);
  assert.match(last().search, /limit=25/);
});

// ---------------------------------------------------------------------------
// The dashboard's own truncation is a second truncation, and it was being eaten
// ---------------------------------------------------------------------------

test("THE DASHBOARD'S OWN `truncated` FLAG REACHES THE MODEL", async () => {
  // /api/approvals answers `truncated: rows.length >= limit` — "a full page came
  // back, so there may be more". This tool used to return `{count, approvals}`
  // and nothing else, so a 200-row page off an audit log with 40,000 rows in it
  // arrived looking like the whole log. That is the same silent-truncation
  // defect the `_truncated` notice exists to prevent, one layer further down,
  // and an audit log is the worst place in the system to have it.
  const rows = Array.from({ length: 200 }, (_, i) => ({
    id: `a${i}`,
    approverVia: "forwarded-user",
  }));
  const { call } = await dashboard({
    approvalsBody: {
      ok: true,
      count: 200,
      unidentified: 0,
      truncated: true,
      approvals: rows,
    },
  });
  const response = await call("list_approvals", {});

  assert.equal(response.isError, false);
  assert.equal(response.structuredContent.count, 200);
  assert.equal(response.structuredContent.moreRowsMayExist, true);
});

test("a page that did NOT hit the dashboard's limit says so", async () => {
  const { call } = await dashboard({
    approvalsBody: {
      ok: true,
      count: 2,
      unidentified: 0,
      truncated: false,
      approvals: [{ id: "a" }, { id: "b" }],
    },
  });
  const response = await call("list_approvals", {});
  assert.equal(response.structuredContent.moreRowsMayExist, false);
});

test("a dashboard too old to report it gets no answer invented for it", async () => {
  // Absent, not `false`. A build that predates the flag has told us nothing
  // about whether it hit its limit, and "not truncated" is a reassurance this
  // server would be making up.
  const { call } = await dashboard({
    approvalsBody: { ok: true, approvals: [{ id: "a" }] },
  });
  const response = await call("list_approvals", {});
  assert.ok(
    !("moreRowsMayExist" in response.structuredContent),
    `the key is present as ${response.structuredContent.moreRowsMayExist}`,
  );
});

// ---------------------------------------------------------------------------
// The Authorization header, and the spelling the docs told everyone to use
// ---------------------------------------------------------------------------

/**
 * `EVESTACK_MCP_DASHBOARD_AUTH` reaches the dashboard as the `Authorization`
 * header. docs/mcp.mdx documented it as "`user:password` for the dashboard" and
 * this server sent that string unchanged, while the dashboard's `verifyBasic`
 * returns null for anything that does not match /^Basic /i
 * (packages/dashboard/lib/auth.ts). So the documented configuration
 * authenticated nothing: every tool came back 401, on a dashboard that was
 * working and a credential that was correct.
 *
 * These assert on the bytes that leave this process rather than on `loadConfig`'s
 * return value, because a normalization that never reaches `headers.set` is the
 * same bug with a passing unit test.
 */
const authHeader = (last) => last().headers.authorization;

test("A BARE user:password IS ENCODED, because that is what the docs asked for", async () => {
  const { call, last } = await dashboard({
    env: { EVESTACK_MCP_DASHBOARD_AUTH: "admin:hunter2" },
  });
  await call("list_sessions", {});

  const sent = authHeader(last);
  assert.match(
    sent,
    /^Basic /,
    "the prefix verifyBasic requires, which the raw value never had",
  );
  assert.equal(
    Buffer.from(sent.slice("Basic ".length), "base64").toString("utf8"),
    "admin:hunter2",
    "and the credential itself is unchanged — this is an encoding, not an interpretation",
  );
});

test("a value that already carries a scheme is sent exactly as written", async () => {
  // The backward-compatibility half. Anyone whose dashboard works today typed a
  // real header value, and a real header value starts with a scheme token that
  // cannot contain a colon (RFC 9110 §11.1). Those must come through untouched —
  // including schemes this package has never heard of, and credentials that
  // themselves contain colons.
  for (const value of [
    "Basic YWRtaW46aHVudGVyMg==",
    "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x",
    "SSWS 00a:bc",
    "Negotiate YIIZ",
  ]) {
    const { call, last } = await dashboard({
      env: { EVESTACK_MCP_DASHBOARD_AUTH: value },
    });
    await call("list_sessions", {});
    assert.equal(authHeader(last), value, value);
  }
});

test("a schemeless value with no colon is left alone rather than guessed at", async () => {
  // Not a username and password. Encoding it would invent a credential that the
  // operator did not type, which is a worse failure than the 401 they can read.
  const { call, last } = await dashboard({
    env: { EVESTACK_MCP_DASHBOARD_AUTH: "opaque-proxy-token" },
  });
  await call("list_sessions", {});
  assert.equal(authHeader(last), "opaque-proxy-token");
});

test("EVESTACK_MCP_DASHBOARD_AUTH_VERBATIM=1 restores the old pass-through", async () => {
  // The escape hatch for the one shape the rule reads wrong: a proxy that wants
  // a schemeless value which happens to contain a colon.
  const { call, last } = await dashboard({
    env: {
      EVESTACK_MCP_DASHBOARD_AUTH: "admin:hunter2",
      EVESTACK_MCP_DASHBOARD_AUTH_VERBATIM: "1",
    },
  });
  await call("list_sessions", {});
  assert.equal(authHeader(last), "admin:hunter2");
});

test("no variable, no header — an unauthenticated dashboard is not sent an empty credential", async () => {
  const { call, last } = await dashboard();
  await call("list_sessions", {});
  assert.equal(authHeader(last), undefined);
});

// ---------------------------------------------------------------------------
// The name on an approval row, and the warning that could not fire
// ---------------------------------------------------------------------------

/**
 * `EVESTACK_MCP_APPROVER` is sent as `X-Forwarded-User`, and the dashboard reads
 * that header only when `EVESTACK_TRUSTED_PROXY` is set (lib/approvals.ts →
 * `trustsForwardedIdentity` in lib/auth.ts). On every install without a proxy in
 * front — the documented setup — the name is therefore sent and ignored, and the
 * row records the Basic username instead.
 *
 * The old warning branch fired only on a NULL approver, so that case produced no
 * warning at all: a non-null name, from a source the operator did not choose,
 * reported to a model as though it were the configured identity. These pin the
 * disagreement being noticed, and — just as important — pin that a correctly
 * attributed decision stays quiet, because a warning on every row is a warning
 * nobody reads.
 */
const APPROVER = "mcp-agent@example.com";

test("A ROW THAT NAMES SOMEONE ELSE SAYS SO, even though nothing failed", async () => {
  const { call } = await dashboard({
    env: { EVESTACK_MCP_APPROVER: APPROVER },
    approveBody: {
      ok: true,
      sessionId: SESSION_ID,
      answered: ["req_1"],
      audited: true,
      approver: "admin",
      approverVia: "basic",
    },
  });
  const response = await call("approve_or_deny", {
    sessionId: SESSION_ID,
    decision: "approve",
  });

  assert.equal(
    response.isError,
    false,
    "the decision took effect; this is not a failure",
  );
  const { attributionWarning, approver, approverVia } =
    response.structuredContent;

  assert.equal(
    approver,
    "admin",
    "the row is reported as it is, not as it was meant to be",
  );
  assert.equal(approverVia, "basic");
  assert.match(attributionWarning, /EVESTACK_TRUSTED_PROXY/);
  assert.match(
    attributionWarning,
    new RegExp(APPROVER),
    "names what was configured",
  );
  assert.match(attributionWarning, /"admin"/, "and what was actually recorded");
});

test("and it does not claim a difference when the two names are the SAME string", async () => {
  // The configuration that makes a wording built on string comparison read as
  // nonsense, and it is not a contrived one: an operator who wants their own name
  // in the audit log sets EVESTACK_MCP_APPROVER to their address, and the
  // dashboard's Basic user is very often that same address. The row is still
  // wrong in the way that matters — `basic` names the shared credential, not the
  // person, and the header this server sent was never read — so the warning must
  // still fire. What it must not do is open by saying `X` is not `X`.
  const { call } = await dashboard({
    env: { EVESTACK_MCP_APPROVER: APPROVER },
    approveBody: {
      ok: true,
      sessionId: SESSION_ID,
      answered: ["req_1"],
      audited: true,
      approver: APPROVER,
      approverVia: "basic",
    },
  });
  const response = await call("approve_or_deny", {
    sessionId: SESSION_ID,
    decision: "approve",
  });

  const { attributionWarning } = response.structuredContent;
  assert.match(
    attributionWarning,
    /approverVia 'basic'/,
    "the provenance is still worth saying",
  );
  assert.doesNotMatch(
    attributionWarning,
    /not the one this server offered/,
    "with the same string on both sides that sentence is a flat contradiction, which is exactly the " +
      "confident wrongness this field exists to prevent",
  );
});

test("a row that names the configured identity is left alone", async () => {
  const { call } = await dashboard({
    env: { EVESTACK_MCP_APPROVER: APPROVER },
    approveBody: {
      ok: true,
      sessionId: SESSION_ID,
      answered: ["req_1"],
      audited: true,
      approver: APPROVER,
      approverVia: "forwarded-user",
    },
  });
  const response = await call("approve_or_deny", {
    sessionId: SESSION_ID,
    decision: "approve",
  });
  assert.equal(response.structuredContent.attributionWarning, undefined);
});

test("a dashboard too old to report `approverVia` gets no warning invented for it", async () => {
  // Same rule as the /api/approvals `truncated` flag above: silence from the
  // other side is not evidence, and a warning manufactured out of it would be
  // the same species of confident wrongness this file is about.
  const { call } = await dashboard({
    env: { EVESTACK_MCP_APPROVER: APPROVER },
    approveBody: {
      ok: true,
      sessionId: SESSION_ID,
      answered: ["req_1"],
      audited: true,
      approver: "admin",
    },
  });
  const response = await call("approve_or_deny", {
    sessionId: SESSION_ID,
    decision: "approve",
  });
  assert.equal(response.structuredContent.attributionWarning, undefined);
});

test("a row that names nobody still says how to fix it, and now says the whole of it", async () => {
  const { call } = await dashboard({
    approveBody: {
      ok: true,
      sessionId: SESSION_ID,
      answered: ["req_1"],
      audited: true,
      approver: null,
      approverVia: "unidentified",
    },
  });
  const response = await call("approve_or_deny", {
    sessionId: SESSION_ID,
    decision: "approve",
  });

  const { attributionWarning } = response.structuredContent;
  assert.match(attributionWarning, /EVESTACK_MCP_APPROVER/);
  // The half that was missing: setting the variable alone changes nothing.
  assert.match(attributionWarning, /EVESTACK_TRUSTED_PROXY/);
  assert.match(attributionWarning, /EVESTACK_REQUIRE_APPROVER/);
});
