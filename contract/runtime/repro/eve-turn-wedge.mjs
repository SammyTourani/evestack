#!/usr/bin/env node
/**
 * Tier 2 of the vercel/eve#535 repro: show the wedge on the REAL stack.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: STILL NOT EXECUTED — attempted 2026-08-05, blocked twice.        │
 * │                                                                          │
 * │ `graphile-crash-wedge.mjs` — tier 1, in this directory — HAS been run    │
 * │ and reproduces the mechanism end to end. This file has NOT been run.     │
 * │ Treat every claim below as a prediction derived from tier 1 plus the     │
 * │ compiled sources, NOT as an observation.                                 │
 * │                                                                          │
 * │ BLOCKER 1, since fixed: running this unchanged would have produced a     │
 * │ false NEGATIVE. It sent `message` as a chat-style {role, content}        │
 * │ object; the route takes a string or an array of parts and answers 400    │
 * │ to anything else. The 400 was discarded (`.catch(() => {})`, no status   │
 * │ check), so nothing would have been enqueued, the poll would have timed   │
 * │ out, and the script would have printed "the turn may not be job-backed"  │
 * │ and exited 1 — which reads as a disproof of tier 1 while never having    │
 * │ started a turn at all. Measured by running the shipped parser            │
 * │ (eve 0.30.8, dist/src/public/channels/eve.js, parseMessageField) on all  │
 * │ three shapes: object -> 400, "hello" -> accepted, part array ->          │
 * │ accepted. The body and the missing status check are both fixed below.    │
 * │                                                                          │
 * │ BLOCKER 1b, since fixed: the status check written for BLOCKER 1 ran only │
 * │ on the branch where NO job was ever held. When a job WAS held it was not │
 * │ consulted, so a 400 — or a 204 dropped-message — landing beside a locked │
 * │ row left by someone else would have read as a reproduction: the same     │
 * │ fault as BLOCKER 1 pointed the other way, a false POSITIVE. The turn now │
 * │ has its status checked every cycle before `held` is interpreted, a boot  │
 * │ failure aborts instead of counting as a failed check, and the run says   │
 * │ which of three outcomes it reached rather than which of two.             │
 * │                                                                          │
 * │ BLOCKER 2, still open: no headroom. Measured at the attempt — 47% of     │
 * │ memory free, swap 5465M used of 7168M, load 5.0, 36 concurrent node      │
 * │ processes, Docker daemon down (the colima VM is stopped, and its profile │
 * │ asks for 4 vCPU / 8 GiB on an 8 GB host). Booting this stack is what     │
 * │ powered the machine off earlier the same day. The swap preflight below   │
 * │ would have PASSED throughout, which is why it is necessary and nowhere   │
 * │ near sufficient: it printed `swap: 763M free of 6144M` on the attempt,   │
 * │ over its 512M floor, having read 1703M free of 7168M minutes earlier.    │
 * │ Both the free figure and the total drift by the gigabyte under other     │
 * │ load, so a single reading of it is not evidence of headroom.             │
 * │                                                                          │
 * │ Do not cite this file's output as evidence until it has actually run     │
 * │ green somewhere with headroom. A GitHub-hosted runner is the intended    │
 * │ home: 4 vCPU / 16 GB, Docker preinstalled, free for public repos.        │
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
 * name-matches an available tool. "hello" avoids that, which keeps the real
 * OpenAI embeddings behind `remember`/`recall` out of it. Those embeddings are
 * a direct AI SDK call in templates/default/lib/memory.ts and are NOT covered
 * by the mock seam — a prompt that triggers them would cost money and need a
 * key.
 *
 * What the prompt does NOT do — an earlier version of this note claimed
 * otherwise — is keep Docker out of the run. It only governs turn-time session
 * containers. `eve dev` kicks off a sandbox prewarm in the background at boot
 * whatever the prompt is (execution/sandbox/development-prewarm.js into
 * execution/sandbox/prewarm.js, dispatching to the docker backend's `prewarm`):
 * it asserts the daemon is up, pulls the pinned base image when no cached
 * template image matches, and runs a template-build container to commit one. So
 * a daemon and the image budget have to be there before the first turn is sent,
 * and the machine this runs on has to be sized for that, not for `hello`.
 *
 * Usage:
 *   pnpm install                       # eve must be installed, not npx-fetched
 *   WORKFLOW_POSTGRES_URL=postgres://evestack:evestack@localhost:5433/evestack \
 *     node contract/runtime/repro/eve-turn-wedge.mjs
 *
 *   --force-low-memory   run even if the preflight says there is no headroom
 *   --port=2999          port for the dev server
 *
 * Exit codes: three outcomes, and no path by which one becomes another.
 *
 *   0 REPRODUCED     the FINAL assertion ran and passed on the real stack.
 *   1 DID NOT        the run was carried out and the wedge did not appear.
 *                    Read the output before believing tier 1 transfers.
 *   2 INCONCLUSIVE   the run could not be carried out: no database, no
 *                    headroom, eve not installed, the port already taken, the
 *                    server would not boot, a foreign worker on the schema, or
 *                    create-session refusing the turn. This is NOT a statement
 *                    about tier 1 in either direction — see BLOCKER 1 and 1b,
 *                    where exactly this collapsed into a 1 and read as a
 *                    disproof.
 *
 * Exit 0 requires the final assertion to have passed, not merely the absence of
 * failures: a skipped check is not a pass.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const TEMPLATE = join(REPO, "templates", "default");

/**
 * The eve this repro is a claim about.
 *
 * Spawned by path rather than through `npx`, because `npx eve` with nothing
 * installed fetches whatever version the registry serves today and runs that
 * instead. A green run from the wrong eve is worse than no run at all: the
 * whole artifact is a statement about 0.30.8 specifically, and nothing in the
 * output would say which version produced it.
 */
