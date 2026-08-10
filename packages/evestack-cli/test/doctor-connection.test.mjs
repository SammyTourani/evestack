/**
 * Which database `evestack doctor` looks at, and what it says when it cannot
 * look at one.
 *
 * The bug these are for: doctor was the only command that never read the
 * project's env files. On a freshly scaffolded, fully healthy stack it fell
 * through to a built-in `postgres://evestack:evestack@localhost:5433/evestack`
 * — a URL the scaffolder cannot have written, because it generates a random
 * password — and reported "password authentication failed" seconds after
 * `evestack verify` had printed "Everything works." about the same database.
 *
 * No Postgres is opened here. Resolution and classification are both pure, and
 * that is deliberate: the wrong answer was a wrong string, not a wrong query.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.mjs";
import { NO_DATABASE_URL, resolveConnection } from "../src/doctor.mjs";
import { classifyConnectFailure, connectFailureMessage } from "../src/db.mjs";

/** Collects what a command wrote, so nothing lands on the real terminal. */
function sink() {
  const chunks = [];
  return {
    write: (chunk) => chunks.push(chunk) > 0,
    get text() {
      return chunks.join("");
    },
  };
}

/** A project directory with exactly the env files named, and nothing else. */
function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "evestack-doctor-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/**
 * Both names doctor reads, cleared for the duration.
 *
 * Without this the suite passes or fails depending on whether whoever ran it
 * happens to export WORKFLOW_POSTGRES_URL, which is the exact class of thing
 * these tests exist to pin down.
 */
async function withoutEnv(run) {
  const url = process.env.WORKFLOW_POSTGRES_URL;
  const database = process.env.DATABASE_URL;
  delete process.env.WORKFLOW_POSTGRES_URL;
  delete process.env.DATABASE_URL;
  try {
    return await run();
  } finally {
    restore("WORKFLOW_POSTGRES_URL", url);
    restore("DATABASE_URL", database);
  }
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** doctor resolves against the working directory, so the tests have to move. */
async function inDirectory(dir, run) {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(cwd);
  }
}

const URL_IN_FILE = "postgres://evestack:s3cr3t@127.0.0.1:5433/evestack";
const ATTACHED = JSON.stringify({ dependencies: { eve: "^0.30.8" } });

/* -------------------------------------------------------------------------- */
/* where the connection string comes from                                      */
/* -------------------------------------------------------------------------- */

test("the project's .env.local is read, which is the whole bug", async () => {
  // `evestack verify` said "Everything works." and `evestack doctor`, in the same
  // directory in the same minute, said "password authentication failed" — because
  // it never opened this file.
  const dir = project({ ".env.local": `WORKFLOW_POSTGRES_URL=${URL_IN_FILE}\n` });
  await withoutEnv(() => {
    assert.equal(resolveConnection(undefined, { from: dir }).connectionString, URL_IN_FILE);
  });
});

test("it is read from a subdirectory too, the way every other command reads it", async () => {
  const dir = project({ ".env.local": `WORKFLOW_POSTGRES_URL=${URL_IN_FILE}\n` });
  const deep = join(dir, "agent", "tools");
  mkdirSync(deep, { recursive: true });
  await withoutEnv(() => {
    assert.equal(resolveConnection(undefined, { from: deep }).connectionString, URL_IN_FILE);
  });
});

test(".env.local wins over .env, which is eve's own load order", async () => {
  const dir = project({
    "package.json": ATTACHED,
    ".env": "WORKFLOW_POSTGRES_URL=postgres://from-dot-env/x\n",
    ".env.local": `WORKFLOW_POSTGRES_URL=${URL_IN_FILE}\n`,
  });
  await withoutEnv(() => {
    assert.equal(resolveConnection(undefined, { from: dir }).connectionString, URL_IN_FILE);
  });
});

