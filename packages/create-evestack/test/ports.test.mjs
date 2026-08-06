/**
 * `create` must not hand out a port something is already answering on.
 *
 * The bug: create hardcoded 5433 and 4000 while attach picked a free port, so
 * a second scaffold on the same machine produced a compose file that could not
 * come up. Docker's failure lands mid-`up`, leaves a container created with
 * nothing published, and then reports it healthy — so the next command fails
 * instead, with an ECONNREFUSED from inside a migration library.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { freePort, portAnswers } from "../shared.mjs";

async function occupy(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

test("a port nothing is listening on is reported free", async () => {
  const probe = await occupy(0);
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  assert.equal(await portAnswers(port), false);
});

test("freePort steps past a port that is taken", async (t) => {
  const probe = await occupy(0);
  const taken = probe.address().port;
  t.after(() => new Promise((r) => probe.close(r)));

  assert.equal(await portAnswers(taken), true);
  const chosen = await freePort(taken);
  assert.notEqual(chosen, taken, "must not hand back the occupied port");
  assert.ok(chosen > taken && chosen < taken + 20);
  assert.equal(await portAnswers(chosen), false);
});

test("freePort falls back to the start when the whole window is busy", async (t) => {
  const probe = await occupy(0);
  const taken = probe.address().port;
  t.after(() => new Promise((r) => probe.close(r)));
  // A one-port window that is occupied: nothing free to return.
  assert.equal(await freePort(taken, 1), taken);
});
