/**
 * The tour talks to a real agent over two routes, and one of them is a stream.
 *
 * Driving the real thing needs Docker, Postgres, a booted agent and a model key
 * — which is to say it needs the tour to already work — so the parser is tested
 * here against a stub that speaks the shapes eve's compiled channel actually
 * emits:
 *
 *   POST /eve/v1/session            202 { ok, sessionId, continuationToken }
 *   GET  /eve/v1/session/:id/stream NDJSON { type, data }
 *
 * with `message.appended` carrying `data.messageDelta`, `message.completed`
 * carrying the whole `data.message`, and turn.completed / turn.failed ending it.
 * If eve renames one of those, this is where it should go red.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { startSession, streamReply } from "../src/tour.mjs";

/** Collects what the tour would have printed. */
function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), get text() { return chunks.join(""); } };
}

const noEnv = () => undefined;

/** A stub agent. `events` are written to the stream route, one JSON per line. */
async function withAgent(events, run, { status = 202, body } = {}) {
  const seen = { authorization: null, message: null };
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/eve/v1/session") {
      seen.authorization = req.headers.authorization ?? null;
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        seen.message = JSON.parse(raw || "{}").message ?? null;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body ?? { ok: true, sessionId: "sess_123", continuationToken: "eve:abc" }));
      });
      return;
    }
    if (req.url?.startsWith("/eve/v1/session/") && req.url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      // Deliberately not one line per write: the parser has to reassemble
      // events split across chunk boundaries, which is the normal case on a
      // real socket and the thing a naive split("\n") gets wrong.
      const payload = events.map((e) => `${JSON.stringify(e)}\n`).join("");
      res.write(payload.slice(0, 7));
      res.write(payload.slice(7));
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base, seen);
  } finally {
    server.close();
  }
}

test("assembles the reply from message.appended deltas", async () => {
  const events = [
    { type: "session.created", data: {} },
    { type: "turn.started", data: {} },
    { type: "message.appended", data: { messageDelta: "Postgres ", sequence: 1 } },
    { type: "message.appended", data: { messageDelta: "on your ", sequence: 2 } },
    { type: "message.appended", data: { messageDelta: "own machine.", sequence: 3 } },
    { type: "message.completed", data: { message: "Postgres on your own machine.", finishReason: "stop" } },
    { type: "turn.completed", data: {} },
  ];
  await withAgent(events, async (base) => {
    const out = sink();
    const reply = await streamReply(base, "sess_123", noEnv, out);
    assert.equal(reply.text, "Postgres on your own machine.");
    assert.equal(reply.failed, null);
    assert.match(out.text, /Postgres on your own machine\./);
  });
});

test("a failed turn is reported, not swallowed", async () => {
  const events = [
    { type: "turn.started", data: {} },
    { type: "message.appended", data: { messageDelta: "thinking" } },
    { type: "turn.failed", data: { error: { message: "MODEL_CALL_FAILED" } } },
  ];
  await withAgent(events, async (base) => {
    const reply = await streamReply(base, "sess_123", noEnv, sink());
    assert.equal(reply.failed, "MODEL_CALL_FAILED");
  });
});

test("an unknown event type is ignored rather than thrown on", async () => {
  // eve's event vocabulary moves upstream. A tour that dies on a name it has
  // not seen is worse than one that prints slightly less.
  const events = [
    { type: "some.future.event", data: { whatever: true } },
    { type: "message.appended", data: { messageDelta: "ok" } },
    { type: "turn.completed", data: {} },
  ];
  await withAgent(events, async (base) => {
    const reply = await streamReply(base, "sess_123", noEnv, sink());
    assert.equal(reply.text, "ok");
    assert.equal(reply.failed, null);
  });
});

test("a stream that cannot be reached degrades instead of throwing", async () => {
  // Nothing is listening on this port. The reply is in the dashboard either way.
  const reply = await streamReply("http://127.0.0.1:1", "sess_123", noEnv, sink());
  assert.equal(reply.text, "");
  assert.equal(reply.failed, null);
});

test("startSession sends the message and returns the session id", async () => {
  await withAgent([], async (base, seen) => {
    const session = await startSession(base, "hello there", noEnv);
    assert.equal(session.sessionId, "sess_123");
    assert.equal(seen.message, "hello there");
    assert.equal(seen.authorization, null, "no credentials configured means no header");
  });
});

test("basic credentials are sent when the project has them", async () => {
  // A built server refuses loopback too — from eve 0.30 localDev() grants only
  // inside `eve dev` — so the tour must carry the project's Basic credentials.
  const env = (key) => ({ EVESTACK_AUTH_USER: "evestack", EVESTACK_AUTH_PASSWORD: "s3cret" })[key];
  await withAgent([], async (base, seen) => {
    await startSession(base, "hi", env);
    assert.equal(seen.authorization, `Basic ${Buffer.from("evestack:s3cret").toString("base64")}`);
  });
});

test("a 401 names the credentials rather than the status code", async () => {
  await withAgent([], async (base) => {
    await assert.rejects(
      () => startSession(base, "hi", noEnv),
      /401 .* EVESTACK_AUTH_\* in \.env\.local/s,
    );
  }, { status: 401, body: { ok: false, error: "Unauthorized" } });
});
