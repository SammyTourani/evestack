#!/usr/bin/env node
/**
 * Drive a gated tool from parked to deleted, and read what the audit log says
 * about WHO did it.
 *
 * ─ Why this is a script and not a probe ─
 *
 * The gate can only fire if the model decides to call `forget`, and eve exposes
 * no `toolChoice`. Measured against qwen3 that is roughly two calls in three,
 * which is why the template ships `npm run demo:approval` — it asks up to three
 * times, with the wording that measured best first. contract/runtime/probes/ is
 * deterministic by charter (a check that is right three times in four gets
 * muted, and a muted check is worse than an absent one), so this lives beside
 * promote-and-run-eval.mjs instead: a command a human or a nightly job runs.
 *
 * It is free on the Ollama path, which removes the usual excuse.
 *
 * ─ What it asserts, and why each half is here ─
 *
 *   PARKED       `npm run demo:approval` exits 0 and names a session. This is
 *                the shipped command, run as shipped — not a reimplementation
 *                of it, because a reimplementation would stop testing the thing
 *                a newcomer is told to run.
 *   RESOLVED     the decision goes through the dashboard route the Chat page
 *                posts to, with the deployment credential. eve has no
 *                approve endpoint; that route is the only place a decision can
 *                be attributed to anything at all.
 *   AUDITED      a row lands in `evestack.approvals` naming the tool, the
 *                option and the request.
 *   DELETED      the memory is gone from `evestack.memories`. Everything above
 *                can pass while the approval resolves into nothing, and an
 *                approval gate that does not carry out the action it gated is
 *                worse than no gate.
 *   WHO          and this is the point of the whole exercise. `approver` is the
 *                single `EVESTACK_AUTH_USER` the scaffolder generated. There is
 *                ONE such credential per installation, so "who decided what"
 *                resolves to the installation plus a network address — you can
 *                tell two machines apart, never two people sharing the
 *                password. The request below carries a forged
 *                `X-Forwarded-User` precisely so the log can be shown to ignore
 *                it: without EVESTACK_TRUSTED_PROXY set, anyone who can reach
 *                the port could otherwise write whatever name they liked into
 *                the audit trail. The product does not oversell this and
 *                neither does this script.
 *
 * USE
 *
 *   node contract/runtime/approval-end-to-end.mjs --project=/path/to/my-agent
 *
 * Everything else defaults out of the project`s own `.env.local`:
 * `--dashboard`, `--agent`, `--user`, `--password`, `--database`.
 *
 * Exit codes: 0 every assertion held - 1 an assertion failed - 2 could not get
 * far enough to find out (no project, nothing listening, the model refused).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = null) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const PROJECT = resolve(flag("project", process.cwd()));

const out = (s) => process.stdout.write(s);
const section = (title) => out(`\n${title} ${"─".repeat(Math.max(0, 72 - title.length))}\n\n`);
const die = (message) => {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(2);
};

let failures = 0;
function check(passed, detail, extra) {
  out(`  ${passed ? "PASS" : "FAIL"}  ${detail}\n`);
  if (!passed) {
    failures += 1;
    if (extra !== undefined) out(`        ${extra}\n`);
  }
}

/**
 * `.env.local` only, and not `.env`.
 *
 * They hold the same credential today, and the scaffolder writes both — but
 * `.env.local` is the one the agent and the CLI read, so it is the one whose
 * value is the truth about what `approver` will contain. Reading the other
 * would make this script agree with itself rather than with the product.
 */
function projectEnv() {
  const file = join(PROJECT, ".env.local");
  if (!existsSync(file)) die(`No .env.local in ${PROJECT}. Point --project at a scaffolded agent.`);
  const values = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return values;
}

const env = projectEnv();
const DASHBOARD = (flag("dashboard", "http://127.0.0.1:4000") ?? "").replace(/\/$/, "");
const USER = flag("user", env.get("EVESTACK_AUTH_USER"));
const PASSWORD = flag("password", env.get("EVESTACK_AUTH_PASSWORD"));
const DATABASE = flag("database", env.get("WORKFLOW_POSTGRES_URL"));
/** A name no deployment could plausibly have configured, so a log that records
 *  it is recording something the caller made up. */
