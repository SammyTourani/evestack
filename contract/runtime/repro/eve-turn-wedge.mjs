#!/usr/bin/env node
/**
 * Tier 2 of the vercel/eve#535 repro: show the wedge on the REAL stack.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: WRITTEN BUT NOT YET EXECUTED.                                    │
 * │                                                                          │
 * │ `graphile-crash-wedge.mjs` — tier 1, in this directory — HAS been run    │
 * │ and reproduces the mechanism end to end. This file has NOT been run: it  │
 * │ was authored on a machine whose swap was 4757M used of 5120M, where      │
 * │ booting `eve dev` plus its per-session Docker sandbox was not a safe     │
 * │ thing to do. Treat every claim below as a prediction derived from tier 1 │
 * │ plus the compiled sources, NOT as an observation.                        │
 * │                                                                          │
 * │ Do not cite this file's output as evidence until it has actually run     │
 * │ green somewhere with headroom.                                           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ── What tier 1 already settled ──────────────────────────────────────────────
 *
 * At the graphile-worker layer, with real SIGKILLs against real Postgres:
 * a job claimed and then killed leaves `attempts` incremented (getJob raises it
 * at claim time) and `last_error` NULL (failJob never ran). Three such cycles
 * reach attempts = max_attempts, `is_available` is a stored generated column
 * gated on `attempts < max_attempts`, and it is then false forever. Clearing
 * `locked_at` cannot help, because `locked_at` is not the term that is false.
 *
 * Tier 1 also established, by reading the compiled packages eve actually loads,
 * that `@workflow/world-postgres` enqueues EVERY workflow message through
 * `addGraphileJob` with a flat `maxAttempts: 3`, and that it registers the same
 * task identifier it enqueues to. So the ingredients are all present in the
 * real stack.
 *
 * ── What this tier would add ─────────────────────────────────────────────────
 *
 * Exactly one thing, and it is worth having: proof that an interrupted eve
 * *turn* leaves its job in that state — i.e. that a turn really is carried by a
 * graphile job that is held across the model/tool step, rather than being
 * enqueued and completed so quickly that process death lands somewhere
 * harmless. Tier 1 cannot answer that; only running eve can.
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 *
 * No model, no cost: `EVE_MOCK_AUTHORED_MODELS=1` is a seam compiled into eve
 * (see eve/dist/src/runtime/agent/mock-model-adapter.js — the gate is
 * `NODE_ENV === "test" || EVE_MOCK_AUTHORED_MODELS === "1"`), and
 * resolve-model.js consults it BEFORE the source-backed model reference, so
 * templates/default needs no edit and no provider key.
 *
 * The kill has to land while the job is held, and with a mocked model that
 * window is short. So rather than sleeping and hoping, this polls
 * `_private_jobs` for `locked_at is not null` and kills the instant it sees it.
 * That is the same trick tier 1 uses (there, the child announces the claim on
 * stdout; here we watch the row, because the process we kill is eve's).
 *
 * Prompt choice matters: the mock model emits tool calls when the user text
 * name-matches an available tool. "hello" avoids that, which keeps the Docker
 * sandbox and the real OpenAI embeddings behind `remember`/`recall` out of it.
 * Those embeddings are a direct AI SDK call in templates/default/lib/memory.ts
 * and are NOT covered by the mock seam — a prompt that triggers them would cost
 * money and need a key.
 *
 * Usage:
 *   WORKFLOW_POSTGRES_URL=postgres://evestack:evestack@localhost:5433/evestack \
 *     node contract/runtime/repro/eve-turn-wedge.mjs
 *
 *   --force-low-memory   run even if the preflight says there is no headroom
 *   --port=2999          port for the dev server
 *
 * Exit codes: 0 the wedge reproduced on the real stack
 *             1 it did not — read the output before believing tier 1 transfers
 *             2 could not run (no database, no headroom, server would not boot)
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const TEMPLATE = join(REPO, "templates", "default");

const args = process.argv.slice(2);
const FORCE = args.includes("--force-low-memory");
const PORT = Number(args.find((a) => a.startsWith("--port="))?.slice(7) ?? 2999);
const CONNECTION =
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://evestack:evestack@localhost:5433/evestack";

/** Matches @workflow/world-postgres addGraphileJob. */
const MAX_ATTEMPTS = 3;
/** graphile-worker's default schema, which world-postgres does not override. */
const GW_SCHEMA = process.env.GRAPHILE_WORKER_SCHEMA ?? "graphile_worker";

