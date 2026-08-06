/**
 * The command surface and the connection safety rails.
 *
 * The last test in this file is the only one that opens a socket: it points the
 * real CLI at a port nothing is listening on, which is the state of the world in
 * the most common reason to reach for a doctor command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, main, USAGE } from "../src/cli.mjs";
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

test("no arguments prints usage and exits 2", async () => {
  const stdout = new Sink();
  assert.equal(await main([], { stdout, stderr: new Sink() }), 2);
  assert.equal(stdout.text, USAGE);
});

test("--help exits 0", async () => {
  const stdout = new Sink();
  assert.equal(await main(["--help"], { stdout, stderr: new Sink() }), 0);
});

test("an unknown command does not fall through to doctor", async () => {
  const stderr = new Sink();
  assert.equal(await main(["fix"], { stdout: new Sink(), stderr }), 2);
  assert.match(stderr.text, /Only `doctor` exists/);
});

test("the usage text does not advertise a --fix that deliberately does not exist", () => {
  assert.doesNotMatch(USAGE, /--fix/);
  assert.match(USAGE, /never writes to your database/);
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
