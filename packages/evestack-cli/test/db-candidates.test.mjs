import { strict as assert } from "node:assert";
import test from "node:test";
import { connectionCandidates } from "../src/db.mjs";

// `evestack doctor` disables happy-eyeballs (see src/db.mjs) to avoid an
// uncaught TypeError when every address is refused. That left it trying only
// the first address, and Node answers ::1 first for localhost — so against the
// 127.0.0.1-bound Postgres the scaffolder now writes, the doctor's own
// DEFAULT_CONNECTION failed with ECONNREFUSED ::1:5433. Reproduced 3/3 before
// this fix.

test("localhost yields IPv4 before IPv6, so a 127.0.0.1-only listener is reached", async () => {
  const addresses = await connectionCandidates("localhost");
  assert.ok(addresses.includes("127.0.0.1"), `expected 127.0.0.1 in ${JSON.stringify(addresses)}`);
  if (addresses.includes("::1")) {
    assert.ok(
      addresses.indexOf("127.0.0.1") < addresses.indexOf("::1"),
      "IPv4 must be tried first: the refused address is always the IPv6 one for a Docker-published port",
    );
  }
});

test("a literal IP is returned untouched, with no resolver round trip", async () => {
  assert.deepEqual(await connectionCandidates("127.0.0.1"), ["127.0.0.1"]);
  assert.deepEqual(await connectionCandidates("::1"), ["::1"]);
});

test("a unix socket path is not treated as a hostname", async () => {
  assert.deepEqual(await connectionCandidates("/var/run/postgresql"), ["/var/run/postgresql"]);
});

test("an unresolvable host still yields one candidate, so connect reports the real error", async () => {
  const addresses = await connectionCandidates("no-such-host.invalid");
  assert.deepEqual(addresses, ["no-such-host.invalid"]);
});