const EVE_BIN = join(TEMPLATE, "node_modules", ".bin", "eve");

const args = process.argv.slice(2);
const FORCE = args.includes("--force-low-memory");
const PORT = Number(args.find((a) => a.startsWith("--port="))?.slice(7) ?? 2999);
const CONNECTION =
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://evestack:evestack@localhost:5433/evestack";

const HEALTH_URL = `http://127.0.0.1:${PORT}/eve/v1/health`;
const CREATE_SESSION_URL = `http://127.0.0.1:${PORT}/eve/v1/session`;

/** A cold `eve dev` builds with nitro and prewarms a sandbox image first. */
const BOOT_TIMEOUT_MS = 120_000;
/** How long a turn gets to produce a claimed job row. */
const HELD_TIMEOUT_MS = 60_000;
/**
 * Bounds the create-session request. Deliberately longer than HELD_TIMEOUT_MS,
 * because the response is read only after the job poll gives up: a request
 * still in flight at that point has to resolve into a status rather than hang
 * the run forever.
 */
const TURN_TIMEOUT_MS = 90_000;

/** Matches @workflow/world-postgres addGraphileJob. */
const MAX_ATTEMPTS = 3;
/** graphile-worker default schema, which world-postgres does not override. */
const GW_SCHEMA = process.env.GRAPHILE_WORKER_SCHEMA ?? "graphile_worker";

/* -------------------------------------------------------------------------- */
/* outcomes                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Three states, three exit codes, and no path by which one becomes another:
 *
 *   abortReason !== null   the run could not be carried out           -> exit 2
 *   reproduced === true    the FINAL assertion ran and passed         -> exit 0
 *   otherwise              the run finished, the wedge did not show   -> exit 1
 *
 * `reproduced` is set by the final assertion alone and is never inferred from
 * `failures === 0`. A run that breaks early, skips a cycle, or never boots has
 * zero failed checks and must still not be able to report success: a skipped
 * check is not a pass.
 */
let failures = 0;
let reproduced = false;
let abortReason = null;

