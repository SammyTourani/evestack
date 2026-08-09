import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { McpServer } from "../dist/server.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES_ENV,
  MIN_MAX_OUTPUT_BYTES,
  fitToolPayload,
} from "../dist/truncate.js";

/**
 * The output cap.
 *
 * Before this existed, `toolResult` serialised whatever a handler returned and
 * sent all of it. Measured against a dashboard answering with the shapes and the
 * LIMITs the real routes enforce, `list_approvals` produced 562,138 bytes —
 * ~140k tokens of audit log in one tool call, with nothing telling the caller.
 *
 * Two properties are worth more than the rest and are tested hardest:
 *
 *  1. The returned text is never over the cap. A cap that a big enough payload
 *     can walk through is not a cap.
 *  2. A shortened result never passes for a whole one. `_truncated` is the first
 *     key in the payload, `cuts` names every array and string that lost content,
 *     and a clipped string carries a marker inline — because "who approved
 *     this?" answered from a silently clipped audit log reads as "nobody did".
 *
 * The last group needs a dashboard, so it uses a loopback `node:http` server
 * rather than the real one. server.test.mjs deliberately touches no network at
 * all and that invariant is left alone; this file is the one that has to prove
 * the cap holds through the whole tools/call path, not just in the pure helper.
 */

const bytes = (text) => Buffer.byteLength(text, "utf8");

/** Uniform rows, so "how much fitted" is a meaningful number rather than luck. */
const approvalRows = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `a1b2c3d4-e5f6-4a7b-8c9d-${String(i).padStart(12, "0")}`,
    sessionId: "wrun_01KZ8CQ5012M1M9P6YE7YG3FJ3",
    toolName: "shell.exec",
    approver: "sammy@example.com",
    approverVia: "forwarded-user",
    decidedAt: "2026-08-09T12:00:00.000Z",
  }));

// ---------------------------------------------------------------------------
// The cap itself
// ---------------------------------------------------------------------------

test("a result that already fits is returned byte-for-byte untouched", () => {
  const payload = { totals: { sessions: 812 }, listed: 5, sessions: approvalRows(3) };
  const fitted = fitToolPayload(payload, DEFAULT_MAX_OUTPUT_BYTES);

  assert.equal(fitted.truncated, false);
  assert.equal(fitted.payload, payload, "the very same object, not a copy");
  assert.equal(fitted.text, JSON.stringify(payload, null, 2));
  assert.equal(fitted.payload._truncated, undefined, "no notice on a result that lost nothing");
});

test("THE CAP HOLDS: an oversized result is never returned over the limit", () => {
  // 1000 rows is /api/approvals' own MAX_APPROVALS, so this is the ceiling a
  // real deployment can actually hand back, not a synthetic worst case.
  const payload = { count: 1000, unidentified: 12, approvals: approvalRows(1000) };
  const full = bytes(JSON.stringify(payload, null, 2));

  for (const limit of [1024, 4096, 8192, 65_536, 200_000]) {
    const fitted = fitToolPayload(payload, limit);
    assert.ok(
      bytes(fitted.text) <= limit,
      `limit ${limit}: returned ${bytes(fitted.text)} bytes (full result is ${full})`,
    );
  }
});

test("a truncated result is still valid JSON, and the text matches the structured copy", () => {
  const fitted = fitToolPayload({ approvals: approvalRows(1000) }, 8192);
  assert.equal(fitted.truncated, true);
  // Would fail outright if the cap were implemented by slicing the serialized
  // text, which is the obvious implementation and hands back a half-object.
  assert.deepEqual(JSON.parse(fitted.text), fitted.payload);
});

test("the notice is the FIRST key, so a model reading top-down meets it before the data", () => {
  const fitted = fitToolPayload({ approvals: approvalRows(1000) }, 8192);
  assert.equal(Object.keys(fitted.payload)[0], "_truncated");
  assert.match(fitted.text.slice(0, 40), /"_truncated"/);
  assert.match(fitted.payload._truncated.reason, /INCOMPLETE/);
  assert.equal(fitted.payload._truncated.configuredBy, MAX_OUTPUT_BYTES_ENV);
});

test("the notice's byte accounting describes what was actually sent", () => {
  const payload = { approvals: approvalRows(1000) };
  const fitted = fitToolPayload(payload, 8192);
  const notice = fitted.payload._truncated;

  assert.equal(notice.limitBytes, 8192);
  assert.equal(notice.originalBytes, bytes(JSON.stringify(payload, null, 2)));
  assert.equal(notice.returnedBytes, bytes(fitted.text), "returnedBytes is measured, not estimated");
  assert.equal(notice.droppedBytes, notice.originalBytes - notice.returnedBytes);
  assert.ok(notice.droppedBytes > 0);
});

