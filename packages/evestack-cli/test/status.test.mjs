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
import { createServer as createNetServer } from "node:net";
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

/**
 * `new URL` is not a validator, and the guard written for that assumed it was.
 *
 * `EVESTACK_DASHBOARD_URL=localhost:4000` — the scheme left off, which is the
 * single most likely way to get this variable wrong — PARSES. It becomes
 * protocol `localhost:` with origin "null", so the try/catch never fired and
 * `new URL("/api/health", "null")` threw one frame later: `evestack status`
 * exited 1 having printed nothing but "Invalid URL".
 */
test("a dashboard URL with no scheme falls back instead of throwing", async () => {
  const probes = await probeAll((key) => ({ EVESTACK_DASHBOARD_URL: "localhost:4000" })[key]);
  // The target, not the verdict. The fallback IS :4000, so this is the one
  // probe test that cannot point itself at a dead port, and asserting the row
  // came back "fail" made it a test of whether the person running it happened
  // to have something on 4000 — an ssh -L tunnel was enough to turn it red.
  // That is the same trap the comment forty lines up was written about.
  assert.equal(probes.dashboard.url, "http://127.0.0.1:4000", "falls back to the documented default");
  assert.equal(probes.dashboard.where, ":4000", "and labels that port, rather than reporting a parse error");
});

/**
 * `new URL("https://host").port` is "" — the port is implied, not absent — so
 * `|| 80` labelled every https deployment `:80`.
 */
test("an https URL reports 443, not 80", async () => {
  const probes = await probeAll(
    (key) => ({ EVESTACK_DASHBOARD_URL: "https://dashboard.invalid" })[key],
  );
  assert.equal(probes.dashboard.where, ":443");
});

test("an explicit port still wins over the scheme default", async () => {
  const probes = await probeAll(
    (key) => ({ EVESTACK_DASHBOARD_URL: "https://dashboard.invalid:8443" })[key],
  );
  assert.equal(probes.dashboard.where, ":8443");
});

/**
 * `--json` must be machine-readable, and it was not: probeModel appends
 * `c.dim("(local)")` on the ollama path, probePostgres joins with the `g.skip`
 * glyph, and both went into the payload verbatim under FORCE_COLOR.
 */
test("--json carries no escape sequences, whatever colour is on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-status-json-"));
  writeFileSync(join(dir, ".env.local"), "EVESTACK_PROVIDER=ollama\n");
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const out = new Sink();
    await status(["--json"], { stdout: out, stderr: new Sink() });
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\x1b\[/.test(out.text), "escapes leaked into the JSON payload");
    const parsed = JSON.parse(out.text);
    const model = parsed.results.find((r) => r.part === "model");
    assert.match(model.detail, /\(local\)/, "the text survives, only the escapes go");
  } finally {
    process.chdir(cwd);
  }
});

/* -------------------------------------------------------------------------- */
/* a part that answered is never reported as absent                            */
/* -------------------------------------------------------------------------- */

/**
 * A socket that speaks just enough Postgres to reject.
 *
 * The failure worth testing is not reachable with a dead port: the server has
 * to answer the startup packet and THEN refuse, which is the whole distinction
 * the row is now making. An ErrorResponse is 'E', a length, then
 * null-terminated fields — 'S' severity, 'C' the SQLSTATE, 'M' the message —
 * closed by a zero byte. That is all pg needs to raise an error carrying
 * `.code`, and nothing here needs a real database.
 */
