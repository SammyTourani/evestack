/**
 * Route guards, and what each of them answered before it existed.
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
 *   POST /api/ingest/v1/traces, with the operator's cookie and someone else's Origin
 *     The ingest tier in proxy.ts returned `NextResponse.next()` as soon as a
 *     credential checked out, and `ingestAuthorized` accepts the session cookie
 *     as well as the shared token — so it was the one write tier reached without
 *     a cross-site check. SameSite=Lax does not cover the gap, because the PORT
 *     is not part of a site: a page on http://localhost:3000 is same-site with
 *     the dashboard on :4000, and a `text/plain` POST is CORS-simple, so the
 *     cookie rode along with no preflight. `insertSpans` upserts on
 *     (trace_id, span_id), so the forged batch could rewrite the prompt and tool
 *     result on spans the operator was about to read before approving a call.
 *
 *   POST anything, with a body that never ends
 *     `readJsonObject` and the sign-in route read bodies with `text()`,
 *     `json()` and `formData()`, none of which stop. The sign-in route is the
 *     worst of them because it is the one route that answers a caller who has
 *     proved nothing at all.
 *
 * NOTE ON LOADING. Route files import their dependencies through the "@/…"
 * tsconfig path alias, which Node's resolver knows nothing about;
 * test/register-ts-resolve.mjs only adds extensions to relative specifiers. The
 * hook below maps the alias for this file, so the handlers can be called as plain
 * functions — no server, no bundler.
 *
 * It also maps `next/server`, which is what lets proxy.ts be tested at all.
 * Node cannot resolve that bare specifier (`Did you mean "next/server.js"?`) —
 * the package exposes the file and not the subpath — and importing the file by
 * URL instead is not the same thing: next/server.js assigns `module.exports`
 * and then keeps writing to the detached `exports` object, so through a
 * file-URL resolution every named import comes back undefined while
 * `Object.keys` still lists it. Measured. Rewriting the SPECIFIER and letting
 * package resolution run is the version that works, and it is the reason the
 * proxy assertions below live in this file rather than in test/auth.test.mjs,
 * which loads nothing but lib/auth.ts.
 *
 * WORKFLOW_POSTGRES_URL is deleted for the whole file on purpose. It makes the
 * database the negative control: a request that got as far as querying comes back
 * 500 `internal_error`, so a 404 or a 400 here is proof the check under test ran
 * before anything was asked of Postgres. The auth variables are deleted for the
 * same reason test/auth.test.mjs deletes them: a developer with
 * EVESTACK_AUTH_PASSWORD exported in their shell would otherwise run a different
 * suite than CI does, and the tests that pin the refusals are exactly the ones
 * that would quietly stop testing anything.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = new URL("../", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Resolve the SPECIFIER, never the file URL — see the note above.
    if (specifier === "next/server") return nextResolve("next/server.js", context);
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
const { POST: ingestTraces } = await import("../app/api/ingest/v1/traces/route.ts");
const { POST: signIn } = await import("../app/api/auth/session/route.ts");
const { readJsonObject } = await import("../app/api/control/_http.ts");
const { default: proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");
const { SESSION_COOKIE, INGEST_TOKEN_HEADER, issueSession } = await import("../lib/auth.ts");

const OWNED_ENV = [
  "WORKFLOW_POSTGRES_URL",
  "DATABASE_URL",
  "EVESTACK_AGENT_URL",
  "EVESTACK_AUTH_USER",
  "EVESTACK_AUTH_PASSWORD",
  "EVESTACK_SESSION_SECRET",
  "EVESTACK_SESSION_TTL_HOURS",
  "EVESTACK_TRUSTED_PROXY",
  "EVESTACK_PUBLIC_URL",
  "EVESTACK_INGEST_TOKEN",
  "EVESTACK_INGEST_REQUIRE_JSON",
  "EVESTACK_MAX_JSON_BODY_BYTES",
];

const saved = {};
beforeEach(() => {
  for (const name of OWNED_ENV) {
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

/* -------------------------------------------------------------------------- */
/* POST /api/ingest/v1/traces — the gate in proxy.ts                           */
/* -------------------------------------------------------------------------- */

const AUTH_USER = "evestack";
const AUTH_PASSWORD = "correct-horse-battery-staple";
const INGEST_TOKEN = "s3cret-ingest-token";

