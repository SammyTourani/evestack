import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { installStubPool, uninstallStubPool } from "./stub-pool.mjs";

/**
 * The approvals decision path, and the audit row that is the whole point of it.
 *
 * ── Why a unit test, when a probe already covers this ────────────────────────
 *
 * contract/runtime/probes/11-approval-followup.probe.mjs runs this route against
 * a live eve and asserts, in its own words, that every decision is "a REFUSAL: a
 * request that must not be absorbed". That probe is gated on `needs: ["dashboard",
 * "agent"]` — a running dashboard, a running agent, and credentials — so on an
 * ordinary `pnpm test` none of it executes, and the refusals it protects are
 * unguarded in exactly the situation where someone is editing this file.
 *
 * What the probe CANNOT reach is the other half, and it says so: with no provider
 * key nothing can park on a tool approval, so the happy path and the audit write
 * are never exercised there. Those are reachable here, because a stub of eve's
 * durable stream can publish an `input.requested` a model would otherwise have
 * to produce. So this file is not a re-run of the probe in miniature — it is the
 * part of the decision path that has never been executed by any test.
 *
 * ── The failure being guarded against ────────────────────────────────────────
 *
 * "200, and nothing happened" is worse here than an outright error: the operator
 * believes a human authorised a gated shell command, and no row records who. The
 * two directions are pinned separately —
 *
 *   a refusal must not resume the turn        (the agent receives no POST)
 *   a decision that IS carried out must be    (the INSERT happens, after the
 *   audited, or must say that it was not       agent accepts, and its failure
 *                                              surfaces rather than vanishing)
 *
 * ── How eve is stood in for ──────────────────────────────────────────────────
 *
 * A stub HTTP server, the same technique as test/agent-stream.test.mjs, because
 * everything under test is a judgement the DASHBOARD makes about a given
 * sequence of events. A real agent can only be in one of these states at a time,
 * and reaching the parked-on-an-approval one costs a provider key.
 */

/* ── module resolution: route files import through the "@/" alias ──────────── */

const PACKAGE_ROOT = new URL("../", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const candidate = new URL(`${specifier.slice(2)}.ts`, PACKAGE_ROOT);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/i.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { GET, POST } = await import("../app/api/control/sessions/[id]/approve/route.ts");

/* ── the stub agent ────────────────────────────────────────────────────────── */

/** sessionId -> the durable events eve would replay for it. */
const streams = new Map();
/** Every follow-up POST the route made. Empty is how a refusal is proved. */
let resumed = [];
let server;
let agentUrl;

const TOOL_APPROVAL = {
  requestId: "req_1",
  kind: "tool-approval",
  action: { toolName: "bash", callId: "call_1" },
  options: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
};

/** A session parked on one gated tool call — what an operator actually sees. */
function parked(id, requests = [TOOL_APPROVAL], token = "ct_live") {
  streams.set(id, [
    { type: "turn.started", data: { turnId: "trn_1" } },
    { type: "input.requested", data: { requests } },
    { type: "session.waiting", data: { continuationToken: token } },
  ]);
  return id;
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://agent.test");
    const segments = url.pathname.split("/");
    // /eve/v1/session/:id  and  /eve/v1/session/:id/stream
    const id = decodeURIComponent(segments[4] ?? "");

    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        resumed.push({ id, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: id }));
      });
      return;
    }

    const events = streams.get(id) ?? [];
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      // -1 is eve's answer for a stream with no events: the id it has never
      // seen. It does NOT 404, which is why this route has to make the call.
      "x-eve-stream-tail-index": String(events.length - 1),
    });
    res.write("\n"); // eve primes the stream to flush headers
    for (const event of events) res.write(`${JSON.stringify(event)}\n`);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  agentUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/* ── environment ───────────────────────────────────────────────────────────── */

const CONTROLLED = [
  "EVESTACK_AGENT_URL",
  "EVESTACK_AUTH_USER",
  "EVESTACK_AUTH_PASSWORD",
  "EVESTACK_SESSION_SECRET",
  "EVESTACK_REQUIRE_APPROVER",
  "EVESTACK_TRUSTED_PROXY",
  "EVESTACK_APPROVER_HEADER",
];
const saved = {};

beforeEach(() => {
  for (const name of CONTROLLED) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.EVESTACK_AGENT_URL = agentUrl;
  resumed = [];
  streams.clear();
});