let failures = 0;
const ok = (passed, detail, extra) => {
  if (!passed) failures++;
  process.stdout.write(`${passed ? "  ok  " : " FAIL "} ${detail}\n`);
  if (extra) process.stdout.write(`       ${extra}\n`);
};
const note = (d) => process.stdout.write(`       ${d}\n`);
const section = (t) => process.stdout.write(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}\n`);

function fmt(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function table(rows) {
  if (rows.length === 0) return void process.stdout.write("       (0 rows)\n");
  const cols = Object.keys(rows[0]);
  const w = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => fmt(r[c]).length))]),
  );
  const line = (cells) => `       ${cols.map((c, i) => cells[i].padEnd(w[c])).join(" | ")}\n`;
  process.stdout.write(line(cols));
  process.stdout.write(`       ${cols.map((c) => "-".repeat(w[c])).join("-+-")}\n`);
  for (const r of rows) process.stdout.write(line(cols.map((c) => fmt(r[c]))));
}

/**
 * Refuse to boot a dev server onto a machine that is already swapping itself to
 * death. This is not politeness — an OOM here takes the developer's session
 * with it, and the whole point of the repro is to be safe to run.
 */
function preflightMemory() {
  if (process.platform !== "darwin") return true;
  try {
    const out = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" });
    const total = Number(out.match(/total = ([\d.]+)M/)?.[1] ?? 0);
    const free = Number(out.match(/free = ([\d.]+)M/)?.[1] ?? 0);
    note(`swap: ${free.toFixed(0)}M free of ${total.toFixed(0)}M`);
    if (total > 0 && free < 512) {
      process.stderr.write(
        `\nRefusing to start: only ${free.toFixed(0)}M of swap free.\n` +
          "Booting eve dev plus a Docker sandbox here risks taking the machine down.\n" +
          "Close some applications, or pass --force-low-memory if you know better.\n",
      );
      return false;
    }
  } catch {
    note("could not read swap usage; continuing");
  }
  return true;
}

async function connect() {
  const { default: pg } = await import(
    // pg is a direct dependency of templates/default and of the repo root.
    "pg"
  );
  const client = new pg.Client({ connectionString: CONNECTION });
  await client.connect();
  return client;
}

async function jobRows(client) {
  const { rows } = await client.query(
    `select id, attempts, max_attempts, is_available, locked_at, locked_by, last_error, run_at
       from ${GW_SCHEMA}._private_jobs order by id`,
  );
  return rows;
}

/** Boot `eve dev` with the mock model seam, and wait until it answers. */
function startEve() {
  const child = spawn("npx", ["eve", "dev", "--port", String(PORT)], {
    cwd: TEMPLATE,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      EVE_MOCK_AUTHORED_MODELS: "1",
      WORKFLOW_POSTGRES_URL: CONNECTION,
    },
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function waitForServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any response at all — including a 4xx — means the server is listening.
      await fetch(`http://127.0.0.1:${PORT}/eve/v1/session/does-not-exist`, {
        method: "GET",
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