test("`cuts` names the shortened array and its arithmetic is honest", () => {
  const fitted = fitToolPayload({ count: 1000, approvals: approvalRows(1000) }, 8192);
  const [cut, ...rest] = fitted.payload._truncated.cuts;

  assert.deepEqual(rest, [], "one array was cut, so one entry");
  assert.equal(cut.path, "approvals");
  assert.equal(cut.unit, "items");
  assert.equal(cut.kept + cut.dropped, 1000);
  assert.equal(fitted.payload.approvals.length, cut.kept, "the array really has `kept` rows in it");
  // `count` is the dashboard's own row count and is deliberately NOT rewritten:
  // the notice reports what this server dropped, not what the dashboard found.
  assert.equal(fitted.payload.count, 1000);
});

test("a clipped string says so INLINE, not only in the notice", () => {
  // An array that lost its tail still looks like an array. A generated eval
  // clipped mid-file looks exactly like a small generated eval, which is the
  // failure this marker exists to prevent — promote_session_to_eval's whole
  // output is one string the user is told to save to a file.
  const source = "export const x = 1;\n".repeat(4000);
  const fitted = fitToolPayload({ filename: "a.eval.ts", source, warnings: [] }, 4096);
  const [cut] = fitted.payload._truncated.cuts;

  assert.equal(cut.path, "source");
  assert.equal(cut.unit, "characters");
  assert.equal(cut.kept + cut.dropped, source.length);
  assert.match(fitted.payload.source, /…\[\d+ characters dropped by EVESTACK_MCP_MAX_OUTPUT_BYTES/);
  assert.ok(fitted.payload.source.startsWith("export const x = 1;"), "the kept half is verbatim");
});

test("it cuts as little as it can get away with", () => {
  // Regression test for the first implementation, which sized the cut by
  // dividing the node's standalone byte size by its element count. A node
  // serialised on its own carries less indentation than the same node nested in
  // the result, so that estimate ran low and the cut ran long — it gave back a
  // large fraction of the budget, and every byte of budget given back is audit
  // rows the caller does not get. The 90% floor below is what pins that shut.
  // Measured on this payload with the current search: 7,979 B at an 8,192 cap,
  // 32,733 B at 32,768, and 65,458 B at 65,536.
  const payload = { approvals: approvalRows(1000) };
  for (const limit of [8192, 32_768, 65_536]) {
    const fitted = fitToolPayload(payload, limit);
    const used = bytes(fitted.text);
    assert.ok(used <= limit, `${limit}: ${used}`);
    assert.ok(
      used >= limit * 0.9,
      `limit ${limit}: only ${used} bytes returned — the cut is throwing away rows that fit`,
    );
  }
});

test("the biggest node is the one that gives, and small siblings survive whole", () => {
  const fitted = fitToolPayload(
    {
      sessionId: "wrun_01KZ8CQ5012M1M9P6YE7YG3FJ3",
      limits: { sessionUsd: 5, dailyUsd: 50 },
      budgetStops: [{ reason: "session cap $5.00 exceeded" }],
      budgetEvents: approvalRows(1000),
    },
    8192,
  );

  assert.deepEqual(fitted.payload.limits, { sessionUsd: 5, dailyUsd: 50 });
  assert.equal(fitted.payload.budgetStops.length, 1);
  assert.deepEqual(
    fitted.payload._truncated.cuts.map((cut) => cut.path),
    ["budgetEvents"],
  );
});

test("a nested path is named all the way down", () => {
  const fitted = fitToolPayload(
    { live: { pendingRequests: [{ action: { input: { contents: "x".repeat(40_000) } } }] } },
    2048,
  );
  assert.equal(fitted.payload._truncated.cuts[0].path, "live.pendingRequests[0].action.input.contents");
});

test("the cap counts BYTES, not characters", () => {
  // `String.length` is UTF-16 code units. A session full of CJK or emoji costs
  // up to 4 bytes a character, so a character-counting cap would let a result
  // through at several times the configured size.
  const payload = { source: "日本語のテキスト🙂".repeat(4000) };
  const fitted = fitToolPayload(payload, 4096);
  assert.ok(bytes(fitted.text) <= 4096, `${bytes(fitted.text)} bytes`);
  assert.ok(fitted.text.length < 4096, "sanity: the char count is well under, the byte count is not");
});

// ---------------------------------------------------------------------------
// More shrinkable nodes than the search has passes
// ---------------------------------------------------------------------------

/** N sibling arrays, so "how many nodes can the search handle" is the only variable. */
const buckets = (count, rowsEach) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `bucket_${String(i).padStart(3, "0")}`,
      Array.from({ length: rowsEach }, (_, j) => ({
        id: `req_${i}_${j}`,
        toolName: "shell.exec",
        approver: "sammy@example.com",
      })),
    ]),
  );