afterEach(() => {
  uninstallStubPool();
  for (const name of CONTROLLED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/* ── calling the handlers ──────────────────────────────────────────────────── */

const APPROVALS_INSERT = "INSERT INTO evestack.approvals";

/** The approvals schema bootstrap and the audit INSERT both go through here. */
function stubApprovalsDb(routes = []) {
  return installStubPool(routes);
}

async function post(id, body, headers = {}) {
  const request = new Request(`http://dashboard.test/api/control/sessions/${id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await POST(request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function get(id) {
  const request = new Request(`http://dashboard.test/api/control/sessions/${id}/approve`);
  const response = await GET(request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Runs `fn` with console.warn captured, and returns what it wrote. */
async function captureWarnings(fn) {
  const written = [];
  const original = console.warn;
  console.warn = (...args) => written.push(args.join(" "));
  try {
    return { result: await fn(), warnings: written };
  } finally {
    console.warn = original;
  }
}

/* ── refusals: a decision that must not be absorbed ────────────────────────── */

test("a session eve has never heard of is a 404, not an ok with nothing pending", async () => {
  // eve serves an empty stream rather than a 404 for an unknown id, so this
  // judgement is the dashboard's to make. GET answered ok:true here once, while
  // the sibling `message` route returned 404 for the same id — leaving a UI
  // unable to tell a typo from a quiet turn.
  const read = await get("wrun_never_seen");
  assert.equal(read.status, 404);
  assert.equal(read.body.code, "session_not_found");

  stubApprovalsDb();
  const decided = await post("wrun_never_seen", { decision: "approve" });
  assert.equal(decided.status, 404);
  assert.notEqual(decided.body.ok, true);
  assert.deepEqual(resumed, [], "a decision for a session that does not exist reached the agent");
});

test("a decision that is neither approve nor deny is refused before anything resumes", async () => {
  parked("wrun_bogus");
  stubApprovalsDb();
  const { status, body } = await post("wrun_bogus", { decision: "maybe" });
  assert.equal(status, 400);
  assert.equal(body.code, "bad_request");
  assert.deepEqual(resumed, [], "answerInput() was reached with something no tool can read");
});

test("an unparseable body is a 400, not a 500", async () => {
  parked("wrun_notjson");
  const { status, body } = await post("wrun_notjson", "this is not json");
  assert.equal(status, 400);
  assert.equal(body.code, "bad_request");
  assert.deepEqual(resumed, []);
});

test("a session that has already ended cannot be approved", async () => {
  streams.set("wrun_done", [
    { type: "turn.started", data: { turnId: "trn_1" } },
    { type: "session.completed", data: {} },
  ]);
  stubApprovalsDb();
  const { status, body } = await post("wrun_done", { decision: "approve" });
  assert.equal(status, 409);
  assert.equal(body.code, "session_terminal");
  assert.deepEqual(resumed, []);
});

test("approving a session that is not waiting on anyone is refused", async () => {
  // The probe's central case, and the one it can reach without a provider key:
  // a real session, nothing outstanding. A 200 here means an operator can
  // believe a gated tool call was authorised when no audit row was ever written.
  streams.set("wrun_idle", [
    { type: "turn.started", data: { turnId: "trn_1" } },
    { type: "session.waiting", data: { continuationToken: "ct_live" } },
  ]);
  const pool = stubApprovalsDb();
  const { status, body } = await post("wrun_idle", { decision: "approve" });

  assert.equal(status, 409);
  assert.equal(body.code, "no_pending_input");
  assert.notEqual(body.ok, true);
  assert.deepEqual(resumed, []);
  assert.deepEqual(pool.matching(APPROVALS_INSERT), [], "an audit row for a decision nobody made");
});

test("naming a requestId that is not outstanding is refused rather than matched loosely", async () => {
  parked("wrun_named");
  const pool = stubApprovalsDb();
  const { status, body } = await post("wrun_named", {
    decision: "deny",
    requestId: "req_not_a_real_request",
  });
  assert.equal(status, 409);
  assert.equal(body.code, "unknown_request");
  assert.deepEqual(resumed, []);
  assert.deepEqual(pool.matching(APPROVALS_INSERT), []);
});

test("two outstanding requests and one bare decision is ambiguous, not a blanket yes", async () => {
  // Answering everything at once is only unambiguous when there is exactly one.
  // Otherwise a single `approve` silently authorises prompts the caller never saw.
  parked("wrun_two", [
    TOOL_APPROVAL,
    { ...TOOL_APPROVAL, requestId: "req_2", action: { toolName: "write_file", callId: "call_2" } },
  ]);
  const pool = stubApprovalsDb();
  const { status, body } = await post("wrun_two", { decision: "approve" });

  assert.equal(status, 409);
  assert.equal(body.code, "ambiguous_request");
  assert.match(body.error, /req_1/);
  assert.match(body.error, /req_2/);
  assert.deepEqual(resumed, []);
  assert.deepEqual(pool.matching(APPROVALS_INSERT), []);
});

test("a turn with no continuation token yet is busy, not approvable", async () => {
  // The token rotates every turn and is published on `session.waiting`. Without
  // one there is no boundary to resume from, so there is nothing to say yes to.
  streams.set("wrun_busy", [{ type: "turn.started", data: { turnId: "trn_1" } }]);
  stubApprovalsDb();
  const { status, body } = await post("wrun_busy", { decision: "approve" });
  assert.equal(status, 409);
  assert.equal(body.code, "session_busy");
  assert.deepEqual(resumed, []);
});

test("an option the request does not offer never reaches the model", async () => {
  parked("wrun_option");
  stubApprovalsDb();
  const { status, body } = await post("wrun_option", { optionId: "sudo" });
  assert.equal(status, 400);
  assert.equal(body.code, "unknown_option");
  assert.match(body.error, /approve, deny/);
  assert.deepEqual(resumed, []);
});

test("freeform text is refused where the request forbids it", async () => {
  parked("wrun_freeform", [
    { requestId: "req_1", kind: "question", allowFreeform: false, options: [{ id: "a" }] },
  ]);
  stubApprovalsDb();
  const { status, body } = await post("wrun_freeform", { text: "whatever you think" });
  assert.equal(status, 400);
  assert.equal(body.code, "freeform_not_allowed");
  assert.deepEqual(resumed, []);
});

/* ── the identity refusal ──────────────────────────────────────────────────── */

test("EVESTACK_REQUIRE_APPROVER refuses BEFORE the turn is resumed", async () => {
  // The ordering is the entire feature. A deployment that demands a named
  // approver must refuse the decision, not discover afterwards that it could
  // not attribute one it had already carried out — an unattributable approval
  // that already executed cannot be taken back.
  process.env.EVESTACK_REQUIRE_APPROVER = "1";
  parked("wrun_anon");
  const pool = stubApprovalsDb();

  const { status, body } = await post("wrun_anon", { decision: "approve" });

  assert.equal(status, 403);
  assert.equal(body.code, "approver_required");
  assert.deepEqual(resumed, [], "the gated tool call was approved by nobody, and then ran");
  assert.deepEqual(pool.matching(APPROVALS_INSERT), []);
});

test("the refusal explains why a forwarded header did not count", async () => {
  // Someone hitting this has almost certainly already tried X-Forwarded-User.
  // It is ignored until EVESTACK_TRUSTED_PROXY says a proxy sets it, and the
  // message has to say so or the operator concludes the flag is broken.
  process.env.EVESTACK_REQUIRE_APPROVER = "1";
  parked("wrun_anon2");
  stubApprovalsDb();
  const { body } = await post(
    "wrun_anon2",
    { decision: "approve" },
    { "x-forwarded-user": "someone.else@example.com" },
  );
  assert.equal(body.code, "approver_required");
  assert.match(body.error, /EVESTACK_TRUSTED_PROXY/);
  assert.deepEqual(resumed, []);
});

/* ── the decision that is carried out, and its audit row ───────────────────── */

test("an approval resumes the turn with eve's own follow-up shape", async () => {
  parked("wrun_ok");
  stubApprovalsDb();
  const { status, body } = await post("wrun_ok", { decision: "approve" });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].id, "wrun_ok");
  assert.equal(
    resumed[0].body.continuationToken,
    "ct_live",
    "the token was read off session.waiting rather than demanded from the browser",
  );
  assert.deepEqual(resumed[0].body.inputResponses, [{ requestId: "req_1", optionId: "approve" }]);
  assert.equal(body.resolvedContinuationToken, true);
});

test("a denial is the same path with the other option, not a different one", async () => {
  parked("wrun_deny");
  stubApprovalsDb();
  const { status } = await post("wrun_deny", { decision: "deny" });
  assert.equal(status, 200);
  assert.deepEqual(resumed[0].body.inputResponses, [{ requestId: "req_1", optionId: "deny" }]);
});

test("the audit row records who decided what, on which tool", async () => {
  parked("wrun_audit");
  const pool = stubApprovalsDb();
  const { body } = await post("wrun_audit", { decision: "approve" });

  assert.equal(body.audited, true);
  const [insert] = pool.matching(APPROVALS_INSERT);
  assert.ok(insert, "no audit row was written for a decision that took effect");
  const [sessionId, turnId, requestId, requestKind, toolName, optionId, , approver, via] =
    insert.params;
  assert.equal(sessionId, "wrun_audit");
  assert.equal(turnId, "trn_1", "the turn is named, so the row can be tied to what it authorised");
  assert.equal(requestId, "req_1");
  assert.equal(requestKind, "tool-approval");
  assert.equal(toolName, "bash");
  assert.equal(optionId, "approve");
  assert.equal(approver, null);
  assert.equal(via, "unidentified", "a gap in an audit log is worse visible than invisible");
  assert.equal(body.approverVia, "unidentified", "and the caller is told the same thing");
});

test("the audit row is written AFTER eve accepts, never before", async () => {
  // Logging first would record approvals that never took effect. An audit log
  // that overstates what happened is worse than one that is a moment behind.
  parked("wrun_order");
  const pool = stubApprovalsDb();
  // The FIRST insert, not the last: a route that logged early and then logged
  // again after the agent replied would otherwise overwrite its own evidence.
  let resumedCountAtInsert = null;
  const originalPoolQuery = globalThis.__evestackPool.query.bind(globalThis.__evestackPool);
  globalThis.__evestackPool.query = async (text, params) => {
    if (String(text).includes(APPROVALS_INSERT) && resumedCountAtInsert === null) {
      resumedCountAtInsert = resumed.length;
    }
    return originalPoolQuery(text, params);
  };

  await post("wrun_order", { decision: "approve" });

  assert.ok(pool.matching(APPROVALS_INSERT).length > 0, "nothing was audited, so this proves nothing");
  assert.equal(resumedCountAtInsert, 1, "the row was written before the agent had accepted");
});

test("a forgeable header is not believed, and the audit row says unidentified", async () => {
  // `curl -H 'X-Forwarded-User: someone.else@example.com'` used to stamp a
  // colleague's name on the row. A forgeable audit log is worse than no audit
  // log, because it invites people to rely on it.
  parked("wrun_forged");
  const pool = stubApprovalsDb();
  const { body } = await post(
    "wrun_forged",
    { decision: "approve" },
    { "x-forwarded-user": "someone.else@example.com" },
  );

  assert.equal(body.approver, null);
  assert.equal(body.approverVia, "unidentified");
  const [insert] = pool.matching(APPROVALS_INSERT);
  assert.equal(insert.params[7], null);
  assert.equal(insert.params[8], "unidentified");
  assert.ok(
    !JSON.stringify(insert.params).includes("someone.else@example.com"),
    "an unproved name reached the audit log",
  );
});

test("behind a trusted proxy the same header IS the approver, and is recorded as such", async () => {
  process.env.EVESTACK_TRUSTED_PROXY = "1";
  parked("wrun_proxied");
  const pool = stubApprovalsDb();
  const { body } = await post(
    "wrun_proxied",
    { decision: "approve" },
    { "x-forwarded-user": "ops@example.com", "x-forwarded-for": "203.0.113.9" },
  );

  assert.equal(body.approver, "ops@example.com");
  assert.equal(body.approverVia, "forwarded-user");
  const [insert] = pool.matching(APPROVALS_INSERT);
  assert.equal(insert.params[7], "ops@example.com");
  assert.equal(insert.params[8], "forwarded-user");
  assert.equal(insert.params[9], "203.0.113.9", "the nearest hop is recorded alongside the name");
});

/* ── the audit write that fails ────────────────────────────────────────────── */

test("a failed audit write is reported, not swallowed", async () => {
  // Swallowed on purpose — the decision has already reached the agent, and
  // failing the request now would report failure for something that succeeded —
  // but NOT silently, which is what this was: a 200, no log line, and an
  // `audited: false` in a body no caller reads.
  parked("wrun_noaudit");
  stubApprovalsDb([[APPROVALS_INSERT, new Error("57P01: terminating connection")]]);

  const { result, warnings } = await captureWarnings(() =>
    post("wrun_noaudit", { decision: "approve" }),
  );

  assert.equal(result.status, 200, "the decision reached the agent; the request did not fail");
  assert.equal(result.body.ok, true);
  assert.equal(result.body.audited, false, "the response has to admit the row is missing");
  assert.equal(resumed.length, 1, "and the turn really was resumed");
  assert.equal(warnings.length, 1, "a failed approval audit left no trace anywhere");
  assert.match(warnings[0], /approval audit row could not be written/);
  assert.match(warnings[0], /wrun_noaudit/, "the warning names the session it is about");
});

test("a database that is down entirely still cannot un-approve what happened", async () => {
  // Every statement refused, not just the INSERT — the shape of a Postgres that
  // is simply not there. (Measured: ensureApprovalSchema caches its success for
  // the life of the process, so by this point in the file the bootstrap no
  // longer re-runs and it is the INSERT that is refused. The claim under test is
  // the one that holds either way: no database failure turns a decision the
  // agent has already accepted into a failed request.)
  parked("wrun_dbdown");
  stubApprovalsDb([[/./, new Error("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:5433")]]);

  const { result, warnings } = await captureWarnings(() =>
    post("wrun_dbdown", { decision: "approve" }),
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.audited, false);
  assert.equal(resumed.length, 1);
  assert.match(warnings[0], /ECONNREFUSED/);
});

test("`audited` is present on every successful decision, so its absence is a bug", async () => {
  parked("wrun_flag");
  stubApprovalsDb();
  const { body } = await post("wrun_flag", { decision: "approve" });
  assert.equal(Object.hasOwn(body, "audited"), true);
  assert.equal(typeof body.audited, "boolean");
});