const FORGED = "someone-who-does-not-work-here";

if (!USER || !PASSWORD) die("No EVESTACK_AUTH_USER / EVESTACK_AUTH_PASSWORD — pass --user/--password.");
if (!DATABASE) die("No WORKFLOW_POSTGRES_URL in .env.local — pass --database.");

const { default: pg } = await import("pg");
const sql = new pg.Client({ connectionString: DATABASE });
try {
  await sql.connect();
} catch (error) {
  die(`Cannot reach Postgres at the project's WORKFLOW_POSTGRES_URL: ${error.message}`);
}

const basic = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;

/**
 * The demo aims at the OLDEST memory, so it has to have one to aim at.
 *
 * With an empty table the gate still parks — approval is evaluated before
 * execute — but "the memory was deleted" becomes an assertion about nothing,
 * which is the failure mode this whole exercise exists to avoid. The embedding
 * is a constant vector rather than a real one: nothing here searches, and
 * calling an embedding provider to write a fixture would make this script
 * depend on a second model.
 */
async function ensureAMemoryExists() {
  const { rows } = await sql.query("SELECT count(*)::int AS n FROM evestack.memories");
  if (rows[0].n > 0) return false;
  await sql.query(
    `INSERT INTO evestack.memories (content, tags, embedding)
     VALUES ($1, ARRAY['probe']::text[],
             (SELECT array_agg(0.001::real)::vector FROM generate_series(1, 768)))`,
    ["a memory written by approval-end-to-end.mjs so the gate has something to delete"],
  );
  return true;
}

/** ANSI colour is for a terminal; this output is being read by a regex. */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const plain = (s) => s.replace(ANSI, "");
const indent = (s) => s.split("\n").map((l) => `  | ${l}`).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

section("1 - park a real approval with the shipped demo");

const seeded = await ensureAMemoryExists();
if (seeded) out("  (the memories table was empty, so one was written for the gate to delete)\n\n");

let demo;
try {
  demo = plain(
    execFileSync("npm", ["run", "--silent", "demo:approval"], {
      cwd: PROJECT,
      encoding: "utf8",
      timeout: 15 * 60_000,
    }),
  );
} catch (error) {
  out(indent(plain(`${error.stdout ?? ""}${error.stderr ?? ""}`)));
  await sql.end();
  die(
    "npm run demo:approval did not park an approval. On the $0 path that is usually the model " +
      "declining to call the tool three times over, which is a model limitation rather than a " +
      "gate bug — the demo says as much itself. Run it again.",
  );
}
out(indent(demo));

const sessionId = /Session\s+(wrun_[A-Za-z0-9]+)/.exec(demo)?.[1] ?? null;
const parkedInput = /forget\s+(\{[^\n]*\})/.exec(demo)?.[1] ?? null;
check(sessionId !== null, "the demo parked a turn and named the session it parked");
if (sessionId === null) {
  await sql.end();
  process.exit(2);
}
const targetId = parkedInput === null ? null : JSON.parse(parkedInput).id;
check(
  Number.isInteger(targetId),
  "and the parked request carries the memory id the tool would delete",
  `parsed ${parkedInput}`,
);

const before = await sql.query("SELECT id, content FROM evestack.memories WHERE id = $1", [targetId]);
check(
  before.rowCount === 1,
  "and that memory exists right now, so deleting it is a real consequence",
  `memory ${targetId} is not in evestack.memories — the deletion assertion below would be vacuous`,
);

section("2 - resolve it from the dashboard, carrying a forged identity header");

const response = await fetch(`${DASHBOARD}/api/control/sessions/${sessionId}/approve`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: basic,
    // Ignored unless EVESTACK_TRUSTED_PROXY is set. Sent so that the audit row
    // below can be shown NOT to contain it.
    "x-forwarded-user": FORGED,
  },
  body: JSON.stringify({ decision: "approve" }),
});
const body = await response.json().catch(() => ({}));
out(`  ${response.status} ${JSON.stringify(body)}\n\n`);

check(response.ok === true && body.ok === true, "the dashboard accepted the decision", JSON.stringify(body));
check(
  Array.isArray(body.answered) && body.answered[0]?.optionId === "approve",
  "and answered the outstanding request with approve",
  JSON.stringify(body.answered),
);
check(body.audited === true, "and says it wrote the audit row rather than silently failing to");