const rowsIn = (payload) =>
  Object.entries(payload)
    .filter(([key]) => key !== "_truncated")
    .reduce((total, [, value]) => total + (Array.isArray(value) ? value.length : 0), 0);

test("MORE NODES THAN PASSES: the result does not fall off a cliff to zero rows", () => {
  // The pass limit used to be a flat 32, and a payload with more shrinkable
  // nodes than that spent every pass driving one node to its floor, never
  // reached a document that fits, and fell through to the notice-only payload.
  // Measured against the pre-fix build on this exact payload family at the
  // default cap: 40 buckets returned 65,407 bytes and 568 rows, and 50 buckets
  // returned 833 bytes and 0 rows. Ten more rows of input, and the answer became
  // no answer.
  const fitted = fitToolPayload(buckets(50, 40), DEFAULT_MAX_OUTPUT_BYTES);

  assert.ok(bytes(fitted.text) <= DEFAULT_MAX_OUTPUT_BYTES, `${bytes(fitted.text)} bytes`);
  assert.ok(rowsIn(fitted.payload) > 400, `only ${rowsIn(fitted.payload)} rows came back`);
  assert.ok(
    bytes(fitted.text) >= DEFAULT_MAX_OUTPUT_BYTES * 0.9,
    `only ${bytes(fitted.text)} of ${DEFAULT_MAX_OUTPUT_BYTES} bytes used`,
  );
  assert.equal(Object.keys(fitted.payload).length, 51, "every bucket still has a row in it");
  assert.doesNotMatch(fitted.notice.reason, /NOTHING of the result fit/);
});

test("RUNNING OUT OF PASSES SAYS SO, and still returns a row of every list", () => {
  // 220 nodes is past the pass ceiling, so this is the path that genuinely
  // cannot finish the search. The old code answered it with the notice alone AND
  // with "it has no array or string large enough to shorten", which was false —
  // it had 220 of them and ran out of passes. Both halves are fixed here: rows
  // come back, and the reason names the real cause.
  const fitted = fitToolPayload(buckets(220, 6), DEFAULT_MAX_OUTPUT_BYTES);

  assert.ok(bytes(fitted.text) <= DEFAULT_MAX_OUTPUT_BYTES, `${bytes(fitted.text)} bytes`);
  assert.equal(rowsIn(fitted.payload), 220, "one row survives in every bucket");
  assert.match(fitted.notice.reason, /search budget/);
  assert.match(fitted.notice.reason, /MORE was dropped than the cap strictly required/);
  assert.doesNotMatch(
    fitted.notice.reason,
    /no array or string large enough to shorten/,
    "the search ran out of passes; saying there was nothing to cut is a lie about 220 arrays",
  );
  assert.equal(fitted.notice.cuts.length, 220, "and every one of them is named");
});

test("the notice-only fallback tells its two dead ends apart", () => {
  // Dead end one: nothing in the payload is shrinkable.
  const scalars = fitToolPayload(
    Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`key_${i}`, i])),
    MIN_MAX_OUTPUT_BYTES,
  );
  assert.match(scalars.notice.reason, /no array or string large enough to shorten/);

  // Dead end two: plenty was shrinkable, all of it was cut to the floor, and the
  // floors still do not fit. Same empty payload, completely different fact, and
  // the caller is entitled to know which one they are looking at — one is fixed
  // by raising the cap a little, the other by raising it a great deal.
  const strings = fitToolPayload(
    Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, "x".repeat(2000)])),
    MIN_MAX_OUTPUT_BYTES,
  );
  assert.match(strings.notice.reason, /even with every array cut to 1 element/);
  assert.doesNotMatch(strings.notice.reason, /no array or string large enough to shorten/);
  assert.deepEqual(Object.keys(strings.payload), ["_truncated"]);
  assert.ok(bytes(strings.text) <= MIN_MAX_OUTPUT_BYTES, `${bytes(strings.text)} bytes`);
});

