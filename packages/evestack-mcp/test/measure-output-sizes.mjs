/**
 * Where the numbers in README.md's "Output cap" table come from.
 *
 * `node test/measure-output-sizes.mjs` (after `npm run build`). It prints the
 * table. Nothing here is a test — it is the measurement, checked in so the
 * README's figures can be re-derived instead of believed.
 *
 * WHY THIS FILE EXISTS. The table used to carry a row reading
 * "`list_approvals` (no limit) → 562,138 B / ~140k tokens", and that number was
 * wrong about its own route: `GET /api/approvals` with no `limit` has defaulted
 * the whole-log arm to 200 rows since the route was introduced
 * (packages/dashboard/app/api/approvals/route.ts:33, and the same 200 in commit
 * 5c49f3a that added it), so the no-argument call the row described could never
 * return the 1000 rows that figure was taken from. A fabricated measurement in
 * a README is exactly the class of defect this audit has been removing, so the
 * fix is not a corrected number typed by hand — it is this script.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT.
 *
 *   REAL: the code path. Every number below comes from `McpServer.handle()`
 *   answering a genuine `tools/call`, through the genuine `DashboardClient`,
 *   over a genuine socket, and is the byte length of the `content[0].text`
 *   block that would reach the model. The cap is raised out of the way
 *   (EVESTACK_MCP_MAX_OUTPUT_BYTES) so what is measured is the size the result
 *   WOULD be if nothing capped it — which is the only thing that can justify a
 *   cap.
 *
 *   REAL: the row counts. Each fake route applies the same LIMIT its real
 *   counterpart applies, cited at the call site below.
 *
 *   SYNTHETIC: the row CONTENTS. There is no production database here, so each
 *   row is built field-by-field from the interface the real reader returns
 *   (`ApprovalRow` in packages/dashboard/lib/approvals.ts, `getTotals()` and
 *   `listSessions()` in lib/queries.ts, `usage()` in app/api/budget/route.ts,
 *   `InputRequest` in lib/agent-client.ts, `generateEval()` in
 *   lib/promote-eval.ts) with values of the length those fields really hold —
 *   ULIDs where the schema stores ULIDs, e-mail addresses where it stores an
 *   approver, ISO-8601 where it stores a timestamp. A deployment whose tool
 *   inputs are long file contents will measure larger than this; one that
 *   records short shell commands will measure a little smaller. These are
 *   representative sizes, not a ceiling, and the table says so.
 */

import http from "node:http";
import { loadConfig } from "../dist/config.js";
import { McpServer } from "../dist/server.js";

const SESSION_ID = "wrun_01KZ8CQ5012M1M9P6YE7YG3FJ3";
const MODELS = ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"];

/** Big enough that nothing is ever cut, so every number below is the UNCAPPED size. */
const NO_CAP = 16 * 1024 * 1024;

const bytes = (text) => Buffer.byteLength(text, "utf8");

// ---------------------------------------------------------------------------
// Row builders — one per real reader, field for field
// ---------------------------------------------------------------------------

/** packages/dashboard/lib/approvals.ts `toRow()`: thirteen fields, all of them. */
const approvalRow = (i) => ({
  id: `a1b2c3d4-e5f6-4a7b-8c9d-${String(i).padStart(12, "0")}`,
  decidedAt: new Date(Date.UTC(2026, 7, 9, 12, 0, 0) + i * 1000).toISOString(),
  sessionId: SESSION_ID,
  turnId: `turn_01KZ8CQ5012M1M9P6YE7YG3${String(i % 1000).padStart(3, "0")}`,
  requestId: `req_01KZ8CQ5012M1M9P6YE7YG3${String(i % 1000).padStart(3, "0")}`,
  requestKind: "tool-approval",
  toolName: i % 3 === 0 ? "write_file" : "shell.exec",
  optionId: i % 5 === 0 ? "deny" : "approve",
  answerText: null,
  approver: "sammy@example.com",
  approverVia: i % 7 === 0 ? "unidentified" : "forwarded-user",
  remoteAddr: "10.42.0.7",
  userAgent: "evestack-mcp/0.2.1 (claude-code/2.0.14)",
});

/** app/api/budget/route.ts `usage()`. */
const usage = (i) => ({
  costUsd: Number((0.37 + i / 100).toFixed(6)),
  inputTokens: 412_889 + i * 137,
  outputTokens: 38_204 + i * 11,
  cacheReadTokens: 1_204_881 + i * 907,
  steps: 214 + i,
  unpricedSteps: i % 9 === 0 ? 3 : 0,
});