const ok = (passed, detail, extra) => {
  if (!passed) failures++;
  process.stdout.write(`${passed ? "  ok  " : " FAIL "} ${detail}\n`);
  if (extra) process.stdout.write(`       ${extra}\n`);
};
const note = (d) => process.stdout.write(`       ${d}\n`);
const section = (t) => process.stdout.write(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}\n`);

/** Records that the run could not be carried out. The first reason wins. */
const abort = (reason) => {
  if (abortReason === null) abortReason = reason;
};

/**
 * Refuses before the run starts, for a precondition that makes it pointless.
 * Always exit 2: none of these are statements about tier 1.
 */
function refuse(message) {
  process.stderr.write(
    `\nINCONCLUSIVE — cannot run. This is NOT evidence for or against tier 1.\n${message}\n`,
  );
  process.exit(2);
}

function fmt(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function table(rows) {
  // A missing row is a real outcome here — graphile deletes a job row when it
  // succeeds — so filter, rather than dereference undefined and crash.
  const present = rows.filter((r) => r !== null && r !== undefined);
  if (present.length === 0) return void process.stdout.write("       (0 rows)\n");
  const cols = Object.keys(present[0]);
  const w = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...present.map((r) => fmt(r[c]).length))]),
  );
  const line = (cells) => `       ${cols.map((c, i) => cells[i].padEnd(w[c])).join(" | ")}\n`;
  process.stdout.write(line(cols));
  process.stdout.write(`       ${cols.map((c) => "-".repeat(w[c])).join("-+-")}\n`);
  for (const r of present) process.stdout.write(line(cols.map((c) => fmt(r[c]))));
}

/**
 * Refuse to boot the dev server onto a machine already swapping itself to
 * death. This is not politeness — an OOM here takes the developer session with
 * it, and the whole point of a repro is that it is safe to run.
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
        `\nRefusing to start: only ${free.toFixed(0)}M of swap is free.\n` +
          "Booting eve dev plus a Docker sandbox risks taking the machine down.\n" +
          "Close applications, or pass --force-low-memory if you know better.\n",
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

/* -------------------------------------------------------------------------- */
/* the server under test                                                      */
/* -------------------------------------------------------------------------- */

/** The live `eve dev`, if any. Module-level so a signal handler can reach it. */
let eveProcess = null;
/** Tail of whatever the current `eve dev` said, kept for abort messages. */
let eveOutput = "";

/**
 * Boot `eve dev` with the mock model seam.
 *
 * Two changes from the version that was never run, both required for it to run
 * at all:
 *
 *   `--no-ui`   stdin is "ignore", so the interactive terminal UI has no TTY to
 *               draw on. The server it starts is the same either way, and it is
 *               the flag the dashboard error message already tells people to
 *               use.
 *   `detached`  puts eve and everything it spawns into one process group, so
 *               killEve can take the whole tree. See killEve.
 */
function startEve() {
  eveOutput = "";
  const child = spawn(EVE_BIN, ["dev", "--no-ui", "--port", String(PORT)], {
    cwd: TEMPLATE,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      EVE_MOCK_AUTHORED_MODELS: "1",
      WORKFLOW_POSTGRES_URL: CONNECTION,
    },
  });
  // Kept rather than discarded: when eve fails to boot, this output is the only
  // thing that says why, and the abort message has to carry it.
  const keep = (chunk) => {
    eveOutput = (eveOutput + chunk).slice(-4000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  eveProcess = child;
  return child;
}

/**
 * SIGKILL the server and everything it spawned.
 *
 * child.kill() signals exactly one pid. If any part of the tree outlives it,
 * that survivor still holds the graphile lock and goes on to finish the job,
 * which silently turns "eve was killed mid-job" into "eve completed the job"
 * and reports as a disproof of tier 1. Killing the process group is the only
 * way to know the thing holding the lock is actually dead.
 */
function killEve() {
  const child = eveProcess;
  eveProcess = null;
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// detached:true also puts eve outside the terminal process group, so a Ctrl-C
// aimed at this script no longer reaches it. Forward it by hand, or an
// interrupted run leaves a dev server and its Docker sandbox behind.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killEve();
    process.exit(2);
  });
}

/**
 * True when EVE — not merely something — answers on PORT.
 *
 * The earlier version accepted any response at all, including a 4xx, on a route
 * that does not exist. Every HTTP server on earth passes that, so a stray
 * process holding 2999 would have been mistaken for a booted eve and then
 * handed a turn. GET /eve/v1/health is registered for every app by the
 * framework (dist/src/internal/nitro/host/configure-nitro-routes.js), and a 2xx
 * from it is exactly how eve decides its own server is up
 * (dist/src/shared/eve-server-health.js, isEveServerHealthy).
 */
async function eveIsHealthy(timeoutMs = 2_000) {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * True when anything at all answers on PORT.
 *
 * Deliberately laxer than eveIsHealthy: the question here is whether the port
 * is free, and a stranger that 404s everything still owns it. On the machine
 * this was last attempted on, a stray `node fakeagent.mjs` from unrelated work
 * was already holding the default 2999 — eve would have lost the bind and the
 * stranger would have been handed the turn.
 */
async function portAlreadyAnswers() {
  try {
    await fetch(HEALTH_URL, { method: "GET", signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits for eve to answer its health route, giving up early if the process is
 * already gone.
 *
 * Returns a reason rather than a bare false, because the caller has to report
 * this as an environment failure and not as a failed check: a server that never
 * booted is not a disproof of anything.
 */
async function waitForServer(child, timeoutMs = BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await eveIsHealthy()) return { up: true };
    if (child.exitCode !== null || child.signalCode !== null) {
      return {
        up: false,
        reason:
          `eve dev exited (code ${child.exitCode}, signal ${child.signalCode}) ` +
          `before it answered ${HEALTH_URL}`,
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { up: false, reason: `eve dev did not answer ${HEALTH_URL} within ${timeoutMs / 1000}s` };
}

/**
 * Poll until a job row THIS RUN is responsible for is held, then resolve.
 *
 * `ignoreIds` holds every job id that existed before the run started. Without
 * it the first row with locked_at set wins, including a stranger row — and this
 * tier runs against the SHARED graphile schema, so a stranger is possible. That
 * row would then be killed, cleared, and published as vercel/eve#535.
 *
 * `targetId` pins cycles 2 and 3 to the job cycle 1 found. attempts only reach
 * max_attempts if the SAME row is claimed and killed three times, so drifting
 * onto a fresh job — every cycle posts a new turn, so there is always one —
 * would leave the final assertion permanently unreachable and report as a
 * disproof.
 */
async function waitForAHeldJob(client, ignoreIds, targetId, timeoutMs = HELD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await jobRows(client);
    const held = rows.find((r) => {
      if (r.locked_at === null) return false;
      if (targetId !== null) return String(r.id) === targetId;
      return !ignoreIds.has(String(r.id));
    });
    if (held) return held;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* run                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  section("PRECONDITIONS");

  if (!existsSync(join(TEMPLATE, "package.json"))) {
    refuse(`expected a template at ${TEMPLATE} — run this from an evestack checkout.`);
  }
  if (!existsSync(EVE_BIN)) {
    refuse(
      `no eve binary at ${EVE_BIN}.\n` +
        "Install the template dependencies first:\n" +
        "  pnpm install\n" +
        "Falling back to `npx eve` would fetch whatever version the registry serves\n" +
        "today, and this repro is a claim about eve 0.30.8 specifically.",
    );
  }
  if (!preflightMemory() && !FORCE) {
    refuse("not enough headroom to boot eve dev safely (see above).");
  }

  let client;
  try {
    client = await connect();
  } catch (error) {
    refuse(`cannot reach Postgres at ${CONNECTION}: ${error.message}`);
  }

  const { rows: schemaThere } = await client.query(
    `select 1 from information_schema.tables where table_schema = $1 and table_name = '_private_jobs'`,
    [GW_SCHEMA],
  );
  if (schemaThere.length === 0) {
    await client.end().catch(() => {});
    refuse(
      `no ${GW_SCHEMA}._private_jobs table. Bootstrap first:\n` +
        "  cd templates/default && npm run db:bootstrap",
    );
  }

  const before = await jobRows(client);
  note(`${before.length} pre-existing job row(s) in ${GW_SCHEMA}`);
  note("NOTE: this tier operates on the SHARED graphile schema, not a throwaway one,");
  note("because that is where world-postgres puts its jobs. It is therefore NOT as");
  note("self-isolating as tier 1 — run it against a scratch database.");

  // Every id that predates the run. Rows in here are never mistaken for the job
  // this run starts. See waitForAHeldJob.
  const baselineIds = new Set(before.map((r) => String(r.id)));

  const alreadyHeld = before.filter((r) => r.locked_at !== null);
  if (alreadyHeld.length > 0) {
    await client.end().catch(() => {});
    refuse(
      `${alreadyHeld.length} job row(s) here are already locked ` +
        `(ids ${alreadyHeld.map((r) => r.id).join(", ")}).\n` +
        "Another graphile worker is live on this schema. It can claim the job this run\n" +
        "starts before eve does, and its locked rows are indistinguishable from a\n" +
        "reproduction. Point WORKFLOW_POSTGRES_URL at a scratch database instead.",
    );
  }

  // The job cycle 1 wedges. Cycles 2 and 3 must land on this same row for
  // attempts to reach max_attempts. See waitForAHeldJob.
  let targetJobId = null;

  try {
    for (let cycle = 1; cycle <= MAX_ATTEMPTS; cycle++) {
      section(`CYCLE ${cycle} of ${MAX_ATTEMPTS} — start a turn, kill eve while the job is held`);

      if (await portAlreadyAnswers()) {
        abort(
          `port ${PORT} is already answering before eve was started. Whatever ` +
            "owns it would have answered the poll and taken the turn. Free it, or pass --port=.",
        );
        break;
      }

      const child = startEve();
      const boot = await waitForServer(child);
      if (!boot.up) {
        // An environment failure, NOT a failed check. ok(false) here — which is
        // what this used to do — exits 1 and prints "tier 1 may NOT transfer"
        // about a server that never came up.
        killEve();
        abort(
          `cycle ${cycle}: ${boot.reason}.\n` +
            "A server that never booted says nothing about tier 1 either way.\n" +
            (eveOutput.length > 0
              ? `last output from eve dev:\n${eveOutput}`
              : "eve dev produced no output."),
        );
        break;
      }
      note(`eve dev up on :${PORT} (pid ${child.pid}) with EVE_MOCK_AUTHORED_MODELS=1`);

      // Kick off a turn. A benign prompt: no tool-name match, so no turn-time
      // sandbox container and no embedding calls.
      //
      // `message` is a bare string. This route takes a string or an array of
      // text/file parts and answers 400 to anything else — the chat-style
      // {role, content} object this used to send was rejected every time.
      // Measured by running the shipped parser (eve 0.30.8,
      // dist/src/public/channels/eve.js, parseMessageField) on all three
      // shapes: object -> 400, "hello" -> accepted, [{type:"text"}] -> accepted.
      // Same shape the dashboard sends: packages/dashboard/lib/agent-client.ts
      // declares UserMessage = string | UserContentPart[], and 202 is the
      // documented answer (FINDINGS.md, verified 2026-08-04).
      const turn = fetch(CREATE_SESSION_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
        // Without a bound, a server that accepts the connection and never
        // answers parks the run forever, and a hang is not one of the three
        // outcomes.
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      }).then(
        async (response) => ({
          status: response.status,
          body: await response.text().catch(() => ""),
        }),
        (error) => ({ status: 0, body: String(error?.message ?? error) }),
      );

      const held = await waitForAHeldJob(client, baselineIds, targetJobId);

      // The status of the turn is read on EVERY cycle, and BEFORE `held` is
      // allowed to mean anything.
      //
      // Reading it only when no job showed up leaves the mirror-image hole: a
      // refusal landing beside a locked row left by someone else reports as a
      // reproduction. Not reading it at all — the original — turns a 400 into
      // "the turn may not be job-backed", which reads as a disproof of tier 1
      // from a run that never started a turn.
      const response = await turn;
      if (response.status === 0) {
        // No status at all: transport error, or the bound above. Whether a turn
        // was ever accepted is unknown, and an unheld job cannot settle it.
        abort(
          `cycle ${cycle}: create-session never returned a status ` +
            `(${response.body.slice(0, 200)}).\n` +
            "Whether a turn was ever accepted is unknown, so this run is not a result.",
        );
        break;
      }
      if (response.status !== 202) {
        // 202 is the only acceptance. 204 in particular is a dropped message:
        // a well-formed request that enqueued nothing at all.
        abort(
          `cycle ${cycle}: create-session did not accept the turn ` +
            `(HTTP ${response.status}, expected 202): ${response.body.slice(0, 400)}\n` +
            "Nothing was enqueued, so this run says NOTHING about tier 1 either way.",
        );
        break;
      }

      if (held === null) {
        // The turn WAS accepted and nothing was ever claimed. This is the one
        // honest "did not reproduce" available on this path.
        ok(
          false,
          `cycle ${cycle}: turn accepted (202) but ` +
            (targetJobId === null ? "no new job" : `job ${targetJobId}`) +
            ` was not held within ${HELD_TIMEOUT_MS / 1000}s — the turn may not be job-backed`,
        );
        break;
      }
      if (targetJobId === null) targetJobId = String(held.id);
      note(`job ${held.id} is held (attempts ${held.attempts}); killing eve now`);

      killEve();
      await new Promise((r) => setTimeout(r, 1500));

      const rows = await jobRows(client);
      table(rows);
      const row = rows.find((r) => String(r.id) === String(held.id));
      if (!row) {
        // graphile deletes a job row on success, so a vanished row means the
        // turn finished before the kill landed. Nothing wedged — and reading
        // last_error off undefined, which is what this used to do, would have
        // crashed rather than said so.
        ok(false, `cycle ${cycle}: job ${held.id} is gone — it completed before the kill landed`);
        break;
      }

      ok(
        row.last_error === null,
        `cycle ${cycle}: last_error is NULL — eve died, it did not fail, so failJob never ran`,
      );

      // The operator remediation, and step 5 of vercel/eve#535: clear the lock
      // and see whether the job comes back.
      await client.query(
        `update ${GW_SCHEMA}._private_jobs set locked_at = null, locked_by = null, run_at = now()
          where id = $1`,
        [held.id],
      );
      const after = (await jobRows(client)).find((r) => String(r.id) === String(held.id));
      if (!after) {
        ok(false, `cycle ${cycle}: job ${held.id} disappeared while the lock was being cleared`);
        break;
      }

      if (cycle < MAX_ATTEMPTS) {
        ok(
          after.is_available === true,
          `cycle ${cycle}: clearing the lock still revives it ` +
            `(attempts ${after.attempts} < ${after.max_attempts})`,
        );
      } else {
        table([after]);
        const wedged = after.is_available === false && after.attempts === after.max_attempts;
        ok(
          wedged,
          "FINAL: the job behind the turn is now permanently unavailable, and clearing the lock does nothing",
          "this is vercel/eve#535 step 5 on the real stack",
        );
        // The only assignment. Nothing else may conclude REPRODUCED.
        reproduced = wedged;
      }
    }

    if (abortReason === null) {
      section("VERDICT");
      process.stdout.write(
        reproduced && failures === 0
          ? "REPRODUCED — the tier-1 mechanism transfers to the real stack.\n"
          : `DID NOT REPRODUCE — ${failures} check(s) failed and the final wedge ` +
              "assertion did not pass. Tier 1 may NOT transfer. Do not publish this as-is.\n",
      );
    }
  } finally {
    killEve();
    if (client) await client.end().catch(() => {});
  }

  if (abortReason !== null) {
    process.stderr.write(
      "\nINCONCLUSIVE — the run could not be carried out. This is NOT a result and must\n" +
        "not be read as evidence for or against tier 1.\n" +
        `${abortReason}\n`,
    );
    process.exit(2);
  }
  process.exit(reproduced && failures === 0 ? 0 : 1);
}

main().catch((error) => {
  killEve();
  process.stderr.write(`\nINCONCLUSIVE — repro crashed: ${error?.stack ?? error}\n`);
  process.exit(2);
});
