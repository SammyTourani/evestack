import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { McpServer } from "../dist/server.js";

/**
 * What a model puts in `sessionId` reaches an HTTP request. Nothing else.
 *
 * There is no SQL and no shell in this package to inject into — it holds no
 * database connection and spawns no process, which is the architectural rule
 * stated in dashboard.ts and enforceable by grep. The injection surface that
 * DOES exist is URL construction: `path()` in tools.ts splices `sessionId` into
 * a control-route path, and `client.get(path, query)` puts values into a query
 * string. A model can put anything in that argument — the schema only says
 * "string, minLength 1" — so these tests pin the encoding rather than trusting
 * it, by recording what the server on the other end actually received.
 *
 * The three that would matter if the encoding were dropped:
 *
 *   ".." / "/"  reaching a different control route than the one the tool names,
 *               e.g. turning get_session into a call on another session's cancel.
 *   "?" / "#"   smuggling query parameters into a route that reads them.
 *   CRLF        splitting a header, which is how a forged X-Forwarded-User gets
 *               into evestack.approvals — the exact forgery lib/approvals.ts
 *               was rewritten to prevent from the other side.
 */

const received = [];

function recordingDashboard() {
  const server = http.createServer((req, res) => {
    received.push({ url: req.url, headers: { ...req.headers } });
    res.writeHead(200, { "content-type": "application/json" });
    // Enough shape for get_session to succeed rather than throw before we look.
    res.end(JSON.stringify({ ok: true, tailIndex: 0, pendingRequests: [], recentSessions: [], source: "" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const started = [];
after(() => {
  for (const server of started) server.close();
});

async function call(name, args) {
  received.length = 0;
  const { server, port } = await recordingDashboard();
  started.push(server);
  const mcp = new McpServer(
    loadConfig({
      EVESTACK_MCP_DASHBOARD_URL: `http://127.0.0.1:${port}`,
      EVESTACK_MCP_ALLOW_CONTROL: "1",
    }),
  );
  await mcp.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" } },
  });
  await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return received;
}

const HOSTILE = {
  traversal: "../../../api/control/sessions/wrun_victim/cancel",
  query: "wrun_x?limit=999999&sessionId=wrun_other",
  fragment: "wrun_x#/api/health",
  crlf: "wrun_x\r\nX-Forwarded-User: attacker@example.com",
  sql: "wrun_x'; DROP TABLE evestack.approvals; --",
  scheme: "http://evil.example.com/api/control/sessions/wrun_x",
};

test("a hostile sessionId cannot walk out of the route the tool named", async () => {
  const seen = await call("promote_session_to_eval", { sessionId: HOSTILE.traversal });
  const [request] = seen;
  const { pathname } = new URL(request.url, "http://x");

  assert.equal(seen.length, 1);
  assert.ok(pathname.startsWith("/api/evals/promote/"), pathname);

  // The property is SEGMENT COUNT, not the absence of dots. encodeURIComponent
  // leaves "." alone and escapes "/", so the payload arrives as the single inert
  // segment `..%2F..%2F..%2Fapi%2F…` — dots and all — and no router anywhere
  // resolves that as a parent directory. Asserting `!includes("..")` instead
  // would fail on correct output, which is how a good encoder gets "fixed".
  const segments = pathname.split("/");
  assert.equal(segments.length, 5, `one segment after /api/evals/promote: ${pathname}`);
  assert.equal(decodeURIComponent(segments[4]), HOSTILE.traversal, "intact, and inert");
  assert.ok(!pathname.includes("/cancel"), "and certainly not a mutating route");
});

test("a hostile sessionId cannot smuggle in a query parameter", async () => {
  const seen = await call("promote_session_to_eval", { sessionId: HOSTILE.query });
  const url = new URL(seen[0].url, "http://x");

  // `format=json` is the only parameter this tool sends, and it is a literal.
  assert.deepEqual([...url.searchParams.keys()], ["format"]);
  assert.equal(url.searchParams.get("format"), "json");
  assert.ok(url.pathname.includes("%3Flimit%3D999999"), url.pathname);
});

test("a fragment is encoded rather than truncating the path", async () => {
  const seen = await call("promote_session_to_eval", { sessionId: HOSTILE.fragment });
  assert.ok(seen[0].url.includes("%23"), seen[0].url);
  assert.ok(!seen[0].url.includes("#"), seen[0].url);
});

test("CRLF in a sessionId does not become a header", async () => {
  // The forged-identity case: evestack.approvals records `approver` from
  // X-Forwarded-User, so a request-splitting sessionId that lands one there
  // would write a colleague's name onto an audit row.
  const seen = await call("get_session", { sessionId: HOSTILE.crlf });
  for (const request of seen) {
    assert.equal(request.headers["x-forwarded-user"], undefined, JSON.stringify(request.headers));
    assert.ok(!request.url.includes("\r"), request.url);
    assert.ok(!request.url.includes("\n"), request.url);
  }
  assert.ok(seen.some((request) => request.url.includes("%0D%0A")), "encoded, not dropped");
});

test("a SQL payload is carried as an opaque value, because nothing here builds SQL", async () => {
  // This package holds no database connection; the string is a route parameter
  // the dashboard parameterises. The test exists so that stays true by accident
  // of encoding rather than by nobody having looked.
  const seen = await call("get_session", { sessionId: HOSTILE.sql });
  const budget = seen.find((request) => request.url.startsWith("/api/budget"));

  assert.ok(budget, "get_session asks /api/budget for this session's usage");
  assert.equal(new URL(budget.url, "http://x").searchParams.get("sessionId"), HOSTILE.sql);
  for (const request of seen) assert.ok(!request.url.includes("DROP TABLE"), request.url);
});

test("a sessionId that looks like a URL does not redirect the request off-host", async () => {
  // If it were spliced in raw, `new URL(base + path)` would still resolve
  // against the base — but the path would carry a second scheme, and any proxy
  // in front normalizing it is a request to somebody else's host.
  const seen = await call("promote_session_to_eval", { sessionId: HOSTILE.scheme });
  assert.equal(seen.length, 1, "one request, to us");
  assert.ok(seen[0].url.startsWith("/api/evals/promote/http%3A%2F%2Fevil.example.com"), seen[0].url);
});

test("the arguments a mutating tool posts go in the BODY, not the URL", async () => {
  // cancel_run and approve_or_deny take free text. It reaches the dashboard as
  // JSON, so nothing in it is parsed as a route or a parameter.
  const seen = await call("cancel_run", { sessionId: "wrun_x", turnId: "wtrn_y?x=1" });
  const url = new URL(seen[0].url, "http://x");
  assert.deepEqual([...url.searchParams.keys()], []);
  assert.equal(url.pathname, "/api/control/sessions/wrun_x/cancel");
});
