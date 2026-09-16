import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) return { url: new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { continueSession, answerInput, getSessionSnapshot } = await import("../lib/agent-client.ts");
const { POST: message } = await import("../app/api/control/sessions/[id]/message/route.ts");
const { waitUntilReady } = await import("../app/api/control/sessions/[id]/fork/route.ts");
// Validate outgoing commands with the pinned Eve runtime, not a permissive mock.
const { parseSessionMessageBody } = await import("../../../templates/default/node_modules/eve/dist/src/eve-channel/request.js");

let server;
let previousUrl;
let snapshots = [];
let posts = [];
let reads = 0;
const waiting = (turnId, token) => [
  { type: "turn.started", data: { turnId } },
  { type: "session.waiting", data: { continuationToken: token } },
];
before(async () => {
  previousUrl = process.env.EVESTACK_AGENT_URL;
  server = createServer(async (req, res) => {
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const command = parseSessionMessageBody(body);
      if (command instanceof Response) {
        res.writeHead(command.status, { "content-type": "application/json" });
        return res.end(await command.text());
      }
      posts.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ sessionId: "session" }));
    }
    reads++;
    const events = snapshots.length > 1 ? snapshots.shift() : snapshots[0] ?? [];
    res.writeHead(200, { "content-type": "application/x-ndjson", "x-eve-stream-tail-index": String(events.length - 1) });
    res.end(events.map(e => JSON.stringify(e)).join("\n") + "\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.EVESTACK_AGENT_URL = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (previousUrl === undefined) delete process.env.EVESTACK_AGENT_URL;
  else process.env.EVESTACK_AGENT_URL = previousUrl;
  await new Promise(resolve => server.close(resolve));
});

test("messages and approvals use only the durable ID, even for legacy callers", async () => {
  posts = [];
  await continueSession("session", { message: "next", continuationToken: "old-token" });
  await answerInput("session", { inputResponses: [{ requestId: "request", optionId: "cancel" }], continuationToken: "old-token" });
  assert.deepEqual(posts, [{ message: "next" }, { inputResponses: [{ requestId: "request", optionId: "cancel" }] }]);
  await assert.rejects(continueSession("session", { message: "next", inputResponses: [] }), /separately/);
  assert.equal(posts.length, 2);
});

test("a token-free waiting event permits a follow-up, and a legacy token cannot bypass readiness", async () => {
  snapshots = [waiting("turn-1")];
  const send = body => message(new Request("http://dashboard.test/api/control/sessions/session/message", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), { params: Promise.resolve({ id: "session" }) });
  let response = await send({ message: "next" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).addressedBy, "sessionId");
  const count = posts.length;
  snapshots = [[{ type: "turn.started", data: { turnId: "turn-2" } }]];
  response = await send({ message: "next", continuationToken: "ignored" });
  assert.equal(response.status, 409);
  snapshots = [[]];
  response = await send({ message: "next", continuationToken: "ignored" });
  assert.equal(response.status, 404);
  assert.equal(posts.length, count);
});

test("replay waits for a new turn ID even when the session token stays constant", async () => {
  reads = 0;
  snapshots = [waiting("turn-1", "session"), waiting("turn-2", "session")];
  const ready = await waitUntilReady("session", Date.now() + 5000, new AbortController().signal, "turn-1");
  assert.deepEqual(ready, { code: "ready", turnId: "turn-2" });
  assert.equal(reads, 2, "the stale waiting boundary must not send the next replay message");
  snapshots = [waiting("turn-3")];
  assert.deepEqual(await waitUntilReady("session", Date.now() + 5000, new AbortController().signal, "turn-2"), { code: "ready", turnId: "turn-3" });
});

test("unrelated turns retain approvals and resolutions remove only the named request", async () => {
  const request = id => ({ requestId: id, kind: "tool-approval", prompt: "Approve test", options: [{ id: "approve", label: "Approve" }] });
  const history = [
    { type: "turn.started", data: { turnId: "turn-1" } },
    { type: "input.requested", data: { requests: [request("first"), request("second")] } },
    ...waiting("turn-2"),
  ];
  snapshots = [history];
  assert.deepEqual((await getSessionSnapshot("session")).pendingRequests.map(r => r.requestId), ["first", "second"]);
  history.push({ type: "input.resolved", data: { resolutions: [{ requestId: "first", kind: "tool-approval", outcome: "denied" }] } });
  assert.deepEqual((await getSessionSnapshot("session")).pendingRequests.map(r => r.requestId), ["second"]);
  history.push({ type: "input.resolved", data: { resolutions: [{ requestId: "second", kind: "tool-approval", outcome: "approved" }] } });
  assert.deepEqual((await getSessionSnapshot("session")).pendingRequests, []);
});