function configureAuth() {
  process.env.EVESTACK_AUTH_USER = AUTH_USER;
  process.env.EVESTACK_AUTH_PASSWORD = AUTH_PASSWORD;
}

/**
 * A request shaped like the one the shipped container actually receives.
 *
 * The URL host is the BIND address, because that is what Next reconstructs
 * `request.url` from under `next start --hostname 0.0.0.0`; the Host header is
 * the name the browser dialled. Everything the cross-site check does turns on
 * those two being different, and no curl-based check reproduces it.
 */
function ingestRequest(headers, method = "POST") {
  return new NextRequest("http://0.0.0.0:4000/api/ingest/v1/traces", {
    method,
    headers: { host: "127.0.0.1:4000", ...headers },
  });
}

function sessionCookie() {
  return `${SESSION_COOKIE}=${issueSession(AUTH_USER).value}`;
}

/** proxy.ts lets a request through with `NextResponse.next()`, which is a 200
 * carrying this header and no body. Anything else is a refusal. */
function passedThrough(response) {
  return response.status === 200 && response.headers.get("x-middleware-next") === "1";
}

test("an ingest POST riding the operator's cookie is refused a foreign Origin", async () => {
  // THE assertion for this tier. Before the fix this returned
  // `NextResponse.next()`: the cookie satisfied ingestAuthorized, and the tier
  // returned before any cross-site check. The headers below are exactly what a
  // page on http://localhost:3000 produces with
  // `fetch(url, {method:"POST", credentials:"include",
  //   headers:{"content-type":"text/plain"}, body: JSON.stringify(spans)})` —
  // a CORS-simple request, so no preflight, and Lax sends the cookie because
  // :3000 and :4000 are the same SITE.
  configureAuth();
  const response = proxy(
    ingestRequest({
      cookie: sessionCookie(),
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-site",
      "content-type": "text/plain;charset=UTF-8",
    }),
  );
  assert.equal(passedThrough(response), false, "a cross-site ingest write must not pass the gate");
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "cross_site");
});

test("Sec-Fetch-Site alone refuses it, for a page that sends no Origin", () => {
  configureAuth();
  const response = proxy(ingestRequest({ cookie: sessionCookie(), "sec-fetch-site": "cross-site" }));
  assert.equal(response.status, 403);
});

test("the cookie still works for a caller that is not a browser at all", () => {
  // `curl -u`, the dashboard's own server-side fetches, and anything else
  // scripted: no Origin and no Sec-Fetch-Site, which is the early return inside
  // isCrossSiteWrite. Breaking this would break signed-in ingest entirely.
  configureAuth();
  assert.equal(passedThrough(proxy(ingestRequest({ cookie: sessionCookie() }))), true);
});