section("3 - the audit row");

// The route writes it after eve accepts, so it can trail the response by a
// moment. Polled rather than slept on, and a timeout here is a real failure.
let audit = null;
for (let attempt = 0; attempt < 40 && audit === null; attempt += 1) {
  const { rows } = await sql.query(
    `SELECT * FROM evestack.approvals WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );
  audit = rows[0] ?? null;
  if (audit === null) await sleep(250);
}

check(audit !== null, "an evestack.approvals row exists for this session");
if (audit !== null) {
  out(`  ${JSON.stringify(audit, null, 2).split("\n").join("\n  ")}\n\n`);
  check(audit.tool_name === "forget", "it names the tool that was gated", `tool_name ${audit.tool_name}`);
  check(audit.option_id === "approve", "and the decision", `option_id ${audit.option_id}`);
  check(
    audit.request_kind === "tool-approval",
    "and that the thing decided was a tool approval rather than a question",
    `request_kind ${audit.request_kind}`,
  );
  check(
    typeof audit.request_id === "string" && audit.request_id.length > 0,
    "and the request it answered, so two parked calls cannot be confused",
  );
  check(audit.decided_at instanceof Date, "and when, in a timezone-aware column");
}

section("4 - the memory is actually gone");

// The delete happens inside the resumed turn, not inside the HTTP request that
// approved it. Everything above can hold while the approval resolves into
// nothing at all, which is the failure this section exists for.
let remaining = 1;
for (let attempt = 0; attempt < 120 && remaining > 0; attempt += 1) {
  const { rows } = await sql.query(
    "SELECT count(*)::int AS n FROM evestack.memories WHERE id = $1",
    [targetId],
  );
  remaining = rows[0].n;
  if (remaining > 0) await sleep(500);
}
check(
  remaining === 0,
  `memory ${targetId} was deleted by the approved tool call`,
  "the gate was answered and the row is still there — an approval that carries out nothing is worse than no gate",
);

section("5 - what `approver` actually records");

if (audit !== null) {
  check(
    audit.approver === USER,
    `approver is the installation credential EVESTACK_AUTH_USER (${USER}), not a person`,
    `approver ${audit.approver}, expected ${USER}`,
  );
  check(
    audit.approver !== FORGED && audit.approver_via !== "forwarded-user",
    "a forged X-Forwarded-User header did NOT become the name in the audit log",
    `approver ${audit.approver} via ${audit.approver_via} — anyone who can reach this port could ` +
      "write whatever name they liked into the audit trail",
  );
  check(
    audit.approver_via === "basic" || audit.approver_via === "session",
    "and approver_via says which deployment-wide credential proved it",
    `approver_via ${audit.approver_via}`,
  );
  check(
    typeof audit.remote_addr === "string" && audit.remote_addr.length > 0,
    "a network address is recorded alongside it",
    `remote_addr ${audit.remote_addr}`,
  );

  // The honest reading, stated as an assertion so it cannot quietly stop being
  // true: every decision this installation has ever recorded carries the same
  // name. That is the whole limit. Two machines are distinguishable by
  // remote_addr; two people sharing the one generated password are not.
  const { rows: distinct } = await sql.query(
    "SELECT DISTINCT approver FROM evestack.approvals WHERE approver IS NOT NULL",
  );
  const names = distinct.map((r) => r.approver);
  check(
    names.length === 1 && names[0] === USER,
    "every approval in this database names that same one credential — 'who' is the installation, plus an address",
    `found ${names.join(", ")} — if a second name appeared, a trusted proxy is configured and ` +
      "attribution is finer than this script assumes",
  );
  out(
    "\n  Read this the way the product states it: eve's protocol carries no identity, so the\n" +
      "  dashboard is the only place a decision is attributed at all — and what it can attribute\n" +
      "  is the deployment credential and the address it came from. Per-person attribution needs\n" +
      "  EVESTACK_TRUSTED_PROXY plus a proxy that authenticates people; until then approver_via\n" +
      "  reads `basic` or `session`, never `forwarded-user`.\n",
  );
}

await sql.end();
section(failures === 0 ? "all green" : `${failures} assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
