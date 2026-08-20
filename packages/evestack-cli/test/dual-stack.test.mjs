/**
 * `evestack doctor` must reach a Postgres that listens on IPv4 only.
 *
 * This is the regression for the bug that made the doctor useless on the most
 * ordinary setup there is. `setDefaultAutoSelectFamily(false)` at the top of
 * src/db.mjs left Node attempting exactly one address, `localhost` resolves to
 * ::1 first on macOS, and Docker Desktop and Colima publish on IPv4 only — so
 * the tool reported "Cannot reach Postgres … docker compose up -d postgres"
 * about a database that was up and that everything else was talking to.
 *
 * No Postgres here. The failure was at the TCP layer, so a bare IPv4-only
 * listener reproduces it exactly and the test runs anywhere in milliseconds.
 * Importing src/db.mjs is load-bearing: the setting it used to apply was
 * process-wide, so merely loading the module was enough to break every
 * connection made afterwards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { lookup } from "node:dns/promises";

// Side-effect import. If this module ever disables dual-stack again, the
// assertions below start failing — which is the whole point of importing it.
import "../src/db.mjs";

/** A server bound to 127.0.0.1 and nothing else, like a published Docker port. */
async function ipv4OnlyServer() {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", reject);
  });
}

test("a hostname that resolves to IPv6 first still reaches an IPv4-only listener", async (t) => {
  const addresses = await lookup("localhost", { all: true });
  if (!addresses.some((entry) => entry.family === 6)) {
    t.skip("localhost is IPv4-only on this host, so there is nothing to race");
    return;
  }
  // The precondition that made this bite: ::1 is what a single attempt would use.
  //
  // SKIPPED, not asserted, when the order is the other way round. A dual-stack
  // host that sorts A before AAAA is an ordinary configuration — macOS with
  // this resolver does it — and on such a host a single attempt would reach the
  // IPv4 listener anyway, so there is no race left to lose and nothing here to
  // prove. Asserting it turned "this machine cannot stage the bug" into "the
  // fix is broken", which is the same false-red the skip above already avoids
  // for the IPv4-only case; it simply did not cover this one.
  if (addresses[0].family !== 6) {
    t.skip("this host sorts IPv4 first, so a single attempt already reaches the v4 listener");
    return;
  }

  const { server, port } = await ipv4OnlyServer();
  t.after(() => server.close());

  assert.equal(await connect("localhost", port), true);
});

test("a genuinely refused connection still rejects, and does so quickly", async () => {
  // The behaviour the removed workaround was protecting: when nothing is
  // listening on any resolved address, this must reject as an ordinary
  // catchable error rather than throwing out of a socket callback.
  const { server, port } = await ipv4OnlyServer();
  await new Promise((resolve) => server.close(resolve));

  const started = Date.now();
  await assert.rejects(() => connect("localhost", port));
  assert.ok(Date.now() - started < 5_000, "a refused connection should fail fast, not hang");
});