test("`notice` is the same object the payload carries, so they cannot disagree", () => {
  const fitted = fitToolPayload({ approvals: approvalRows(1000) }, 8192);
  assert.equal(fitted.notice, fitted.payload._truncated);
  assert.equal(fitToolPayload({ a: 1 }, 8192).notice, null, "null when nothing was cut");
});

test("when nothing can be shortened, the notice comes back alone rather than over-cap", () => {
  // No array over one element and no string over the floor, but thousands of
  // keys. There is nothing to cut, and returning it anyway would make the cap a
  // suggestion.
  const payload = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`key_${i}`, i]));
  const fitted = fitToolPayload(payload, MIN_MAX_OUTPUT_BYTES);

  assert.equal(fitted.truncated, true);
  assert.ok(bytes(fitted.text) <= MIN_MAX_OUTPUT_BYTES, `${bytes(fitted.text)} bytes`);
  assert.deepEqual(Object.keys(fitted.payload), ["_truncated"]);
  assert.match(fitted.payload._truncated.reason, /NOTHING of the result fit/);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("the default cap is 64 KiB and the variable overrides it", () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 65_536);
  assert.equal(loadConfig({}).maxOutputBytes, 65_536);
  assert.equal(loadConfig({ [MAX_OUTPUT_BYTES_ENV]: "200000" }).maxOutputBytes, 200_000);
  assert.equal(loadConfig({ [MAX_OUTPUT_BYTES_ENV]: " 4096 " }).maxOutputBytes, 4096);
});

test("a cap that cannot fit its own notice is rejected at startup, not clamped", () => {
  // Rejected rather than clamped for the same reason EVESTACK_MCP_TIMEOUT_MS is:
  // silently substituting a different number is how a cap gets blamed for
  // truncating at a size nobody configured.
  for (const value of ["0", "-1", "512", "abc", "64kb", "1e3", "1024.5", ""]) {
    if (value === "") {
      assert.equal(loadConfig({ [MAX_OUTPUT_BYTES_ENV]: value }).maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
      continue;
    }
    assert.throws(
      () => loadConfig({ [MAX_OUTPUT_BYTES_ENV]: value }),
      new RegExp(`${MAX_OUTPUT_BYTES_ENV} must be a whole number of bytes`),
      value,
    );
  }
  assert.equal(loadConfig({ [MAX_OUTPUT_BYTES_ENV]: "1024" }).maxOutputBytes, MIN_MAX_OUTPUT_BYTES);
});

// ---------------------------------------------------------------------------
// End to end, through tools/call
// ---------------------------------------------------------------------------

/** A dashboard that answers /api/approvals with `rows` rows and nothing else. */
function fakeDashboard(rows) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: rows, truncated: true, approvals: approvalRows(rows) }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const started = [];
after(() => {
  for (const server of started) server.close();
});

async function callAgainst(rows, env) {
  const { server, port } = await fakeDashboard(rows);
  started.push(server);
  const mcp = new McpServer(loadConfig({ EVESTACK_MCP_DASHBOARD_URL: `http://127.0.0.1:${port}`, ...env }));
  await mcp.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" } },
  });
  const { response } = await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_approvals", arguments: {} },
  });
  return response;
}

test("END TO END: a 1000-row audit log comes back inside the cap", async () => {
  const response = await callAgainst(1000, {});
  const text = response.content[0].text;

  assert.ok(bytes(text) <= DEFAULT_MAX_OUTPUT_BYTES, `${bytes(text)} bytes came back`);
  assert.equal(response.isError, false);
  assert.ok(response.structuredContent._truncated, "and it says it was cut");
  assert.ok(response.structuredContent.approvals.length < 1000);
});

test("structuredContent carries the SAME fitted payload, not an uncapped copy", async () => {
  // The spec prefers `structuredContent`, so a client that reads it would have
  // been the one client the cap never applied to.
  const response = await callAgainst(1000, {});
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  assert.ok(
    bytes(JSON.stringify(response.structuredContent, null, 2)) <= DEFAULT_MAX_OUTPUT_BYTES,
  );
});

test("a small result goes through the cap unmarked", async () => {
  const response = await callAgainst(3, {});
  assert.equal(response.structuredContent._truncated, undefined);
  assert.equal(response.structuredContent.count, 3);
  assert.equal(response.structuredContent.approvals.length, 3);
});