/** `SELECT ... FROM evestack.budget_events` in app/api/budget/route.ts:98 — raw, snake_case. */
const budgetEvent = (i) => ({
  id: 90_000 + i,
  session_id: SESSION_ID,
  turn_id: `turn_01KZ8CQ5012M1M9P6YE7YG3${String(i).padStart(3, "0")}`,
  principal_id: `user_${String(i % 200).padStart(3, "0")}@example.com`,
  scope: i % 2 === 0 ? "session" : "principal-day",
  limit_usd: "5.000000",
  spent_usd: (4.1 + i / 100).toFixed(6),
  action: i % 4 === 0 ? "stop" : "warn",
  detail: "spend crossed 80% of the session cap on step 214",
  created_at: new Date(Date.UTC(2026, 7, 9, 11, 0, 0) + i * 60_000).toISOString(),
});

/** `SELECT ... FROM evestack.budget_stops` in app/api/budget/route.ts:111. */
const budgetStop = (i) => ({
  scope: "session",
  scope_key: SESSION_ID,
  session_id: SESSION_ID,
  reason: `session cap $5.00 exceeded: step 231 would bring spend to $5.0${String(i).padStart(2, "0")}`,
  limit_usd: "5.000000",
  spent_usd: (5.0 + i / 100).toFixed(6),
  created_at: new Date(Date.UTC(2026, 7, 9, 11, 30, 0) + i * 60_000).toISOString(),
});

/** app/api/health/detail/route.ts:30 — the five-row projection, not the full session row. */
const recentSession = (i) => ({
  id: i === 0 ? SESSION_ID : `wrun_01KZ8CQ5012M1M9P6YE7YG3F${String(i).padStart(2, "0")}`,
  status: i === 0 ? "waiting" : "completed",
  turns: 40 - i,
  tokens: 451_093 + i * 1_311,
  costUsd: Number((1.87 + i / 10).toFixed(6)),
  models: MODELS,
});

/** lib/agent-client.ts `InputRequest` — one ordinary `write_file` approval pending. */
const pendingWriteFile = {
  requestId: "req_01KZ8CQ5012M1M9P6YE7YG3FK1",
  kind: "tool-approval",
  prompt: "The agent wants to run write_file. Approve?",
  display: "confirmation",
  options: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
  allowFreeform: false,
  action: {
    callId: "call_01KZ8CQ5012M1M9P6YE7YG3FK2",
    kind: "tool-call",
    toolName: "write_file",
    input: {
      path: "packages/dashboard/app/api/approvals/route.ts",
      contents: "export const dynamic = \"force-dynamic\";\n".repeat(12),
    },
  },
};

/**
 * lib/promote-eval.ts `generateEval()`, emitted here rather than imported: it is
 * TypeScript inside the Next app and this script runs on plain node. The block
 * per turn below is the one that function writes at lib/promote-eval.ts:249-286
 * — a `t.send`, the tools that ran, `succeeded()`, and the commented reply.
 */