test("a token-authenticated exporter passes, Origin present or not", () => {
  // The exporter path, which is what this tier exists for. A page cannot set
  // this header without a preflight, and the dashboard answers no preflight, so
  // the token being present is itself proof the caller is not a browser — the
  // second case below is a proxy that decided to add an Origin, not an attack.
  configureAuth();
  process.env.EVESTACK_INGEST_TOKEN = INGEST_TOKEN;
  assert.equal(
    passedThrough(proxy(ingestRequest({ [INGEST_TOKEN_HEADER]: INGEST_TOKEN }))),
    true,
    "an OTLP exporter sends no Origin and must pass",
  );
  assert.equal(
    passedThrough(
      proxy(
        ingestRequest({
          [INGEST_TOKEN_HEADER]: INGEST_TOKEN,
          origin: "http://somewhere.else",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ),
    true,
  );
});

test("an anonymous ingest POST is still the OTLP 401, not the dashboard's", async () => {
  configureAuth();
  process.env.EVESTACK_INGEST_TOKEN = INGEST_TOKEN;
  const response = proxy(ingestRequest({ "content-type": "application/json" }));
  assert.equal(response.status, 401);
  const body = await response.json();
  // google.rpc.Code 16, UNAUTHENTICATED — the vocabulary exporters read.
  assert.equal(body.code, 16);
  assert.match(body.message, /EVESTACK_INGEST_TOKEN/);
});

test("a cookie-authenticated GET is not gated, because a read changes nothing", () => {
  // The Traces page fetches its own counts from this endpoint. Gating reads
  // would break it and buy nothing: CSRF is about writes.
  configureAuth();
  assert.equal(
    passedThrough(
      proxy(ingestRequest({ cookie: sessionCookie(), origin: "http://localhost:3000" }, "GET")),
    ),
    true,
  );
});

/* -------------------------------------------------------------------------- */
/* POST /api/ingest/v1/traces — the handler's own content-type rule            */
/* -------------------------------------------------------------------------- */

async function ingest(headers, body = JSON.stringify({ resourceSpans: [] })) {
  const request = new Request("http://dashboard.test/api/ingest/v1/traces", {
    method: "POST",
    headers: { [INGEST_TOKEN_HEADER]: INGEST_TOKEN, ...headers },
    body,
  });
  const response = await ingestTraces(request);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test("a POST that does not declare JSON is refused before its body is parsed", async () => {
  // The second lock on the same door as the Origin check above. `text/plain` is
  // one of the three content-types a cross-origin fetch may set without a
  // preflight, and the body below is valid OTLP — it used to be parsed and
  // accepted, and with real spans in it, written, because nothing looked at the
  // header except the protobuf list.
  //
  // The same body declared as JSON is the 200 asserted three tests down, so the
  // only thing separating these two outcomes is the content-type.
  process.env.EVESTACK_INGEST_TOKEN = INGEST_TOKEN;
  for (const contentType of [
    "text/plain;charset=UTF-8",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
    "application/octet-stream",
  ]) {
    const { status, body } = await ingest({ "content-type": contentType });
    assert.equal(status, 415, contentType);
    assert.equal(body.code, 3, "google.rpc INVALID_ARGUMENT");
    assert.match(body.message, /application\/json/);
  }
});

test("a content-type that merely CONTAINS application/json is refused too", async () => {
  // The check above is only worth having if it cannot be talked round, and the
  // obvious spelling of it — `contentType.includes("application/json")` — can
  // be. The CORS safelist decides on a content-type's ESSENCE and ignores every
  // parameter after the first `;`, so each of these is a request a page can
  // send cross-origin with no preflight, and each one carries the string the
  // substring test was looking for. Measured against the substring spelling,
  // with the ingest token presented: 200 and the body parsed, all four.
  //
  // `application/json; charset=utf-8` is accepted two tests down, which is the
  // other half of the same property: parameters are dropped, not matched on.
  process.env.EVESTACK_INGEST_TOKEN = INGEST_TOKEN;
  for (const contentType of [
    "text/plain;charset=application/json",
    'text/plain;charset="application/json"',
    "multipart/form-data; boundary=application/json",
    "application/x-www-form-urlencoded; x=application/json",
  ]) {
    const { status, body } = await ingest({ "content-type": contentType });
    assert.equal(status, 415, contentType);
    assert.equal(body.code, 3, "google.rpc INVALID_ARGUMENT");
  }
});

test("a POST with no content-type at all is refused too", async () => {
  process.env.EVESTACK_INGEST_TOKEN = INGEST_TOKEN;
  // `new Request` defaults a string body to text/plain, so the header has to be
  // cleared explicitly to reproduce a client that sends none.
  const request = new Request("http://dashboard.test/api/ingest/v1/traces", {
    method: "POST",
    headers: { [INGEST_TOKEN_HEADER]: INGEST_TOKEN },
    body: JSON.stringify({ resourceSpans: [] }),
  });
  request.headers.delete("content-type");
  const response = await ingestTraces(request);
  assert.equal(response.status, 415);
  assert.match((await response.json()).message, /no content-type at all/);
});

test("the protobuf refusal keeps its own message, which names the fix", async () => {
  // This one is not interchangeable with the generic 415: switching
  // OTLPHttpJsonTraceExporter for the Proto one is the mistake people actually
  // make, and the message is the only place the swap is explained.
  process.env.EVESTACK_INGEST_TOKEN = INGEST_TOKEN;
  const { status, body } = await ingest({ "content-type": "application/x-protobuf" }, "\x0a\x00");
  assert.equal(status, 415);
  assert.equal(body.code, 12, "google.rpc UNIMPLEMENTED");
  assert.match(body.message, /OTLPHttpJsonTraceExporter/);
});

test("a declared JSON POST is accepted, charset and all", async () => {
  process.env.EVESTACK_INGEST_TOKEN = INGEST_TOKEN;
  for (const contentType of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON"]) {
    // An empty resourceSpans list parses to zero spans, and insertSpans returns
    // without touching Postgres, so this is a full pass through the handler with
    // no database — see lib/traces.ts.
    const { status, body } = await ingest({ "content-type": contentType });
    assert.equal(status, 200, contentType);
    assert.deepEqual(body, {});
  }
});

test("EVESTACK_INGEST_REQUIRE_JSON=off restores the old, lenient behaviour", async () => {
  // The escape hatch for an exporter nobody here wrote. It exists because a
  // dashboard upgrade that starts 415ing a working exporter is worse, for that
  // operator, than the hole it closes.
  process.env.EVESTACK_INGEST_TOKEN = INGEST_TOKEN;
  for (const off of ["off", "0", "false", "no", "OFF"]) {
    process.env.EVESTACK_INGEST_REQUIRE_JSON = off;
    const { status } = await ingest({ "content-type": "text/plain" });
    assert.equal(status, 200, off);
  }
  // Anything else means on, including an empty value and a typo.
  for (const on of ["", "   ", "1", "true", "yes", "maybe"]) {
    process.env.EVESTACK_INGEST_REQUIRE_JSON = on;
    const { status } = await ingest({ "content-type": "text/plain" });
    assert.equal(status, 415, JSON.stringify(on));
  }
});

/* -------------------------------------------------------------------------- */
/* bounded bodies                                                              */
/* -------------------------------------------------------------------------- */

function jsonPost(body, headers = {}) {
  return new Request("http://dashboard.test/api/control/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/** A body with no content-length, which is what a sender who wants this process
 * to allocate uses. `duplex: "half"` is required to put a stream on a Request. */
function streamedPost(totalBytes, chunkBytes = 64 * 1024) {
  const stream = new ReadableStream({
    start(controller) {
      for (let sent = 0; sent < totalBytes; sent += chunkBytes) {
        controller.enqueue(new Uint8Array(Math.min(chunkBytes, totalBytes - sent)));
      }
      controller.close();
    },
  });
  return new Request("http://dashboard.test/api/control/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  });
}

test("a JSON body past the cap is refused rather than buffered", async () => {
  const response = await readJsonObject(jsonPost(JSON.stringify({ message: "x".repeat(2 * 1024 * 1024) })));
  assert.ok(response instanceof Response, "an oversized body must come back as a refusal");
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.code, "payload_too_large");
  assert.match(body.error, /EVESTACK_MAX_JSON_BODY_BYTES/);
});

test("a declared content-length is refused before the body is read at all", async () => {
  // The cheap half of the check, and the only half that costs no memory: the
  // body here is two bytes, and the header is the claim being refused.
  const response = await readJsonObject(jsonPost("{}", { "content-length": "999999999" }));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 413);
});

test("a chunked body with no declared length is still bounded", async () => {
  // The case the declared-length check cannot see, and the reason this reads the
  // stream instead of calling text(): without the per-chunk check, these two
  // megabytes would already be in this process by the time anything measured
  // them.
  const response = await readJsonObject(streamedPost(2 * 1024 * 1024));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 413);
});

test("ordinary bodies are unaffected, and an empty one is still an empty object", async () => {
  assert.deepEqual(await readJsonObject(jsonPost(JSON.stringify({ paused: true }))), { paused: true });
  assert.deepEqual(await readJsonObject(jsonPost("")), {});
  assert.deepEqual(await readJsonObject(jsonPost("   ")), {});
  // A body just under the cap still parses, so the limit is a ceiling rather
  // than a fence in the middle of the room.
  const nearly = "y".repeat(1024 * 1024 - 64);
  assert.deepEqual(await readJsonObject(jsonPost(JSON.stringify({ message: nearly }))), { message: nearly });
  // And the errors that were already there are unchanged.
  assert.equal((await readJsonObject(jsonPost("{not json"))).status, 400);
  assert.equal((await readJsonObject(jsonPost("[1,2]"))).status, 400);
});

test("EVESTACK_MAX_JSON_BODY_BYTES raises the cap, and nonsense does not lower it", async () => {
  const oversized = JSON.stringify({ message: "x".repeat(2 * 1024 * 1024) });
  process.env.EVESTACK_MAX_JSON_BODY_BYTES = String(8 * 1024 * 1024);
  const raised = await readJsonObject(jsonPost(oversized));
  assert.ok(!(raised instanceof Response), "a raised cap must accept the body it was raised for");

  // A zero, a negative, a word or an absurd value all mean the operator did not
  // successfully say anything — and a zero-length limit would refuse every
  // write in the dashboard, which is why it falls back rather than obeying.
  for (const bogus of ["0", "-1", "abc", "", "Infinity", "NaN", String(1e12)]) {
    process.env.EVESTACK_MAX_JSON_BODY_BYTES = bogus;
    assert.deepEqual(await readJsonObject(jsonPost(JSON.stringify({ ok: 1 }))), { ok: 1 }, bogus);
    const refused = await readJsonObject(jsonPost(oversized));
    assert.equal(refused.status, 413, bogus);
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/auth/session — the one route that answers an unproven caller      */
/* -------------------------------------------------------------------------- */

function postSignIn(body, headers) {
  return signIn(new Request("http://dashboard.test/api/auth/session", { method: "POST", headers, body }));
}

test("an oversized sign-in body is refused before a credential is compared", async () => {
  // The credentials in this body are CORRECT. If the limit were not there the
  // answer would be a 200 with a Set-Cookie, so a 413 is proof the body stopped
  // at the reader rather than at verifyCredentials — which is the property that
  // matters, because this tier is reachable with no credential at all.
  configureAuth();
  const response = await postSignIn(
    JSON.stringify({ user: AUTH_USER, password: AUTH_PASSWORD, pad: "x".repeat(32 * 1024) }),
    { "content-type": "application/json" },
  );
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("set-cookie"), null, "no cookie may be issued on this path");
  assert.equal((await response.json()).code, "payload_too_large");
});

test("the same limit covers the form post, which is what a browser sends", async () => {
  configureAuth();
  const form = new URLSearchParams({ user: AUTH_USER, password: AUTH_PASSWORD, next: "/" });
  form.set("pad", "x".repeat(32 * 1024));
  const response = await postSignIn(form.toString(), {
    "content-type": "application/x-www-form-urlencoded",
  });
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a real sign-in still works, both shapes", async () => {
  // The regression guard on rewriting how this route reads its body: the form
  // path is parsed from the same bytes the bounded reader already consumed, so
  // if that re-wrapping were wrong, the browser's sign-in would break and
  // nothing else in the suite would notice.
  configureAuth();
  const asJson = await postSignIn(JSON.stringify({ user: AUTH_USER, password: AUTH_PASSWORD }), {
    "content-type": "application/json",
  });
  assert.equal(asJson.status, 200);
  assert.match(asJson.headers.get("set-cookie") ?? "", new RegExp(`${SESSION_COOKIE}=v1\\.`));

  const asForm = await postSignIn(
    new URLSearchParams({ user: AUTH_USER, password: AUTH_PASSWORD, next: "/sessions" }).toString(),
    { "content-type": "application/x-www-form-urlencoded" },
  );
  assert.equal(asForm.status, 303);
  assert.equal(asForm.headers.get("location"), "/sessions");
  assert.match(asForm.headers.get("set-cookie") ?? "", new RegExp(`${SESSION_COOKIE}=v1\\.`));
});

test("a JSON body that is not an object is a 400, and no longer a 500", async () => {
  // `null` is valid JSON, and the old code went straight to `body.user` on it —
  // a TypeError out of the handler, so the answer to a four-byte request was a
  // 500. Nothing else changes: it is still the same message a missing field
  // gets, and it still says nothing about which half was wrong.
  configureAuth();
  const response = await postSignIn("null", { "content-type": "application/json" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "bad_request");
});

/* -------------------------------------------------------------------------- */
/* the security headers in next.config.ts                                      */
/* -------------------------------------------------------------------------- */

test("every response carries the headers a session transcript needs", async () => {
  // Next resolves headers() at BUILD time into routes-manifest.json, so nothing
  // at runtime can assert these — this is the only place the values are checked
  // at all, and it is why they read no environment variable.
  //
  // frame-ancestors is the one that is not obvious: the session cookie is
  // SameSite=Lax, which stops cross-SITE requests, and a page on
  // http://localhost:3000 is the same site as the dashboard on :4000 because a
  // port is not part of a site. That page can frame /chat with the operator
  // fully signed in inside the frame, and cover the Approve button. CSP's
  // 'self' is an ORIGIN test, so it refuses what SameSite allows.
  const { default: config } = await import("../next.config.ts");
  const rules = await config.headers();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source, "/:path*", "must cover the API routes too, not only pages");

  const headers = new Map(rules[0].headers.map(({ key, value }) => [key.toLowerCase(), value]));
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  // The legacy twin, for browsers that do not implement frame-ancestors. Ones
  // that implement both ignore this.
  assert.equal(headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(headers.get("referrer-policy"), "same-origin");
});

test("memory read and review routes reject invalid bounds before reaching storage", async () => {
  const { GET: listMemories } = await import("../app/api/memories/route.ts");
  const { GET: getMemory } = await import("../app/api/memories/[id]/route.ts");
  const { POST: reviewMemory } = await import("../app/api/memories/[id]/review/route.ts");
  for (const query of ["limit=0", "limit=101", "offset=-1", "offset=Infinity", `q=${"x".repeat(201)}`])
    assert.equal((await listMemories(new Request(`http://localhost/api/memories?${query}`))).status, 400);
  assert.equal((await getMemory(new Request("http://localhost/api/memories/nope"), { params: Promise.resolve({ id: "nope" }) })).status, 400);
  for (const body of [
    { hash: "x", verdict: "reviewed", note: "A sufficient review reason" },
    { hash: "a".repeat(64), verdict: "apply_directly", note: "A sufficient review reason" },
    { hash: "a".repeat(64), verdict: "correction_proposed", note: "A sufficient review reason" },
    { hash: "a".repeat(64), verdict: "reviewed", note: "short" },
  ]) {
    const request = new Request("http://localhost/api/memories/1/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await reviewMemory(request, { params: Promise.resolve({ id: "1" }) })).status, 400);
  }
});

test('setup and recovery queries reject unsupported checks and oversized task ids',async()=>{
  const {GET:readiness}=await import('../app/api/readiness/route.ts');
  const {GET:recovery}=await import('../app/api/tasks/[id]/recovery/route.ts');
  const {GET:promote}=await import('../app/api/evals/promote/[id]/route.ts');
  assert.equal((await readiness(new Request('http://localhost/api/readiness?check=execute-tools'))).status,400);
  const context={params:Promise.resolve({id:'a'.repeat(301)})};
  for(const handler of [recovery,promote])assert.equal((await handler(new Request('http://localhost/api/tasks/invalid'),context)).status,400);
});

test('a regression export refuses a transcript tail instead of presenting it as a complete replay',async()=>{
  const {GET:promote}=await import('../app/api/evals/promote/[id]/route.ts');
  const originalFetch=globalThis.fetch,originalPool=globalThis.__evestackPool;
  try {
    globalThis.__evestackPool={query:async()=>({rows:[{title:'Large task'}]})};
    globalThis.fetch=async()=>new Response(Array.from({length:4096},(_,i)=>JSON.stringify({type:'message.received',data:{message:'fixture request',turnId:`turn-${i}`}})).join('\n')+'\n',{headers:{'x-eve-stream-tail-index':'5000','content-type':'application/x-ndjson'}});
    const response=await promote(new Request('http://localhost/api/evals/promote/large?format=json'),{params:Promise.resolve({id:'large'})});
    assert.equal(response.status,409);assert.equal((await response.json()).code,'transcript_truncated');
  } finally {globalThis.fetch=originalFetch;globalThis.__evestackPool=originalPool;}
});

test('regression endpoints reject invalid cases, revisions and unsupported automatic judgments',async()=>{
  const {POST:createCase,GET:listCases}=await import('../app/api/regressions/route.ts');
  const {POST:editCase}=await import('../app/api/regressions/[id]/route.ts');
  const {POST:review}=await import('../app/api/regressions/[id]/reviews/route.ts');
  const context={params:Promise.resolve({id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'})};
  const post=body=>new Request('http://localhost/api/regressions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await createCase(post({id:'invalid'}))).status,400);
  assert.equal((await listCases(new Request('http://localhost/api/regressions?offset=-1'))).status,400);
  assert.equal((await editCase(post({revision:0}),context)).status,400);
  assert.equal((await review(post({id:'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',revision:1,verdict:'automated_pass'}),context)).status,400);
});
