import "./register-ts-resolve.mjs";
import { registerHooks } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) return { url: new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { GET } = await import("../app/api/control/sessions/[id]/stream/route.ts");
const encoder = new TextEncoder();

function upstream(chunks, tailIndex = 0) {
  return new Response(new ReadableStream({
    start(out) { for (const chunk of chunks) out.enqueue(encoder.encode(chunk)); out.close(); },
  }), { headers: { "content-type": "application/x-ndjson", "x-eve-stream-tail-index": String(tailIndex) } });
}

for (const [query, tail, expectedStart] of [["", 0, 0], ["?startIndex=-1", 5, 5]]) {
  test(`SSE opens a live stream after checking the tail ${query || "from the beginning"}`, async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url) => {
      const params = new URL(url).searchParams;
      calls.push(params);
      // Eve 0.54 closes includeTailIndex streams at the captured tail. Only a
      // request without that flag can deliver events emitted after the check.
      return upstream(params.has("includeTailIndex")
        ? ['{"type":"one"}\n']
        : ['{"type":"one"}\n', '{"type":"two"}\n'], tail);
    });
    const response = await GET(new Request(`http://dashboard.test/api/control/sessions/test/stream${query}`), { params: Promise.resolve({ id: "test" }) });
    assert.equal(await response.text(), `id: ${expectedStart}\ndata: {"type":"one"}\n\nid: ${expectedStart + 1}\ndata: {"type":"two"}\n\n`);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].get("includeTailIndex"), "1");
    assert.equal(calls[1].has("includeTailIndex"), false);
    assert.equal(calls[1].get("startIndex"), String(expectedStart));
  });
}

for (const [name, chunks] of [
  ["a standalone priming newline", ["\n", '{"type":"one"}\n', '{"type":"two"}\n']],
  ["an event split after the first frame", ['{"type":"one"}\n', '{"type":', '"two"}\n']],
  ["blank chunks between events", ['{"type":"one"}\n', "\n", "\n", '{"type":"two"}\n']],
]) {
  test(`SSE makes progress through ${name}`, async (t) => {
    const controller = new AbortController();
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
      start(out) { for (const chunk of chunks) out.enqueue(encoder.encode(chunk)); out.close(); },
    }), { headers: { "content-type": "application/x-ndjson", "x-eve-stream-tail-index": "1" } }));
    const response = await GET(new Request("http://dashboard.test/api/control/sessions/test/stream", { signal: controller.signal }), { params: Promise.resolve({ id: "test" }) });
    assert.equal(response.status, 200);
    let timer;
    try {
      const text = await Promise.race([
        response.text(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SSE stalled before the next complete event")), 2_000); }),
      ]);
      assert.equal(text, 'id: 0\ndata: {"type":"one"}\n\nid: 1\ndata: {"type":"two"}\n\n');
    } finally { clearTimeout(timer); controller.abort(); }
  });
}
