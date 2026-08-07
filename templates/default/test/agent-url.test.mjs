/**
 * A typo in EVESTACK_AGENT_URL must cost one line of the report, not the report.
 *
 * `findAgent` built its probe URL with `new URL("/eve/v1/health", url)` inside
 * `check`, which sits OUTSIDE probeJson's try/catch and outside every catch in
 * verify.mjs. So `EVESTACK_AGENT_URL=localhost:2000` threw
 *
 *   TypeError [ERR_INVALID_URL]: Invalid URL
 *     input: '/eve/v1/health', base: 'localhost:2000'
 *
 * out of the middle of the run — and because verify prints its report at the END,
 * every check that had already passed was lost with it. The user typed a URL
 * without a scheme and got a stack trace from the one tool whose entire job is to
 * never print one.
 *
 * This is the same bug dashboard-target.test.mjs guards on the other half of the
 * stack, where `URL.parse` plus a protocol check was already the fix. `findAgent`
 * got neither guard; it has both now, and the malformed value is reported rather
 * than replaced by a scan — adopting whatever answers on 2000 is precisely the
 * failure the pinned-port branch exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { agentBaseUrl, findAgent } from "../scripts/checks.mjs";

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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

/** Every spelling reproduced against the real script before the guard existed. */
const MALFORMED = ["localhost:2000", "127.0.0.1:2000", "2000", ":2000", "//localhost:2000"];

test("a real URL is accepted, and reduced to something /eve/v1/health can resolve against", () => {
  for (const good of ["http://127.0.0.1:2000", "https://agents.example.com", "http://localhost:2000/"]) {
    const base = agentBaseUrl(good);
    assert.notEqual(base, null, `for ${good}`);
    assert.equal(new URL("/eve/v1/health", base).pathname, "/eve/v1/health");
  }
});

test("every spelling without a usable scheme is rejected, not resolved", () => {
  for (const bad of MALFORMED) {
    assert.equal(agentBaseUrl(bad), null, `for ${JSON.stringify(bad)}`);
    // The half that is easy to get wrong: `URL.parse` SUCCEEDS on
    // "localhost:2000" — it reads `localhost:` as the scheme — so a null check
    // alone would have let it straight through to the same TypeError one line
    // later. The protocol check is the guard.
    if (bad === "localhost:2000") assert.notEqual(URL.parse(bad), null, "URL.parse alone is not enough");
  }
  for (const empty of [undefined, null, "", "   "]) {
    assert.equal(agentBaseUrl(empty), null, `for ${JSON.stringify(empty)}`);
  }
});

test("a malformed EVESTACK_AGENT_URL is reported, not thrown", async () => {
  // THE regression. Before the guard each of these threw ERR_INVALID_URL and
  // ended the run; now each answers, and verify prints one failed check.
  for (const bad of MALFORMED) {
    const found = await findAgent(bad, "2000");
    assert.equal(found.malformed, bad, `for ${JSON.stringify(bad)}`);
    assert.equal(found.health, null);
    assert.equal(found.url, bad, "the bad value is echoed back so verify can name it");
  }
});

test("a malformed value is never quietly replaced by a scan", async (t) => {
  // The other half, and the reason this returns `malformed` rather than falling
  // through: someone else's agent answering on 2000 must not be adopted and
  // reported as yours, with a copy-pasteable curl aimed at it. Asserted by what
  // comes back — the bad string, never a scanned `http://127.0.0.1:PORT` — rather
  // than by occupying port 2000, which would make this test fight whatever else
  // is running on the machine.
  const decoy = await agentOn();
  t.after(() => new Promise((r) => decoy.server.close(r)));

  const found = await findAgent("localhost:2000", String(decoy.port));
  assert.equal(found.health, null, "must not adopt an agent it happens to find");
  assert.equal(found.malformed, "localhost:2000");
  assert.equal(found.url, "localhost:2000", "not a scanned or pinned address");
  assert.equal(found.pinned, undefined, "the recorded port is not consulted either");
});

test("the guard does not break the URL that works", async (t) => {
  const mine = await agentOn();
  t.after(() => new Promise((r) => mine.server.close(r)));

  const found = await findAgent(`http://127.0.0.1:${mine.port}`, undefined);
  assert.equal(found.url, `http://127.0.0.1:${mine.port}`);
  assert.equal(found.health?.ok, true);
  assert.equal(found.malformed, undefined);
});

test("a well-formed URL with nothing behind it still reports THIS agent as down", async () => {
  // Not malformed — answerable and unanswered. The distinction is what lets
  // verify say "npm run dev" for one and "that is not a URL" for the other.
  const dead = await agentOn();
  const port = dead.port;
  await new Promise((r) => dead.server.close(r));

  const found = await findAgent(`http://127.0.0.1:${port}`, undefined);
  assert.equal(found.health, null);
  assert.equal(found.malformed, undefined, "a real URL is not a typo");
});
