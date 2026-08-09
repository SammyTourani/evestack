/**
 * `evestack status` — the four probes, and the two things they must never do:
 * report a part as up because something else answered on its port, and report a
 * failure without the command that ends it.
 *
 * Postgres is genuinely unreachable in these runs, which is the interesting
 * half: the whole command exists for the machine where nothing is running.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "../src/cli.mjs";
import { probeAll, status } from "../src/status.mjs";

class Sink {
  constructor() {
    this.text = "";
  }
  write(chunk) {
    this.text += chunk;
    return true;
  }
}

/** A stub that answers the health route of whichever part it is standing in for. */
async function listening(route, run) {
  const server = createServer((req, res) => {
    if (req.url === route) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.close();
  }
}

/** A directory that `findProjectEnv` will accept, with the given .env.local. */
function project(vars) {
  const dir = mkdtempSync(join(tmpdir(), "evestack-status-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", dependencies: { eve: "^0.30.8" } }));
  writeFileSync(
    join(dir, ".env.local"),
    Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n"),
  );
  return dir;
}

const envFrom = (vars) => (key) => vars[key];

test("a part that answers its health route is up; one that does not names the fix", async () => {
  await listening("/eve/v1/health", async (port) => {
    const probes = await probeAll(
      envFrom({
        EVESTACK_AGENT_PORT: String(port),
        WORKFLOW_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db",
        // Pointed at a dead port ON PURPOSE. Leaving it unset falls back to
        // :4000, so this test passed or failed depending on whether the person
        // running it happened to have a dashboard up — which is exactly how it
        // failed the first time, against a real stack started minutes earlier.
        // A probe test must not depend on what else is listening on the box.
        EVESTACK_DASHBOARD_URL: "http://127.0.0.1:1/api/ingest/v1/traces",
        EVESTACK_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test",
      }),
    );
    assert.equal(probes.agent.state, "ok");
    assert.equal(probes.model.state, "ok");

    // Nothing is on port 1, so both of these are down — and every down part
    // carries a command. A check that can only say "failed" is not worth
    // printing; that rule is the CLI's, and this is where it is enforced.
    assert.equal(probes.postgres.state, "fail");
    assert.equal(probes.postgres.fix, "docker compose up -d postgres");
    assert.equal(probes.dashboard.state, "fail");
    assert.match(probes.dashboard.fix, /docker compose --profile dashboard up -d/);
  });
});

test("a missing model key is a failure on the model row, not a silent pass", async () => {
  const probes = await probeAll(
    envFrom({ EVESTACK_PROVIDER: "anthropic", WORKFLOW_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db" }),
  );
  assert.equal(probes.model.state, "fail");
  assert.match(probes.model.detail, /ANTHROPIC_API_KEY is not set/);
  assert.match(probes.model.fix, /add ANTHROPIC_API_KEY/);
});

test("ollama needs no key and is not reported as missing one", async () => {
  const probes = await probeAll(
    envFrom({ EVESTACK_PROVIDER: "ollama", WORKFLOW_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db" }),
  );
  assert.equal(probes.model.state, "ok");
  assert.match(probes.model.detail, /qwen3/);
});

test("the dashboard port is read from the ingest URL, not assumed to be 4000", async () => {
  // The scaffolder moves this port when 4000 is taken, and records it in exactly
  // one place. Assuming 4000 is how `verify` once certified another project's
  // dashboard as this one's.
  await listening("/api/health", async (port) => {
    const probes = await probeAll(
      envFrom({
        EVESTACK_DASHBOARD_URL: `http://127.0.0.1:${port}/api/ingest/v1/traces`,
        WORKFLOW_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db",
      }),
    );
    assert.equal(probes.dashboard.state, "ok");
    assert.equal(probes.dashboard.where, `:${port}`);
  });
});

test("--json is the same verdict as the text, and exits 1 when something is down", async () => {
  const dir = project({ WORKFLOW_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db" });
  const cwd = process.cwd();
  const stdout = new Sink();
  try {
    process.chdir(dir);
    assert.equal(await status(["--json"], { stdout, stderr: new Sink() }), 1);
  } finally {
    process.chdir(cwd);
  }
  const report = JSON.parse(stdout.text);
  assert.equal(report.ok, false);
  assert.equal(report.results.length, 4);
  assert.ok(report.results.every((r) => r.part && r.state));
});

test("outside a project it refuses with 2 and says where to go", async () => {
  const cwd = process.cwd();
  const stderr = new Sink();
  try {
    process.chdir(tmpdir());
    assert.equal(await status([], { stdout: new Sink(), stderr }), 2);
  } finally {
    process.chdir(cwd);
  }
  assert.match(stderr.text, /not an evestack project/i);
  assert.match(stderr.text, /npx evestack create my-agent/);
});

test("a bare `evestack` inside a project runs status rather than printing help", async () => {
  // The behaviour change this is here to pin: it used to print thirty-eight
  // lines of usage and exit 2 for typing the program's name.
  const dir = project({ WORKFLOW_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db" });
  const cwd = process.cwd();
  const stdout = new Sink();
  try {
    process.chdir(dir);
    assert.equal(await main([], { stdout, stderr: new Sink() }), 1);
  } finally {
    process.chdir(cwd);
  }
  assert.doesNotMatch(stdout.text, /scaffold an agent, a database/, "that is the usage block");
  assert.match(stdout.text, /postgres/);
});

test("status --help neither probes nor needs a project", async () => {
  // `verify --help` used to run the whole verification and `open --help` used to
  // launch a browser. Help is a question.
  const cwd = process.cwd();
  const stdout = new Sink();
  try {
    process.chdir(tmpdir());
    assert.equal(await status(["--help"], { stdout, stderr: new Sink() }), 0);
  } finally {
    process.chdir(cwd);
  }
  assert.match(stdout.text, /evestack status/);
  assert.match(stdout.text, /--json/);
});
