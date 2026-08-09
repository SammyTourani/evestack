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
async function dashboard({ evalChars = 400, env = {}, approvalsBody = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      seen.push({ method: req.method, path: url.pathname, search: url.search, body: raw });
      const answer = url.pathname.startsWith("/api/evals/promote/")
        ? { filename: `${SESSION_ID}.eval.ts`, source: evalSource(evalChars), warnings: [] }
        : url.pathname === "/api/approvals" && approvalsBody
          ? approvalsBody
          : { ok: true, approvals: [], count: 0, sessionId: SESSION_ID, answered: [], audited: true };
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
      ...env,
    }),
  );
  await mcp.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", clientInfo: { name: "tools-test", version: "1" } },
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

// ---------------------------------------------------------------------------
// promote_session_to_eval refuses rather than hand back source that will not compile
// ---------------------------------------------------------------------------

test("AN OVERSIZED EVAL IS REFUSED, not clipped mid-file", async () => {
  // Before this, a 72,080-character eval came back clipped to 61,636 characters,
  // ending inside a string literal inside an unclosed function body — while the
  // tool description told the caller to save it to evals/<filename>. The cap was
  // right and the notice was accurate; what came back still could not be used.
  const { call } = await dashboard({ evalChars: 72_000 });
  const response = await call("promote_session_to_eval", { sessionId: SESSION_ID });

  assert.equal(response.isError, true, "a file that cannot compile is a failure, not a result");
  assert.equal(response.structuredContent.source, undefined, "no clipped source is handed back at all");

  const { error, detail } = response.structuredContent;
  assert.match(error, /Nothing was returned, deliberately/);
  assert.match(error, new RegExp(MAX_OUTPUT_BYTES_ENV));
  // The two escape hatches have to be IN the message: this is the only thing the
  // caller gets, so a refusal that does not say how to get the file is just a
  // failure.
  assert.match(error, /raise EVESTACK_MCP_MAX_OUTPUT_BYTES to at least \d+/);
  assert.match(error, /\/api\/evals\/promote\//);
  assert.ok(detail.sourceCharacters > 70_000, `sourceCharacters was ${detail.sourceCharacters}`);
  assert.ok(detail.raiseCapTo > detail.maxOutputBytes);
});

test("raising the cap to what the refusal asks for makes the same call succeed, whole", async () => {
  // The number in the refusal has to be actionable, not indicative — so take it
  // literally and check it is enough.
  const first = await dashboard({ evalChars: 72_000 });
  const refused = await first.call("promote_session_to_eval", { sessionId: SESSION_ID });
  const raiseTo = refused.structuredContent.detail.raiseCapTo;

  const second = await dashboard({ evalChars: 72_000, env: { [MAX_OUTPUT_BYTES_ENV]: String(raiseTo) } });
  const response = await second.call("promote_session_to_eval", { sessionId: SESSION_ID });

  assert.equal(response.isError, false);
  assert.equal(response.structuredContent._truncated, undefined, "and nothing was cut at that size");
  assert.ok(response.structuredContent.source.endsWith("});\n"), "the file ends where the file ends");
  assert.doesNotMatch(response.structuredContent.source, /characters dropped by/);
});

test("an eval that fits is returned untouched, as before", async () => {
  const { call } = await dashboard({ evalChars: 2_000 });
  const response = await call("promote_session_to_eval", { sessionId: SESSION_ID });

  assert.equal(response.isError, false);
  assert.equal(response.structuredContent.saveTo, `evals/${SESSION_ID}.eval.ts`);
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
  assert.equal(withNulls, last().search, "nulls must produce the same query string as omission");
  assert.equal(withNulls, "", "and that query string is empty, not '?limit=null'");

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
  assert.deepEqual(JSON.parse(last().body), {}, "no key at all, rather than five nulls");

  await call("send_message", { sessionId: SESSION_ID, message: "hi", continuationToken: null });
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
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, approverVia: "forwarded-user" }));
  const { call } = await dashboard({
    approvalsBody: { ok: true, count: 200, unidentified: 0, truncated: true, approvals: rows },
  });
  const response = await call("list_approvals", {});

  assert.equal(response.isError, false);
  assert.equal(response.structuredContent.count, 200);
  assert.equal(response.structuredContent.moreRowsMayExist, true);
});

test("a page that did NOT hit the dashboard's limit says so", async () => {
  const { call } = await dashboard({
    approvalsBody: { ok: true, count: 2, unidentified: 0, truncated: false, approvals: [{ id: "a" }, { id: "b" }] },
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
