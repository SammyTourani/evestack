import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { readRecentEvents } from "../lib/agent-client.ts";

/**
 * How `readRecentEvents` behaves when eve's durable stream does not deliver what
 * its own header promised.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * CI caught `getSessionSnapshot` throwing `TypeError: terminated` — undici's
 * signal for a socket the far end closed — while probing a session on an agent
 * that was demonstrably up: the same run had just read a tail index off it twice.
 * lib/fleet.ts catches that throw and reports `unknown`, whose reason string is
 * "the agent could not be reached". So the fleet banner told an operator to go
 * and look at a healthy network.
 *
 * A stub of eve's stream endpoint narrowed it to one shape out of eight: the
 * server advertises a tail index HIGHER than the number of lines it then writes,
 * and closes the socket instead of ending the response. Every other shape,
 * including a clean end that is equally short, already returned what it had.
 *
 * The stub is here rather than in contract/runtime because none of this needs an
 * agent — the question is what THIS code does with a given sequence of bytes,
 * and a real eve can only produce one of the eight at a time.
 */

const PORT = 4771;
const event = (i) => JSON.stringify({ type: "turn.started", data: { turnId: `t${i}` } });

/**
 * Behaviour is encoded in the SESSION ID, not the query string.
 *
 * openEventStream appends `?startIndex=…&includeTailIndex=1` to the base URL, so
 * a base that already carried a query string has its last parameter mangled by
 * the appended path. The first version of this stub did exactly that, wrote zero
 * lines in every case, and produced eight results that all looked like findings.
 */
let server;

before(async () => {
  server = createServer((req, res) => {
    const id = decodeURIComponent(new URL(req.url, "http://x").pathname.split("/").at(-2) ?? "");
    const [mode, tailRaw, linesRaw] = id.split("_");
    const tail = Number(tailRaw);
    const lines = Number(linesRaw);

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-eve-stream-tail-index": String(tail),
    });
    res.write("\n"); // eve primes the stream to flush headers
    for (let i = 0; i < lines; i += 1) res.write(`${event(i)}\n`);

    if (mode === "end") res.end();
    else if (mode === "destroy") setTimeout(() => req.socket.destroy(), 10);
    // "open": left hanging, like a live session
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  process.env.EVESTACK_AGENT_URL = `http://127.0.0.1:${PORT}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const read = (id) => readRecentEvents(id, { timeoutMs: 2000 });

test("a live session's stream is read to the promised tail and no further", async () => {
  // The connection stays open, as it does for a session still in flight. The
  // read has to stop at tailIndex + 1 rather than following the stream, or a
  // liveness probe never returns.
  const out = await read("open_6_7");
  assert.equal(out.events.length, 7);
  assert.equal(out.tailIndex, 6);
});

test("a finished session's stream ends cleanly and is read in full", async () => {
  const out = await read("end_6_7");
  assert.equal(out.events.length, 7);
});

test("a short stream that ends cleanly returns what it had", async () => {
  // The header promised 7; only 3 arrived. This already worked, and is the
  // behaviour the abrupt case below is brought into line with.
  const out = await read("end_6_3");
  assert.equal(out.events.length, 3);
  assert.equal(out.tailIndex, 6);
});

test("a short stream whose socket DROPS also returns what it had", async () => {
  // THE REGRESSION. This threw `TypeError: terminated`, which lib/fleet.ts
  // reports as "the agent could not be reached" — about an agent whose response
  // headers are the very thing that told us to expect 7 lines.
  const out = await read("destroy_6_3");
  assert.equal(out.events.length, 3, "a partial read is still an answer");
  assert.equal(out.tailIndex, 6);
});

test("a full read is unaffected by the socket dropping afterwards", async () => {
  // Once `limit` events are in hand the loop exits and cancels the body, so the
  // teardown never reaches the reader. Pinned so the fix above cannot be
  // mistaken for the reason this case passes.
  const out = await read("destroy_6_7");
  assert.equal(out.events.length, 7);
});

test("a stream that drops before ANY event still throws", async () => {
  // The exception that makes the rest safe. Headers prove the session exists;
  // they say nothing about its state, so returning an empty list would let
  // classifySession invent a verdict — it would read "not waiting, not
  // terminal, nothing pending" and call a session active or wedged on no
  // evidence at all. `unknown` is the honest answer, and this is how the caller
  // reaches it.
  await assert.rejects(() => read("destroy_6_0"));
});

test("an empty session reports a tail index of -1 and no events", async () => {
  // eve's signal for a session that exists but has emitted nothing. Distinct
  // from the -1 that means "no such session", which parseTailIndex also returns
  // for an absent header — see lib/fleet.ts.
  const out = await read("end_-1_0");
  assert.equal(out.events.length, 0);
  assert.equal(out.tailIndex, -1);
});