test("an attached project that keeps its URL in .env is read as well", async () => {
  // `attach` writes to .env when the project already has one, so a project with
  // no .env.local at all is a supported shape rather than a broken install.
  const dir = project({ "package.json": ATTACHED, ".env": `WORKFLOW_POSTGRES_URL=${URL_IN_FILE}\n` });
  await withoutEnv(() => {
    assert.equal(resolveConnection(undefined, { from: dir }).connectionString, URL_IN_FILE);
  });
});

test("DATABASE_URL in the file is honoured, as --help promises for the variable", async () => {
  const dir = project({ ".env.local": `DATABASE_URL=${URL_IN_FILE}\n` });
  await withoutEnv(() => {
    assert.equal(resolveConnection(undefined, { from: dir }).connectionString, URL_IN_FILE);
  });
});

test("--url beats the file, so this stays pointable at production", async () => {
  const dir = project({ ".env.local": `WORKFLOW_POSTGRES_URL=${URL_IN_FILE}\n` });
  const explicit = "postgres://ops@db.internal:5432/prod";
  await withoutEnv(() => {
    assert.equal(resolveConnection(explicit, { from: dir }).connectionString, explicit);
  });
});

test("the real environment beats the file, so a container needs no project", async () => {
  const dir = project({ ".env.local": `WORKFLOW_POSTGRES_URL=${URL_IN_FILE}\n` });
  const exported = "postgres://ops@db.internal:5432/exported";
  await withoutEnv(() => {
    process.env.WORKFLOW_POSTGRES_URL = exported;
    assert.equal(resolveConnection(undefined, { from: dir }).connectionString, exported);
  });
});

test("an exported-but-empty variable is not a connection string", async () => {
  // The old chain used ??, so WORKFLOW_POSTGRES_URL= in a shell profile beat
  // every real answer with the empty string.
  const dir = project({ ".env.local": `WORKFLOW_POSTGRES_URL=${URL_IN_FILE}\n` });
  await withoutEnv(() => {
    process.env.WORKFLOW_POSTGRES_URL = "";
    assert.equal(resolveConnection(undefined, { from: dir }).connectionString, URL_IN_FILE);
  });
});

test("outside a project there is no guess left to make", async () => {
  // There used to be a DEFAULT_CONNECTION here, and because the scaffolder
  // generates a random password it could never be right — all it ever did was
  // turn "you are not in a project" into "password authentication failed".
  const empty = mkdtempSync(join(tmpdir(), "evestack-empty-"));
  await withoutEnv(() => {
    const resolved = resolveConnection(undefined, { from: empty });
    assert.equal(resolved.connectionString, null);
    assert.equal(resolved.project, null);
  });
});

test("inside a project that configures no database, the project is still reported", async () => {
  // Two empty answers, two different sentences: this one is a missing line in a
  // file, not a directory someone wandered into.
  const dir = project({ ".env.local": "EVESTACK_AUTH_USER=evestack\n" });
  await withoutEnv(() => {
    const resolved = resolveConnection(undefined, { from: dir });
    assert.equal(resolved.connectionString, null);
    assert.equal(resolved.project, dir);
  });
});

/* -------------------------------------------------------------------------- */
/* what the command does with each of those                                    */
/* -------------------------------------------------------------------------- */

test("from outside a project, doctor refuses the way the other commands refuse", async () => {
  // status, verify, open and tour all print "This is not an evestack project."
  // with the fix. doctor guessed a connection string, connected to whatever was
  // on localhost:5433, and printed a Postgres error at someone who had not asked
  // about Postgres.
  const empty = mkdtempSync(join(tmpdir(), "evestack-empty-"));
  const stdout = sink();
  const stderr = sink();
  const run = () => main(["doctor"], { stdout, stderr });
  const code = await withoutEnv(() => inDirectory(empty, run));
  assert.equal(code, 2, "could not look");
  assert.match(stderr.text, /This is not an evestack project/);
  assert.doesNotMatch(stderr.text, /password authentication/);
  assert.equal(stdout.text, "");
});

