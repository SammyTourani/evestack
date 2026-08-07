import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  RpcError,
  failure,
  paramsObject,
  parseRequest,
  result,
} from "../dist/jsonrpc.js";

/**
 * The framer is hand-rolled and it is the first thing every client touches, so
 * every branch that decides "answer, or stay silent" is pinned here. Getting the
 * silent cases wrong is the expensive kind: a request answered at the wrong id
 * leaves the caller waiting forever, and a notification answered at all is a
 * response to a message the client never sent.
 */

const ok = (envelope) => {
  assert.ok("request" in envelope, `expected a valid request, got ${JSON.stringify(envelope)}`);
  return envelope.request;
};

const bad = (envelope) => {
  assert.ok("error" in envelope, `expected a rejection, got ${JSON.stringify(envelope)}`);
  return envelope;
};

test("a well-formed request survives with only the fields MCP defines", () => {
  const request = ok(parseRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  assert.deepEqual(request, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
});

test("a notification keeps `id` ABSENT, not null", () => {
  const request = ok(parseRequest({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal("id" in request, false, "an added id:null would make this look answerable");
  assert.equal(request.id, undefined);
});

test("absent params stays absent rather than becoming {}", () => {
  const request = ok(parseRequest({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.equal("params" in request, false);
});

test("a string id is preserved as a string", () => {
  assert.equal(ok(parseRequest({ jsonrpc: "2.0", id: "abc", method: "ping" })).id, "abc");
});

test("an array is not a batch we do not support, it is not a message at all", () => {
  // MCP removed batching in 2025-06-18, and this must be answered at id null
  // rather than swallowed, or the peer waits forever.
  const rejected = bad(parseRequest([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
  assert.equal(rejected.error.code, INVALID_REQUEST);
  assert.equal(rejected.id, null);
});

test("non-objects are rejected at id null", () => {
  for (const value of [null, "hello", 7, true, undefined]) {
    const rejected = bad(parseRequest(value));
    assert.equal(rejected.error.code, INVALID_REQUEST);
    assert.equal(rejected.id, null);
  }
});

test("THE ONE THAT MATTERS: a malformed request is answered at the id it supplied", () => {
  // Answering at null when the client sent id 4 leaves that call hanging forever.
  const rejected = bad(parseRequest({ jsonrpc: "1.0", id: 4, method: "ping" }));
  assert.equal(rejected.id, 4, "must answer at the client's own id");
  assert.match(rejected.error.message, /jsonrpc/);
});

test("a missing or empty method is rejected, still at the supplied id", () => {
  assert.equal(bad(parseRequest({ jsonrpc: "2.0", id: 9 })).id, 9);
  assert.equal(bad(parseRequest({ jsonrpc: "2.0", id: 9, method: "" })).id, 9);
  assert.equal(bad(parseRequest({ jsonrpc: "2.0", id: 9, method: 5 })).id, 9);
});

test("explicit id:null is refused, not silently treated as a notification", () => {
  // Legal base JSON-RPC, illegal in MCP. Treating it as a notification would
  // strand a caller that is waiting for a response.
  const rejected = bad(parseRequest({ jsonrpc: "2.0", id: null, method: "ping" }));
  assert.equal(rejected.error.code, INVALID_REQUEST);
  assert.equal(rejected.id, null);
  assert.match(rejected.error.message, /null request id/);
});

test("a non-finite or non-scalar id is refused rather than coerced", () => {
  for (const id of [Number.NaN, Infinity, {}, []]) {
    const rejected = bad(parseRequest({ jsonrpc: "2.0", id, method: "ping" }));
    assert.equal(rejected.id, null, `id ${String(id)} must not be echoed`);
  }
});

test("id 0 and the empty-string id are real ids, not missing ones", () => {
  // Both are falsy; a truthiness check here would turn a request into a
  // notification and the client would never hear back.
  assert.equal(ok(parseRequest({ jsonrpc: "2.0", id: 0, method: "ping" })).id, 0);
  assert.equal(ok(parseRequest({ jsonrpc: "2.0", id: "", method: "ping" })).id, "");
});

test("paramsObject: absent and null both mean 'no params'", () => {
  assert.deepEqual(paramsObject(undefined), {});
  assert.deepEqual(paramsObject(null), {});
  assert.deepEqual(paramsObject({ a: 1 }), { a: 1 });
});

test("paramsObject refuses positional params with -32602", () => {
  for (const value of [[1, 2], "x", 5, true]) {
    assert.throws(() => paramsObject(value), (error) => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.code, INVALID_PARAMS);
      return true;
    });
  }
});

test("RpcError omits `data` entirely when there is none", () => {
  assert.deepEqual(new RpcError(-32000, "boom").toErrorObject(), { code: -32000, message: "boom" });
  assert.deepEqual(new RpcError(-32000, "boom", { why: 1 }).toErrorObject(), {
    code: -32000,
    message: "boom",
    data: { why: 1 },
  });
});

test("RpcError with data:null still carries it, since null is not absent", () => {
  assert.deepEqual(new RpcError(-32000, "boom", null).toErrorObject(), {
    code: -32000,
    message: "boom",
    data: null,
  });
});

test("result and failure both stamp the version and echo the id", () => {
  assert.deepEqual(result(3, { ok: true }), { jsonrpc: "2.0", id: 3, result: { ok: true } });
  assert.deepEqual(failure(null, { code: -32700, message: "Invalid JSON." }), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Invalid JSON." },
  });
});

test("a serialized message never contains a raw newline", () => {
  // The stdio transport is one message per line, so an embedded newline in a
  // message would be read as two messages by the peer.
  const line = JSON.stringify(result(1, { text: "a\nb\r\nc" }));
  assert.equal(line.includes("\n"), false);
  assert.equal(line.includes("\r"), false);
  assert.deepEqual(JSON.parse(line).result, { text: "a\nb\r\nc" });
});