test("EVESTACK_MCP_MAX_OUTPUT_BYTES reaches the tool path, not just loadConfig", async () => {
  const response = await callAgainst(1000, { [MAX_OUTPUT_BYTES_ENV]: "4096" });
  assert.ok(bytes(response.content[0].text) <= 4096, `${bytes(response.content[0].text)} bytes`);
  assert.equal(response.structuredContent._truncated.limitBytes, 4096);
});

// ---------------------------------------------------------------------------
// The documented sizes are the measured sizes
// ---------------------------------------------------------------------------

test("THE README'S SIZE TABLE IS WHAT THE MEASUREMENT PRINTS", async () => {
  // WHY THIS TEST EXISTS. That table used to claim `list_approvals` with no
  // limit returned 562,138 B — a figure wrong about its own route, which
  // defaults the whole-log arm to 200 rows and can only reach 1000 through
  // `?sessionId=`. Nobody could tell, because the number had no source. Now it
  // has one, and this fails the moment the prose and the source disagree:
  // either someone edited a figure by hand, or a tool's result shape changed and
  // the docs went stale. Both are the same defect.
  const here = import.meta.dirname;
  const measured = spawnSync(process.execPath, [join(here, "measure-output-sizes.mjs")], {
    encoding: "utf8",
  });
  assert.equal(measured.status, 0, measured.stderr);

  // Lines look like: "  get_costs (200 principals)   81,942 B   ~20k tokens".
  const rows = [...measured.stdout.matchAll(/^ {2}(\S.*?) {2,}([\d,]+) B {3}~([\d.]+k) tokens$/gm)];
  assert.ok(rows.length >= 7, `parsed ${rows.length} rows from the measurement output`);

  const readme = readFileSync(join(here, "..", "README.md"), "utf8");
  const header = readFileSync(join(here, "..", "src", "truncate.ts"), "utf8");
  for (const [, label, size, tokens] of rows) {
    assert.ok(readme.includes(`${size} B`), `README.md does not carry ${size} B (${label})`);
    assert.ok(
      readme.includes(`| ${tokens} |`) || readme.includes(`**${tokens}**`),
      `README.md does not carry the ~${tokens} token figure for ${label}`,
    );
    assert.ok(header.includes(`${size} B`), `src/truncate.ts does not carry ${size} B (${label})`);
  }
});

/**
 * The floor path must not let the ACCOUNTING crowd out the answer.
 *
 * The pass-cliff fix above ends in a floor batch: cut every remaining node to
 * its floor and see whether that fits. It assembled with the complete `cuts`
 * list, and gave up if the two together were over the cap — so a payload with
 * enough shrinkable nodes produced a `cuts` list large enough to sink a
 * document that would otherwise have fitted comfortably. Measured at a 64 KiB
 * cap, before the fix:
 *
 *   200 arrays x 20 light rows   floored data 61,692 B   returned 914 B, 0 rows
 *    80 arrays x 20 heavy rows   floored data 43,832 B   returned 914 B, 0 rows
 *
 * In both the data fit with room to spare and the caller got nothing but a
 * notice — one whose text asserted the data was too big, which was untrue.
 *
 * A caller can act on one real row. It can do nothing with the two-hundredth
 * entry of a list of paths. So the cuts list is what yields, and `cutsOmitted`
 * says how many it stopped naming.
 */
test("the floor path returns data when the floored data fits, even with hundreds of cuts", () => {
  const heavyRow = () => ({
    id: `apr_${"x".repeat(24)}`,
    session: `wrun_${"y".repeat(26)}`,
    tool: "bash",
    args: "z".repeat(300),
    reason: "w".repeat(400),
  });
  const payload = {};
  for (let i = 0; i < 80; i += 1) payload[`list${i}`] = Array.from({ length: 20 }, heavyRow);

  const result = fitToolPayload(payload, 65536);
  const rows = Object.keys(result.payload)
    .filter((k) => Array.isArray(result.payload[k]))
    .reduce((sum, k) => sum + result.payload[k].length, 0);

  // ANTI-VACUITY: the point of the test is that data came back, so assert on
  // the data. `truncated === true` would pass over the collapsed payload too.
  assert.ok(rows > 0, `the floored data fits at this cap, so rows must survive — got ${rows}`);
  assert.equal(rows, 80, "one row of every list, which is what the floor keeps");
  assert.ok(result.text.length <= 65536, "and the cap still holds");
  assert.ok(
    result.notice.cuts.length + result.notice.cutsOmitted >= 80,
    "every cut is accounted for, whether named individually or counted in cutsOmitted",
  );
});
