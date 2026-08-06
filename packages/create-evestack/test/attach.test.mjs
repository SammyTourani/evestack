/**
 * `attach`, run as a process, asserting what a reader actually gets.
 *
 * End-to-end on purpose. Each bug below is a disagreement between two things
 * attach PRINTS, or between what it prints and what it writes, and neither half
 * looks wrong on its own — so nothing short of running the command and reading
 * the output catches them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const BIN = fileURLToPath(new URL("../index.mjs", import.meta.url));
const ANSI = /\x1b\[[0-9;]*m/g;

/** A minimal but complete eve project attach will accept. */
function eveProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "evestack-attach-"));
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "probe-agent", dependencies: { eve: "^0.30.8" } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "agent", "agent.ts"), "export default defineAgent({ model: \"x\" });\n");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function runAttach(dir) {
  const { stdout } = spawnSync(process.execPath, [BIN, "attach", dir, "--yes"], {
    encoding: "utf8",
    input: "",
  });
  return stdout.replace(ANSI, "");
}

/**
 * Hold a port open so the probe under test has something to step past.
 *
 * A real listening socket, because the probe connects rather than binds. If
 * something else on this machine already owns the port that is just as good —
 * busy is busy, which is all these tests need — so a failed bind is reported
 * rather than thrown.
 */
async function occupy(port) {
  const server = net.createServer();
  const bound = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  return bound ? server : null;
}

/* -------------------------------------------------------------------------- */
/* the dashboard port                                                          */
/* -------------------------------------------------------------------------- */

/**
 * attach probed for a free Postgres port and then hardcoded the dashboard on
 * 4000 in three separate places: EVESTACK_DASHBOARD_URL in the env file it
 * writes, the "Sign in at" line, and `-p 127.0.0.1:4000:4000` inside the
 * printed `docker run`. 4000 is a popular port, and when it is taken that
 * command dies on Docker with `port is already allocated` — out of a command
 * the reader was told to paste, for a stack that is not up yet.
 *
 * One probe now feeds all three, so this asserts the three agree rather than
 * asserting any particular number.
 */
test("the dashboard port is probed, and all three printed copies of it agree", async (t) => {
  const held = await occupy(4000);
  t.after(() => (held ? new Promise((r) => held.close(r)) : undefined));

  const dir = eveProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = runAttach(dir);

  const published = /-p 127\.0\.0\.1:(\d+):4000/.exec(text);
  const signIn = /Sign in at http:\/\/localhost:(\d+)/.exec(text);
  const env = readFileSync(join(dir, ".env.local"), "utf8");
  const exporter = /^EVESTACK_DASHBOARD_URL=http:\/\/localhost:(\d+)\/api\/ingest\/v1\/traces$/m.exec(env);

  assert.ok(published, "no dashboard port was published in the printed docker run");
  assert.ok(signIn, "no sign-in URL was printed");
  assert.ok(exporter, "EVESTACK_DASHBOARD_URL was never written to the env file");

  assert.notEqual(
    published[1],
    "4000",
    "4000 is occupied and the printed docker run still publishes it — that command fails",
  );
  assert.equal(signIn[1], published[1], "the sign-in URL names a port the container does not publish");
  assert.equal(
    exporter[1],
    published[1],
    "the agent exports traces to a port the dashboard is not listening on",
  );
});

test("a free 4000 is still the port everything uses", async () => {
  // Moving off 4000 is a fallback, not a preference: the README, the scaffolder
  // and every doc say 4000, so a machine with nothing on it must still get 4000.
  const probe = await occupy(4000);
  if (probe) await new Promise((r) => probe.close(r));

  const dir = eveProject();
  try {
    const text = runAttach(dir);
    if (probe) {
      assert.match(text, /-p 127\.0\.0\.1:4000:4000/);
      assert.match(text, /Sign in at http:\/\/localhost:4000/);
    } else {
      // Something else on this machine owns 4000. Not a reason to skip: the
      // port is busy, so nothing printed may claim it.
      assert.doesNotMatch(text, /-p 127\.0\.0\.1:4000:4000/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* the manual Postgres branch                                                  */
/* -------------------------------------------------------------------------- */

/** Both compose files already present: attach writes neither, and hands over. */
function bothComposeFiles() {
  return eveProject({
    "docker-compose.yml": "services: {}\n",
    "docker-compose.evestack.yml": "services: {}\n",
  });
}

/**
 * The branch told the reader to "put WORKFLOW_POSTGRES_URL in .env.local" and
 * then printed every other credential it had generated except that one. The
 * only connection string on screen was the one inside the `docker run`, which
 * is rewritten to host.docker.internal for the container and reaches nothing
 * from the host — so the reader either invented a URL, or pasted the one URL
 * that cannot work.
 */
test("the manual Postgres branch prints the URL it tells you to set", (t) => {
  const dir = bothComposeFiles();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = runAttach(dir);
  assert.match(text, /Add Postgres yourself/, "this fixture never reached the manual branch");

  const password = /POSTGRES_PASSWORD: "([^"]+)"/.exec(text);
  const published = /- "127\.0\.0\.1:(\d+):5432"/.exec(text);
  assert.ok(password && published, "the compose service block was not printed");

  // Same credentials as the service block above it, and the address the AGENT
  // needs — not the host.docker.internal rewrite the dashboard container gets.
  const line = new RegExp(
    "^\\s*WORKFLOW_POSTGRES_URL=postgres://evestack:"
      + password[1]
      + "@127\\.0\\.0\\.1:"
      + published[1]
      + "/evestack\\s*$",
    "m",
  );
  assert.match(text, line, "attach says to set WORKFLOW_POSTGRES_URL and never says to what");

  // Printed, not written. The database does not exist yet, and the world
  // selection in agent.ts switches on the moment this variable does.
  const env = readFileSync(join(dir, ".env.local"), "utf8");
  assert.doesNotMatch(env, /^WORKFLOW_POSTGRES_URL=/m);
});
