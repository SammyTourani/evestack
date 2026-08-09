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
 * and closes the socket instead of ending the response. A clean end that is
 * equally short is not an error at all — that is eve saying "that is all of it".
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
  // The header promised 7; only 3 arrived and the server then said "that is
  // all of it". A clean end is eve's word that the stream is complete, so this
  // is an answer — unlike the abrupt case below, where nobody said anything.
  const out = await read("end_6_3");
  assert.equal(out.events.length, 3);
  assert.equal(out.tailIndex, 6);
});

test("a short stream whose socket DROPS is an error, not a partial answer", async () => {
  // THE CASE, and the one whose first fix was wrong in the dangerous direction.
  //
  // Returning the 3 events that arrived looks generous and is not: the window is
  // read from its OLDEST end, so a partial read holds the FIRST events and is
  // missing the last. getSessionSnapshot folds with latest-wins semantics, so it
  // would report the middle of a turn as the current state — a finished session
  // comes back `waiting` with a pending request, and the fleet banner renders a
  // phantom approval. That is the cry-wolf failure lib/fleet.ts exists to avoid,
  // introduced by a fix for a misleading sentence.
  await assert.rejects(
    () => read("destroy_6_3"),
    (error) => {
      assert.equal(error.name, "StreamTruncatedError");
      return true;
    },
  );
});

test("a full read is unaffected by the socket dropping afterwards", async () => {
  // Once `limit` events are in hand the loop exits and cancels the body, so the
  // teardown never reaches the reader. Pinned so the fix above cannot be
  // mistaken for the reason this case passes.
  const out = await read("destroy_6_7");
  assert.equal(out.events.length, 7);
});

test("a stream that drops before any event throws the same typed error", async () => {
  // Zero events and three events are the same answer — "I could not establish
  // this session's state" — so they are the same error. The count was briefly a
  // branch here, which is how the partial-read regression above got in.
  await assert.rejects(() => read("destroy_6_0"), (error) => {
    // Typed, not anonymous. lib/fleet.ts branches on this to say "the agent
    // answered but sent no events" instead of "the agent could not be
    // reached" — the second sends an operator to check a healthy network,
    // and the response headers this read got are proof it is healthy.
    assert.equal(error.name, "StreamTruncatedError");
    assert.match(error.message, /ended part-way through/);
    return true;
  });
});

test("an empty session reports a tail index of -1 and no events", async () => {
  // eve's signal for a session that exists but has emitted nothing. Distinct
  // from the -1 that means "no such session", which parseTailIndex also returns
  // for an absent header — see lib/fleet.ts.
  const out = await read("end_-1_0");
  assert.equal(out.events.length, 0);
  assert.equal(out.tailIndex, -1);
});
