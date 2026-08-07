/**
 * Two route guards that answered 500 to requests they had already decided how to
 * answer.
 *
 *   DELETE /api/memories/99999999999999999999999999
 *     The id matched `/^\d+$/` and the column is a bigserial, so Postgres refused
 *     the parameter with `value "…" is out of range for type bigint` and
 *     handleRouteError turned the driver's message into a 500 — for a request
 *     whose only fault is naming a memory that cannot exist. The route already
 *     had "No memory <id>." four lines further down.
 *
 *   GET /api/control/sessions/:id/stream?startIndex=100000000000000000000
 *     21 digits, so the integer regex accepted it. Every SSE frame's `id:` comes
 *     from `index += 1`, which past 2^53 is not an increment at all, so every
 *     frame carried the same id and Last-Event-ID resumption — the property the
 *     route's own header promises is exact — silently stopped working.
 *
 * NOTE ON LOADING. Route files import their dependencies through the "@/…"
 * tsconfig path alias, which Node's resolver knows nothing about;
 * test/register-ts-resolve.mjs only adds extensions to relative specifiers. The
 * hook below maps the alias for this file, so the handlers can be called as plain
 * functions — no server, no bundler.
 *
 * WORKFLOW_POSTGRES_URL is deleted for the whole file on purpose. It makes the
 * database the negative control: a request that got as far as querying comes back
 * 500 `internal_error`, so a 404 or a 400 here is proof the check under test ran
 * before anything was asked of Postgres.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

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

const { DELETE: deleteMemory } = await import("../app/api/memories/[id]/route.ts");
const { GET: openStream } = await import("../app/api/control/sessions/[id]/stream/route.ts");

const saved = {};
beforeEach(() => {
  for (const name of ["WORKFLOW_POSTGRES_URL", "DATABASE_URL", "EVESTACK_AGENT_URL"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function del(id) {
  const request = new Request(`http://dashboard.test/api/memories/${id}`, { method: "DELETE" });
  const response = await deleteMemory(request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
}

async function stream(search, headers = {}) {
  const request = new Request(`http://dashboard.test/api/control/sessions/s1/stream${search}`, { headers });
  const response = await openStream(request, { params: Promise.resolve({ id: "s1" }) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/* -------------------------------------------------------------------------- */
/* DELETE /api/memories/:id                                                    */
/* -------------------------------------------------------------------------- */

test("an id past bigint is the 404 the route already meant", async () => {
  const { status, body } = await del("99999999999999999999999999");
  assert.equal(status, 404);
  assert.equal(body.code, "not_found");
  assert.match(body.error, /No memory 99999999999999999999999999\./);
});

test("the boundary is the last id the column can hold", async () => {
  // 2^63 - 1 exists as a value, so it must reach the database rather than be
  // refused here. With no WORKFLOW_POSTGRES_URL that shows up as 500.
  const inRange = await del("9223372036854775807");
  assert.equal(inRange.status, 500, "the largest bigint must not be turned away");
  assert.equal(inRange.body.code, "internal_error");

  const justPast = await del("9223372036854775808");
  assert.equal(justPast.status, 404);
});

test("a non-numeric id is still the 400 it always was", async () => {
  for (const id of ["abc", "12a", "-1", "1.0", "1e9", " 1"]) {
    const { status, body } = await del(id);
    assert.equal(status, 400, `${JSON.stringify(id)} -> ${status}`);
    assert.equal(body.code, "bad_request");
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/control/sessions/:id/stream                                        */
/* -------------------------------------------------------------------------- */

test("a startIndex past exact integer arithmetic is refused", async () => {
  for (const value of ["100000000000000000000", "9007199254740993", "1000000000001"]) {
    const { status, body } = await stream(`?startIndex=${value}`);
    assert.equal(status, 400, `${value} -> ${status}`);
    assert.equal(body.code, "bad_request");
    assert.match(body.error, /startIndex/);
  }
});

test("the same bound applies to a negative startIndex, which is tail-relative", async () => {
  const { status, body } = await stream("?startIndex=-100000000000000000000");
  assert.equal(status, 400);
  assert.equal(body.code, "bad_request");
});

test("a non-integer startIndex keeps its own message", async () => {
  const { status, body } = await stream("?startIndex=1e20");
  assert.equal(status, 400);
  assert.match(body.error, /integer/);
});

test("an in-range startIndex is not turned away by the bound", async () => {
  // Nothing listens on port 1, so the refused connect is instant and local: the
  // point is only that the request got PAST resolveStartIndex, which a 400 would
  // mean it had not.
  process.env.EVESTACK_AGENT_URL = "http://127.0.0.1:1";
  for (const value of ["0", "-1", "1000000000000", "12345"]) {
    const { status } = await stream(`?startIndex=${value}`);
    assert.notEqual(status, 400, `${value} was rejected by the bound`);
  }
});

test("an out-of-range Last-Event-ID resumes from the start rather than failing", async () => {
  // A header is not something an operator typed, and an EventSource will only
  // retry a 400 forever. Unparseable ones already fell back to 0; so does this.
  process.env.EVESTACK_AGENT_URL = "http://127.0.0.1:1";
  const { status } = await stream("", { "last-event-id": "100000000000000000000" });
  assert.notEqual(status, 400);
});
