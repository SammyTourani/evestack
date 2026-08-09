/**
 * The command surface and the connection safety rails.
 *
 * The last test in this file is the only one that opens a socket: it points the
 * real CLI at a port nothing is listening on, which is the state of the world in
 * the most common reason to reach for a doctor command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { tmpdir } from "node:os";

import {
  COMMANDS, DOCTOR_USAGE, main, parseArgs, scaffoldCommand, unknownCommand, USAGE,
} from "../src/cli.mjs";
import { safeIdentifier, redact, parseUtcTimestamp, DoctorError } from "../src/db.mjs";
import { duration, table, firstLine } from "../src/format.mjs";

class Sink {
  constructor() {
    this.text = "";
  }
  write(chunk) {
    this.text += chunk;
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* arguments                                                                   */
/* -------------------------------------------------------------------------- */

test("flags parse into the shape diagnose() expects", () => {
  const options = parseArgs(["doctor", "--schema=gw", "--limit=10", "--json"]);
  assert.equal(options.command, "doctor");
  assert.equal(options.schema, "gw");
  assert.equal(options.limit, "10");
  assert.equal(options.json, true);
});

test("a space-separated value is refused rather than silently defaulted", () => {
  // `--limit 50` would otherwise parse as `--limit` plus a stray positional and
  // quietly run with the default limit, which is the worst kind of wrong.
  assert.throws(() => parseArgs(["doctor", "--limit", "50"]), DoctorError);
});

test("unknown flags are refused, not ignored", () => {
  assert.throws(() => parseArgs(["doctor", "--fix"]), /Unknown option --fix/);
});

test("a URL containing an = survives parsing", () => {
  const options = parseArgs(["doctor", "--url=postgres://u:p@h/db?sslmode=require"]);
  assert.equal(options.url, "postgres://u:p@h/db?sslmode=require");
});