function generatedEval(turns) {
  const body = [];
  for (let i = 0; i < turns; i++) {
    if (i > 0) body.push("");
    const handle = `turn${i + 1}`;
    body.push(
      `    const ${handle} = await t.send("run the pending migration on staging and report the row count");`,
    );
    body.push(`    ${handle}.calledTool("shell.exec");`);
    body.push(`    ${handle}.calledTool("read_file");`);
    body.push(`    ${handle}.succeeded();`);
    body.push(`    // Observed reply — replace with the phrase that actually matters:`);
    body.push(`    // ${handle}.messageIncludes("Applied 3 migrations; evestack.approvals now has 1,2");`);
  }
  return {
    filename: `${SESSION_ID}-replay-of-the-staging-migration.eval.ts`,
    source:
      `import { defineEval } from "eve/evals";\n\n` +
      `/**\n * Promoted from production session ${SESSION_ID}.\n *\n` +
      ` * A DRAFT, not a finished test. The event log records what the agent did, never\n` +
      ` * what it should have done — so the messages and tool calls below are real, and\n` +
      ` * the value assertions are commented suggestions for you to make meaningful.\n *\n` +
      ` * Generated by the evestack dashboard.\n */\n` +
      `export default defineEval({\n  description: "Replay of the staging migration",\n` +
      `  async test(t) {\n${body.join("\n")}\n  },\n});\n`,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// The fake dashboard — same routes, same LIMITs
// ---------------------------------------------------------------------------

/** packages/dashboard/lib/approvals.ts:217. */
const MAX_APPROVALS = 1000;

function routes(url) {
  const path = url.pathname;
  const sessionId = url.searchParams.get("sessionId");

  if (path === "/api/approvals") {
    // app/api/approvals/route.ts:33 exactly: no `limit` means 200 for the whole
    // log and MAX_APPROVALS for one session. This is the line the old table's
    // "no limit → 562,138 B" row contradicted.
    const raw = url.searchParams.get("limit");
    const limit = raw === null ? (sessionId ? MAX_APPROVALS : 200) : Number(raw);
    const rows = Array.from({ length: limit }, (_, i) => approvalRow(i));
    const summary = {
      count: rows.length,
      unidentified: rows.filter((r) => r.approverVia === "unidentified").length,
      truncated: rows.length >= limit,
    };
    return { ok: true, ...(sessionId ? { sessionId } : {}), ...summary, approvals: rows };
  }

  if (path === "/api/health/detail") {
    // listSessions(5) at app/api/health/detail/route.ts:24.
    return {
      ok: true,
      database: "connected",
      totals: { sessions: 812, turns: 9_431, inputTokens: 331_884_012, outputTokens: 29_118_447, costUsd: 1_284.91 },
      recentSessions: Array.from({ length: 5 }, (_, i) => recentSession(i)),
    };
  }

  if (path === "/api/budget") {
    // LIMIT 200 / 50 / 50 at app/api/budget/route.ts:94, :102 and :115.
    return {
      ok: true,
      day: "2026-08-09",
      limits: { sessionUsd: 5, dailyUsd: 50, mode: "fail", timeZone: "America/New_York" },
      ...(sessionId ? { session: { id: sessionId, ...usage(0) } } : {}),
      principals: Array.from({ length: 200 }, (_, i) => ({
        principalId: `user_${String(i).padStart(3, "0")}@example.com`,
        ...usage(i),
      })),
      stops: Array.from({ length: 50 }, (_, i) => budgetStop(i)),
      events: Array.from({ length: 50 }, (_, i) => budgetEvent(i)),
    };
  }

  if (path.endsWith("/approve")) {
    return {
      ok: true,
      sessionId: SESSION_ID,
      waiting: true,
      terminal: false,
      turnId: "turn_01KZ8CQ5012M1M9P6YE7YG3FK0",
      pendingRequests: [pendingWriteFile],
      tailIndex: 1_284,
    };
  }

  if (path.startsWith("/api/evals/promote/")) return generatedEval(40);

  return null;
}

const server = http.createServer((req, res) => {
  const body = routes(new URL(req.url, "http://127.0.0.1"));
  res.writeHead(body === null ? 404 : 200, { "content-type": "application/json" });
  res.end(JSON.stringify(body ?? { ok: false, error: "no such route" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// ---------------------------------------------------------------------------
// Drive the real server
// ---------------------------------------------------------------------------

const mcp = new McpServer(
  loadConfig({
    EVESTACK_MCP_DASHBOARD_URL: `http://127.0.0.1:${port}`,
    EVESTACK_MCP_MAX_OUTPUT_BYTES: String(NO_CAP),
  }),
);
await mcp.handle({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", clientInfo: { name: "measure-output-sizes", version: "1" } },
});

async function measure(label, name, args) {
  const { response } = await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (response.isError) throw new Error(`${label}: ${JSON.stringify(response.structuredContent)}`);
  const size = bytes(response.content[0].text);
  // ~4 characters per token is the rule of thumb every one of these clients
  // uses; it is an estimate and the table labels it "≈".
  return { label, size, tokens: size / 4 };
}

const results = [
  await measure("list_sessions", "list_sessions", {}),
  await measure("promote_session_to_eval (40-turn session)", "promote_session_to_eval", {
    sessionId: SESSION_ID,
  }),
  await measure("get_session", "get_session", { sessionId: SESSION_ID }),
  await measure("get_costs", "get_costs", { sessionId: SESSION_ID }),
  await measure("list_approvals (no arguments → 200 rows)", "list_approvals", {}),
  await measure("list_approvals limit=500", "list_approvals", { limit: 500 }),
  await measure("list_approvals sessionId, no limit → 1000 rows", "list_approvals", {
    sessionId: SESSION_ID,
  }),
];

/** "0.4k", "3.9k", "10k", "142k" — one decimal only when it says something. */
const thousands = (tokens) => {
  const k = tokens / 1000;
  return `${(k < 10 ? k.toFixed(1) : k.toFixed(0)).replace(/\.0$/, "")}k`;
};

const width = Math.max(...results.map((r) => r.label.length));
console.log(`\nUncapped tool-result sizes, measured through tools/call on ${new Date().toISOString().slice(0, 10)}:\n`);
for (const { label, size, tokens } of results) {
  console.log(
    `  ${label.padEnd(width)}  ${size.toLocaleString("en-US").padStart(9)} B   ~${thousands(tokens)} tokens`,
  );
}
console.log(`\n  cap (EVESTACK_MCP_MAX_OUTPUT_BYTES default) 65,536 B   ~16k tokens\n`);

server.close();