/** Poll until a job row is held, then resolve. */
async function waitForAHeldJob(client, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await jobRows(client);
    const held = rows.find((r) => r.locked_at !== null);
    if (held) return held;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

async function main() {
  section("PRECONDITIONS");
  if (!existsSync(join(TEMPLATE, "package.json"))) {
    process.stderr.write(`expected ${TEMPLATE} — run from an evestack checkout\n`);
    process.exit(2);
  }
  if (!preflightMemory() && !FORCE) process.exit(2);

  let client;
  try {
    client = await connect();
  } catch (error) {
    process.stderr.write(`cannot reach Postgres: ${error.message}\n`);
    process.exit(2);
  }

  const { rows: schemaThere } = await client.query(
    `select 1 from information_schema.tables where table_schema = $1 and table_name = '_private_jobs'`,
    [GW_SCHEMA],
  );
  if (schemaThere.length === 0) {
    process.stderr.write(
      `no ${GW_SCHEMA}._private_jobs table. Bootstrap first:\n` +
        `  cd templates/default && npm run db:bootstrap\n`,
    );
    await client.end();
    process.exit(2);
  }

  const before = await jobRows(client);
  note(`${before.length} pre-existing job row(s) in ${GW_SCHEMA}`);
  note("NOTE: this tier operates on the SHARED graphile schema, not a throwaway one,");
  note("because that is where world-postgres puts its jobs. It is therefore NOT as");
  note("self-isolating as tier 1 — run it against a scratch database.");

  let eve = null;
  try {
    for (let cycle = 1; cycle <= MAX_ATTEMPTS; cycle++) {
      section(`CYCLE ${cycle} of ${MAX_ATTEMPTS} — start a turn, kill eve while the job is held`);

      eve = startEve();
      if (!(await waitForServer())) {
        ok(false, "eve dev did not become reachable");
        break;
      }
      note(`eve dev up on :${PORT} (pid ${eve.pid}) with EVE_MOCK_AUTHORED_MODELS=1`);

      // Kick off a turn. A benign prompt: no tool-name match, so no sandbox
      // container and no embedding calls.
      fetch(`http://127.0.0.1:${PORT}/eve/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { role: "user", content: "hello" } }),
      }).catch(() => {});

      const held = await waitForAHeldJob(client);
      if (!held) {
        ok(false, `cycle ${cycle}: no job was ever held — the turn may not be job-backed`);
        break;
      }
      note(`job ${held.id} is held (attempts ${held.attempts}); killing eve now`);

      eve.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 1500));
      eve = null;

      const rows = await jobRows(client);
      table(rows);
      const row = rows.find((r) => String(r.id) === String(held.id));

      ok(
        row && row.last_error === null,
        `cycle ${cycle}: last_error is NULL — eve died, it did not fail, so failJob never ran`,
      );

      if (cycle < MAX_ATTEMPTS) {
        // The operator's remediation, same as tier 1 / the issue's step 5.
        await client.query(
          `update ${GW_SCHEMA}._private_jobs set locked_at = null, locked_by = null, run_at = now()
            where id = $1`,
          [held.id],
        );
        const after = (await jobRows(client)).find((r) => String(r.id) === String(held.id));
        ok(
          after?.is_available === true,
          `cycle ${cycle}: clearing the lock still revives it (attempts ${after?.attempts} < ${after?.max_attempts})`,
        );
      } else {
        await client.query(
          `update ${GW_SCHEMA}._private_jobs set locked_at = null, locked_by = null, run_at = now()
            where id = $1`,
          [held.id],
        );
        const after = (await jobRows(client)).find((r) => String(r.id) === String(held.id));
        table([after]);
        ok(
          after?.is_available === false && after?.attempts === after?.max_attempts,
          "FINAL: the turn's job is now permanently unavailable and clearing the lock does nothing",
          "this is vercel/eve#535 step 5 on the real stack",
        );
      }
    }

    section("VERDICT");
    process.stdout.write(
      failures === 0
        ? "The tier-1 mechanism transfers to the real stack.\n"
        : `${failures} check(s) failed — tier 1 may NOT transfer. Do not publish this as-is.\n`,
    );
  } finally {
    if (eve) eve.kill("SIGKILL");
    if (client) await client.end().catch(() => {});
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`\nrepro crashed: ${error?.stack ?? error}\n`);
  process.exit(2);
});