async function rejectingPostgres(code, message, run) {
  let body = Buffer.alloc(0);
  for (const [tag, value] of [["S", "FATAL"], ["V", "FATAL"], ["C", code], ["M", message]]) {
    body = Buffer.concat([body, Buffer.from(tag, "ascii"), Buffer.from(value, "utf8"), Buffer.from([0])]);
  }
  body = Buffer.concat([body, Buffer.from([0])]);
  const frame = Buffer.alloc(5 + body.length);
  frame.write("E", 0, "ascii");
  frame.writeInt32BE(body.length + 4, 1);
  body.copy(frame, 5);

  const server = createNetServer((socket) => {
    socket.on("data", (chunk) => {
      // An SSLRequest is exactly eight bytes ending in 80877103. Answering "N"
      // and waiting for the real startup packet keeps this fixture correct
      // whichever way pg's ssl default goes.
      if (chunk.length === 8 && chunk.readInt32BE(4) === 80877103) {
        socket.write(Buffer.from("N", "ascii"));
        return;
      }
      socket.end(frame);
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.close();
  }
}

/** The other two rows pointed somewhere that refuses instantly, so a Postgres
 *  test is not also a five-second wait on the agent and the dashboard. */
const DEAD = { EVESTACK_AGENT_PORT: "1", EVESTACK_DASHBOARD_URL: "http://127.0.0.1:1/api/ingest/v1/traces" };

test("a rejected password is not answered with `docker compose up -d postgres`", async () => {
  // The finding, verbatim: status turned every connect failure into "not
  // answering" with that fix, auth rejections included — the identical mistake
  // that made doctor unusable. Postgres is up here. Starting a second one
  // cannot help, and telling someone to try is how they conclude the database
  // is broken while `verify` insists it is fine.
  await rejectingPostgres("28P01", 'password authentication failed for user "evestack"', async (port) => {
    const probes = await probeAll(
      envFrom({ ...DEAD, WORKFLOW_POSTGRES_URL: `postgres://evestack:wrong@127.0.0.1:${port}/evestack` }),
    );
    assert.equal(probes.postgres.state, "fail");
    assert.doesNotMatch(probes.postgres.detail, /not answering/, "it answered");
    assert.match(probes.postgres.detail, /rejected these credentials/);
    assert.doesNotMatch(probes.postgres.fix, /docker compose/, "a second server fixes nothing");
    assert.match(probes.postgres.fix, /WORKFLOW_POSTGRES_URL/, "and it names where the wrong value is");
  });
});

test("a database that does not exist is not a database that is not running", async () => {
  await rejectingPostgres("3D000", 'database "nope" does not exist', async (port) => {
    const probes = await probeAll(
      envFrom({ ...DEAD, WORKFLOW_POSTGRES_URL: `postgres://evestack:pw@127.0.0.1:${port}/nope` }),
    );
    assert.match(probes.postgres.detail, /does not exist/);
    assert.doesNotMatch(probes.postgres.fix, /docker compose/);
  });
});

test("a server that objected for its own reason keeps its SQLSTATE and sends you to doctor", async () => {
  await rejectingPostgres("53300", "sorry, too many clients already", async (port) => {
    const probes = await probeAll(
      envFrom({ ...DEAD, WORKFLOW_POSTGRES_URL: `postgres://evestack:pw@127.0.0.1:${port}/evestack` }),
    );
    assert.match(probes.postgres.detail, /53300/);
    assert.doesNotMatch(probes.postgres.fix, /docker compose/);
  });
});

test("a database that really is not there keeps the advice it always had", async () => {
  // Unchanged on purpose: for a Postgres that is genuinely down this row was
  // already right, and the split must not cost it that.
  const probes = await probeAll(envFrom({ ...DEAD, WORKFLOW_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db" }));
  assert.equal(probes.postgres.detail, "not answering");
  assert.equal(probes.postgres.fix, "docker compose up -d postgres");
});

/**
 * A health route that answers with a status and a body of its own.
 *
 * The dashboard's four not-ok states all leave on a 503 and are told apart by
 * the body alone, so a stub that can only 503 empty cannot tell them apart
 * either — which is exactly the mistake the row itself was making.
 */
async function answeringHealth(code, body, run) {
  const server = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
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

const dashboardAt = (port) =>
  envFrom({
    EVESTACK_AGENT_PORT: "1",
    WORKFLOW_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db",
    EVESTACK_DASHBOARD_URL: `http://127.0.0.1:${port}/api/ingest/v1/traces`,
  });

test("a dashboard whose schema was never created is not a dashboard with bad credentials", async () => {
  // Every 503 was reported as "its credentials are missing" and fixed by
  // force-recreating the container. Three of the four states it can be in are
  // not that, and recreating the container fixes none of them.
  await answeringHealth(503, { ok: false, database: "connected", status: "schema-missing" }, async (port) => {
    const probes = await probeAll(dashboardAt(port));
    assert.equal(probes.dashboard.state, "fail");
    assert.match(probes.dashboard.detail, /workflow schema was never created/);
    assert.equal(probes.dashboard.fix, "npm run db:bootstrap");
  });
});

test("a dashboard older than its own database says so, and is not recreated", async () => {
  await answeringHealth(
    503,
    { ok: false, database: "connected", status: "degraded", reason: "schema-too-new" },
    async (port) => {
      const probes = await probeAll(dashboardAt(port));
      assert.match(probes.dashboard.detail, /older than its own database/);
      assert.doesNotMatch(probes.dashboard.fix, /force-recreate/);
      assert.match(probes.dashboard.fix, /pull/, "a newer image is the fix, not a restart");
    },
  );
});

test("a dashboard that cannot reach Postgres sends you to Postgres", async () => {
  await answeringHealth(503, { ok: false, database: "unreachable" }, async (port) => {
    const probes = await probeAll(dashboardAt(port));
    assert.match(probes.dashboard.detail, /cannot reach Postgres/);
    assert.equal(probes.dashboard.fix, "docker compose up -d postgres");
  });
});

test("a dashboard with no auth configured keeps the credentials fix it always had", async () => {
  // The one state the old row named. It has to survive the split.
  await answeringHealth(503, { ok: false, status: "unconfigured" }, async (port) => {
    const probes = await probeAll(dashboardAt(port));
    assert.match(probes.dashboard.detail, /EVESTACK_AUTH_PASSWORD/);
    assert.match(probes.dashboard.fix, /force-recreate/);
  });
});

test("an agent port with something else on it is not reported as an agent that is down", async () => {
  // eve's health handler has no failure branch — it is an unconditional 200 —
  // so a non-2xx here is another process, and `npm run dev` would fail to bind
  // the port rather than fix anything.
  await listening("/nothing-we-ask-for", async (port) => {
    const probes = await probeAll(
      envFrom({ EVESTACK_AGENT_PORT: String(port), WORKFLOW_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db",
                EVESTACK_DASHBOARD_URL: "http://127.0.0.1:1/api/ingest/v1/traces" }),
    );
    assert.equal(probes.agent.state, "fail");
    assert.doesNotMatch(probes.agent.detail, /not answering/, "something answered");
    assert.match(probes.agent.detail, /404/, "and the row says what it answered");
    assert.notEqual(probes.agent.fix, "npm run dev");
  });
});
