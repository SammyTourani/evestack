/**
 * `findAgent` must never report a different project's agent as yours.
 *
 * The bug: nothing recorded which port the agent landed on. `eve dev` takes
 * 2000 and silently auto-increments when it is busy, so `verify` scanned
 * 2000..2004 and believed the first answer. On a machine running two evestack
 * projects that answer is the OTHER project's agent — reported as healthy, with
 * a copy-pasteable curl command aimed at it. The generated compose file had the
 * same fixed 2000 in EVESTACK_AGENT_URL, so the dashboard drove it too.
 *
 * Real HTTP servers on real ports here, because the whole failure was about
 * which port actually answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { findAgent } from "../template/scripts/checks.mjs";

/** A stand-in agent that answers /eve/v1/health like the real one. */
async function agentOn(port = 0) {
  const server = createServer((req, res) => {
    if (req.url === "/eve/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "ready" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

test("the recorded port is used, and a stranger on another port is never adopted", async (t) => {
  const mine = await agentOn();
  const someoneElse = await agentOn();
  t.after(() => Promise.all([mine, someoneElse].map((a) => new Promise((r) => a.server.close(r)))));

  const found = await findAgent(undefined, String(mine.port));
  assert.equal(found.url, `http://127.0.0.1:${mine.port}`);
  assert.equal(found.health?.ok, true);
  assert.notEqual(found.url, `http://127.0.0.1:${someoneElse.port}`);
});

test("a recorded port that is not answering reports THIS agent as down, never another", async (t) => {
  // The important half. A scan-based fallback here is what produced the bug:
  // the other project's agent is up, so the check went green and the user was
  // told their agent was fine while it was not even running.
  const other = await agentOn();
  t.after(() => new Promise((r) => other.server.close(r)));

  const dead = await agentOn();
  const deadPort = dead.port;
  await new Promise((r) => dead.server.close(r));

  const found = await findAgent(undefined, String(deadPort));
  assert.equal(found.health, null, "must report down rather than finding someone else");
  assert.equal(found.pinned, true, "must say the answer came from the recorded port");
  assert.equal(found.url, `http://127.0.0.1:${deadPort}`);
});

test("an explicit URL wins over everything", async (t) => {
  const explicit = await agentOn();
  const pinned = await agentOn();
  t.after(() => Promise.all([explicit, pinned].map((a) => new Promise((r) => a.server.close(r)))));

  const found = await findAgent(`http://127.0.0.1:${explicit.port}`, String(pinned.port));
  assert.equal(found.url, `http://127.0.0.1:${explicit.port}`);
  assert.equal(found.health?.ok, true);
});

test("with no recorded port at all it scans, and admits when the answer is a guess", async (t) => {
  // Older scaffolds and `attach` projects have no EVESTACK_AGENT_PORT. Scanning
  // is the only option there, but the result is flagged so verify can say so
  // instead of presenting a guess as a fact.
  const found = await agentOn();
  t.after(() => new Promise((r) => found.server.close(r)));

  const scanned = await findAgent(undefined, undefined, found.port, 2);
  assert.equal(scanned.health?.ok, true);
  assert.equal(scanned.guessed, false, "the first port tried is not a guess");
});