test("inside a project with no database line, it says that instead", async () => {
  const dir = project({ ".env.local": "EVESTACK_AUTH_USER=evestack\n" });
  const stdout = sink();
  const stderr = sink();
  const run = () => main(["doctor"], { stdout, stderr });
  const code = await withoutEnv(() => inDirectory(dir, run));
  assert.equal(code, 2, "could not look");
  assert.match(stderr.text, /No database to look at/);
  assert.doesNotMatch(stderr.text, /This is not an evestack project/);
  assert.equal(stdout.text, "");
  assert.match(NO_DATABASE_URL, /WORKFLOW_POSTGRES_URL/);
});

/* -------------------------------------------------------------------------- */
/* which kind of failure it was                                                */
/* -------------------------------------------------------------------------- */

/** Shaped like the errors pg throws; every code below came off a live server. */
function pgError(code, message, severity) {
  const error = new Error(message);
  error.code = code;
  if (severity) error.severity = severity;
  return error;
}

const REFUSED = pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5433");
const NO_HOST = pgError("ENOTFOUND", "getaddrinfo ENOTFOUND db.invalid");
const BAD_PASSWORD = pgError("28P01", "password authentication failed for user evestack", "FATAL");
const NO_HBA = pgError("28000", "no pg_hba.conf entry for host", "FATAL");
const NO_DATABASE = pgError("3D000", "database nope does not exist", "FATAL");
const TOO_MANY = pgError("53300", "sorry, too many clients already", "FATAL");

test("a refused socket and a rejected password are not the same failure", () => {
  assert.equal(classifyConnectFailure(REFUSED), "unreachable");
  assert.equal(classifyConnectFailure(NO_HOST), "unreachable");
  assert.equal(classifyConnectFailure(new Error("Connection terminated due to connection timeout")), "unreachable");
  assert.equal(classifyConnectFailure(BAD_PASSWORD), "credentials");
  assert.equal(classifyConnectFailure(NO_HBA), "credentials");
  assert.equal(classifyConnectFailure(NO_DATABASE), "no-database");
  assert.equal(classifyConnectFailure(TOO_MANY), "refused");
});

const TARGET = "postgres://evestack:hunter2@127.0.0.1:5433/evestack";

test("an authentication failure is never answered with docker compose up", () => {
  // The finding in full: Postgres was up and healthy, and the advice was to
  // start one. A stranger runs it, sees nothing change, and concludes the
  // database is broken while `verify` insists it is fine.
  const message = connectFailureMessage(TARGET, BAD_PASSWORD);
  assert.doesNotMatch(message, /docker compose up/);
  assert.doesNotMatch(message, /Cannot reach Postgres/);
  assert.match(message, /is up at/);
  assert.match(message, /password authentication failed/);
  assert.doesNotMatch(message, /hunter2/);
});

test("a missing database is not reported as a missing server either", () => {
  const message = connectFailureMessage(TARGET, NO_DATABASE);
  assert.doesNotMatch(message, /docker compose up/);
  assert.match(message, /does not exist/);
  assert.doesNotMatch(message, /hunter2/);
});

test("a server that objected for some other reason names its own SQLSTATE", () => {
  const message = connectFailureMessage(TARGET, TOO_MANY);
  assert.doesNotMatch(message, /docker compose up/);
  assert.match(message, /53300/);
});

test("a database that really is not there keeps the advice it always had", () => {
  // Unchanged on purpose. For a database that is genuinely down this wording
  // was already right, and it is what the existing repro test asserts on.
  const message = connectFailureMessage(TARGET, REFUSED);
  assert.match(message, /Cannot reach Postgres/);
  assert.match(message, /docker compose up -d postgres/);
  assert.doesNotMatch(message, /hunter2/);
});

test("a dual-stack AggregateError still says what went wrong", () => {
  // Its own message is empty and the real ones are underneath it, so the line
  // where the reason goes was blank.
  const both = [pgError("ECONNREFUSED", "connect ECONNREFUSED ::1:5433"), REFUSED];
  const message = connectFailureMessage(TARGET, new AggregateError(both, ""));
  assert.match(message, /ECONNREFUSED ::1:5433/);
  assert.match(message, /ECONNREFUSED 127.0.0.1:5433/);
});
