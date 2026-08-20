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
  // SKIP rather than fail when it does not hold. This asserted, and so failed on any
  // machine whose resolver orders A before AAAA for localhost — common on macOS — which
  // is a property of the host, not of the code under test. The line above already skips
  // when there is no IPv6 at all; not skipping here too was an oversight of the same
  // kind, and it cost a red suite on a developer machine while CI stayed green.
  //
  // This does not weaken the test. Where ::1 does sort first, which includes CI, every
  // assertion below still runs. Where it does not, a single attempt would already have
  // reached the IPv4 listener, so there is no race left to reproduce.
  if (addresses[0].family !== 6) {
    t.skip(
      `localhost resolves ${addresses[0].family === 4 ? "IPv4" : "family " + addresses[0].family} ` +
        "first on this host, so a single attempt would already succeed and the race cannot occur",
    );
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