test("no arguments, outside a project, prints the command list and is not an error", async () => {
  // This used to exit 2 — an error code for typing the program's name. Outside
  // a project the command list IS the answer to "evestack", so it is a success.
  // Inside one, the answer is `status`; that path is covered in status.test.mjs
  // because it needs a project on disk to find.
  const stdout = new Sink();
  const cwd = process.cwd();
  try {
    // A directory with no .env.local above it, so findProject() finds nothing.
    process.chdir(tmpdir());
    assert.equal(await main([], { stdout, stderr: new Sink() }), 0);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(stdout.text, USAGE);
});

test("--help exits 0", async () => {
  const stdout = new Sink();
  assert.equal(await main(["--help"], { stdout, stderr: new Sink() }), 0);
});

test("an unknown command does not fall through to doctor", async () => {
  const stderr = new Sink();
  assert.equal(await main(["fix"], { stdout: new Sink(), stderr }), 2);
  assert.match(stderr.text, /Unknown command "fix"/);
  // Every command the binary ships is listed in the usage that follows, so the
  // one message a user sees after mistyping names all of them. It used to name
  // three of five in a hand-written sentence that went stale twice.
  for (const command of COMMANDS) {
    assert.match(stderr.text, new RegExp(`evestack ${command}\\b`));
  }
});

test("a near-miss is corrected rather than just refused", () => {
  // Distance 2, so a transposition and a slip are caught...
  assert.match(unknownCommand("verfiy"), /Did you mean `evestack verify`\?/);
  assert.match(unknownCommand("statsu"), /Did you mean `evestack status`\?/);
  assert.match(unknownCommand("docter"), /Did you mean `evestack doctor`\?/);
  // ...and a word that simply is not one of ours is not guessed at. A
  // suggestion that fires on anything vaguely similar teaches people to ignore
  // suggestions.
  assert.doesNotMatch(unknownCommand("deploy"), /Did you mean/);
  assert.doesNotMatch(unknownCommand("publish"), /Did you mean/);
});

test("the usage text does not advertise a --fix that deliberately does not exist", () => {
  assert.doesNotMatch(USAGE, /--fix/);
  assert.doesNotMatch(DOCTOR_USAGE, /--fix/);
  // The read-only promise belongs to doctor's own help. It was in the top-level
  // usage, which is how that block reached thirty-eight lines.
  assert.match(DOCTOR_USAGE, /never writes to your database/);
});

test("the command list stays short enough to read", () => {
  // The regression this guards: the top-level help grew a quickstart, a
  // paragraph about doctor, and a note about both front doors — thirty-eight
  // lines for a question whose answer is "which verb do I want".
  assert.ok(
    USAGE.split("\n").length <= 20,
    `top-level usage is ${USAGE.split("\n").length} lines; it is the command list, not the manual`,
  );
});

/* -------------------------------------------------------------------------- */
/* one command, three subcommands                                              */
/* -------------------------------------------------------------------------- */

test("the top-level usage names every command and both front doors", () => {
  // The whole point of merging the two CLIs: someone who runs `evestack` with
  // no arguments has to be able to see that `create` exists here, and that the
  // `npx create-evestack` in every doc is the same thing.
  for (const command of COMMANDS.map((n) => `evestack ${n}`)) {
    assert.match(USAGE, new RegExp(command.replace(" ", "\\s")));
  }
  assert.match(USAGE, /npx create-evestack/);
});

test("`--help` gets the command list; `doctor --help` gets doctor's flags", async () => {
  const top = new Sink();
  assert.equal(await main(["--help"], { stdout: top, stderr: new Sink() }), 0);
  assert.equal(top.text, USAGE);

  const doctor = new Sink();
  assert.equal(await main(["doctor", "--help"], { stdout: doctor, stderr: new Sink() }), 0);
  assert.equal(doctor.text, DOCTOR_USAGE);
  assert.match(doctor.text, /--schema=NAME/);
});

test("scaffold commands are routed before doctor's parser sees their flags", () => {
  assert.equal(scaffoldCommand(["create", "my-agent", "--yes"]), "create");
  assert.equal(scaffoldCommand(["attach", ".", "--dry-run"]), "attach");
  assert.equal(scaffoldCommand(["doctor", "--json"]), null);
  assert.equal(scaffoldCommand([]), null);
  // Only in first position: `evestack doctor create` is a doctor invocation
  // with a stray argument, and misreading it as a scaffold would create a
  // directory for someone who asked to diagnose a database.
  assert.equal(scaffoldCommand(["doctor", "create"]), null);

  // This is what the router is protecting against. doctor's parser takes one
  // positional and refuses every flag it does not know, and a scaffold
  // invocation is neither — `evestack create my-agent` is already an
  // "Unexpected argument", and `--yes` an "Unknown option", so routing after
  // parsing would mean the wizard never started.
  assert.throws(() => parseArgs(["create", "my-agent", "--yes"]), /Unexpected argument "my-agent"/);
  assert.throws(() => parseArgs(["create", "--yes"]), /Unknown option --yes/);
});

test("both scaffold commands are actually reachable", async () => {
  // Not executed — the wizard writes files and runs a package install — but the
  // delegation module has to export exactly the names the router indexes it by,
  // and a typo there is only discoverable at runtime in a no-build package.
  const scaffold = await import("../src/scaffold.mjs");
  for (const name of ["create", "attach"]) {
    assert.equal(typeof scaffold[name], "function", name);
  }
});

/* -------------------------------------------------------------------------- */
/* safety rails                                                                */
/* -------------------------------------------------------------------------- */

test("schema names are identifiers or nothing — they are interpolated, not bound", () => {
  assert.equal(safeIdentifier("graphile_worker", "--schema"), "graphile_worker");
  assert.equal(safeIdentifier("_x$1", "--schema"), "_x$1");
  for (const hostile of [
    "public; drop schema public cascade",
    'gw" --',
    "gw.jobs",
    "1abc",
    "",
    "a".repeat(64),
  ]) {
    assert.throws(() => safeIdentifier(hostile, "--schema"), DoctorError, hostile);
  }
});

test("the password never appears in output", () => {
  assert.equal(
    redact("postgres://evestack:hunter2@db.internal:5432/eve"),
    "postgres://evestack:***@db.internal:5432/eve",
  );
  // Nothing to redact is left exactly as it was, so the target stays readable.
  assert.equal(redact("postgres://localhost:5432/eve"), "postgres://localhost:5432/eve");
});

test("eve's zone-less timestamps are read as the UTC they actually are", () => {
  const fallback = () => {
    throw new Error("should not reach pg's local-zone parser");
  };
  assert.equal(
    parseUtcTimestamp("2026-08-04 12:01:25.559334", fallback).toISOString(),
    "2026-08-04T12:01:25.559Z",
  );
  // Anything pg can emit that this cannot parse falls through untouched rather
  // than being mangled: `infinity`, `-infinity`, a ` BC` suffix.
  assert.equal(parseUtcTimestamp("infinity", () => "passed-through"), "passed-through");
});

/* -------------------------------------------------------------------------- */
/* formatting                                                                  */
/* -------------------------------------------------------------------------- */

test("durations read as a human would say them", () => {
  assert.equal(duration(5_000), "5s");
  assert.equal(duration(90_000), "1m");
  assert.equal(duration(3 * 3600_000 + 12 * 60_000), "3h 12m");
  assert.equal(duration(50 * 3600_000), "2d 2h");
  assert.equal(duration(undefined), "unknown");
});

test("tables align and say (none) rather than printing an empty frame", () => {
  assert.equal(table([]), "    (none)\n");
  const rendered = table([{ id: 1, why: null }], { indent: "" });
  assert.match(rendered, /^id {2}why\n/);
  assert.match(rendered, /1 {3}NULL\n$/);
});

test("only the first line of a stack trace reaches a findings table", () => {
  assert.equal(firstLine("Error: nope\n    at foo (bar.js:1:1)"), "Error: nope");
  assert.equal(firstLine(null), "NULL");
});

/* -------------------------------------------------------------------------- */
/* the most likely state of the world                                          */
/* -------------------------------------------------------------------------- */

test("a database that is not there exits 2 with an instruction, not a stack trace", async () => {
  const stderr = new Sink();
  const stdout = new Sink();
  // Port 1 is reserved and nothing listens on it, so this refuses immediately.
  const code = await main(["doctor", "--url=postgres://u:secret@127.0.0.1:1/nope"], {
    stdout,
    stderr,
  });
  assert.equal(code, 2);
  assert.equal(stdout.text, "");
  assert.match(stderr.text, /Cannot reach Postgres/);
  assert.match(stderr.text, /docker compose up -d postgres/);
  assert.doesNotMatch(stderr.text, /secret/);
  assert.doesNotMatch(stderr.text, /at Socket/);
});
