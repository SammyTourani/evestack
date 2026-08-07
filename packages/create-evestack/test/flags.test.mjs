/**
 * An unrecognised flag must not become the project name, and --help must not do
 * anything.
 *
 * The whole parser was `argv.filter((a) => !a.startsWith("-"))`. It dropped a flag
 * it did not know and KEPT the value behind it, so the value became the directory:
 * verified before the fix, `npx create-evestack --port 5000` created a directory
 * called `5000`, `--template minimal` created `minimal`, and `my-agent --dry-run`
 * — a flag that exists on `attach`, advertised two lines away in the shared usage
 * — scaffolded for real and then offered to start containers. `-my-agent` was
 * discarded entirely and the wizard asked for a name it had just been given.
 *
 * The same filter is why `--help` had to be handled before routing rather than
 * after: `npx create-evestack attach --help` performed real detection and then
 * asked "Write these changes? (Y/n)" with the default at yes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CREATE_USAGE, packageNameFor, parseCreateArgs } from "../create.mjs";
import { ATTACH_USAGE, parseAttachArgs } from "../attach.mjs";
import { hasFlag, HELP_FLAGS, nodeVersionProblem, shellQuote, VERSION_FLAGS } from "../shared.mjs";

test("an unknown flag is an error, and its value is not a directory name", () => {
  for (const argv of [["--port", "5000"], ["--template", "minimal"], ["--registry=x"]]) {
    const parsed = parseCreateArgs(argv);
    assert.ok(parsed.error, `${argv.join(" ")} was accepted`);
    assert.deepEqual(parsed.positional, [], `${argv.join(" ")} kept a positional`);
    assert.match(parsed.error, /Unknown option/);
  }
});

test("a flag that belongs to another command says so", () => {
  // --dry-run is real on attach and is printed two lines from create's own usage,
  // so "unknown option" alone would read like a bug in the tool.
  const parsed = parseCreateArgs(["my-agent", "--dry-run"]);
  assert.match(parsed.error, /--dry-run is a flag on `attach`/);
  assert.match(CREATE_USAGE, /--yes/);
});

test("a name that starts with a dash is refused, with the way to type it", () => {
  const parsed = parseCreateArgs(["-my-agent"]);
  assert.ok(parsed.error);
  assert.match(parsed.error, /npx create-evestack -- -my-agent/);
});

test("`--` ends the options, so a directory really called --help is reachable", () => {
  const parsed = parseCreateArgs(["--", "--help"]);
  assert.equal(parsed.error, null);
  assert.equal(parsed.help, false, "--help after -- is a name, not a question");
  assert.deepEqual(parsed.positional, ["--help"]);
  // and hasFlag, which the bin uses before routing, agrees
  assert.equal(hasFlag(["--", "--help"], HELP_FLAGS), false);
  assert.equal(hasFlag(["attach", "--help"], HELP_FLAGS), true);
  assert.equal(hasFlag(["-V"], VERSION_FLAGS), true);
});

test("the flags create does have are all accepted", () => {
  assert.deepEqual(parseCreateArgs(["my-agent", "--yes"]), {
    positional: ["my-agent"], yes: true, help: false, version: false, error: null,
  });
  assert.equal(parseCreateArgs(["-y"]).yes, true);
  assert.equal(parseCreateArgs(["--help"]).help, true);
  assert.equal(parseCreateArgs(["-h"]).help, true);
  assert.equal(parseCreateArgs(["--version"]).version, true);
  assert.equal(parseCreateArgs(["-V"]).version, true);
});

test("two names are refused rather than one being ignored", () => {
  // `create my agent` is an unquoted "My Agent", and silently scaffolding into
  // `my` is worse than saying so.
  const parsed = parseCreateArgs(["my", "agent"]);
  assert.match(parsed.error, /takes one directory name/);
});

test("attach refuses unknown flags too, for the same reason", () => {
  // Identical failure shape: `attach --port 5000` would have attached to a
  // directory called 5000, i.e. refused with "No such directory" naming a path
  // the user never typed.
  const parsed = parseAttachArgs(["--port", "5000"]);
  assert.ok(parsed.error);
  assert.deepEqual(parsed.positional, []);
  assert.deepEqual(parseAttachArgs([".", "--yes", "--dry-run"]), {
    positional: ["."], yes: true, dryRun: true, help: false, version: false, error: null,
  });
  assert.equal(parseAttachArgs(["-n"]).dryRun, true);
  assert.equal(parseAttachArgs(["--help"]).help, true);
  assert.match(ATTACH_USAGE, /--dry-run/);
});

test("an old Node is a sentence, not a failure five commands later", () => {
  // Nothing checked this: `engines` is advice npm only warns about, so a Node 20
  // user reached the generated project and failed on --env-file-if-exists, and a
  // Node 22.0 user failed inside URL.parse.
  assert.ok(nodeVersionProblem("20.11.0"));
  assert.ok(nodeVersionProblem("22.14.0"));
  assert.match(nodeVersionProblem("20.11.0"), /Node 24 or newer/);
  assert.equal(nodeVersionProblem("24.0.0"), null);
  assert.equal(nodeVersionProblem("26.0.0"), null);
  assert.equal(nodeVersionProblem(process.versions.node), null, "the runtime running the tests");
});

test("printed commands survive a name with a space", () => {
  // The wizards print `cd <dir>` for a human to paste, and `cd My Agent` is two
  // arguments and a broken instruction.
  assert.equal(shellQuote("My Agent"), "'My Agent'");
  assert.equal(shellQuote("my-agent"), "my-agent");
  assert.equal(shellQuote("/tmp/a b/c"), "'/tmp/a b/c'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(""), "''");
});

test("the manifest name is a legal npm name, whatever the directory is called", () => {
  // `pkg.name = basename(target)` wrote `"name": "My Agent"` and npm refused the
  // install it went on to run — from a manifest the user never typed.
  assert.equal(packageNameFor("/tmp/My Agent"), "my-agent");
  assert.equal(packageNameFor("/tmp/my-agent"), "my-agent");
  assert.equal(packageNameFor("/tmp/.hidden"), "hidden", "npm names cannot start with a dot");
  assert.equal(packageNameFor("/tmp/_leading"), "leading", "nor with an underscore");
  assert.equal(packageNameFor("/tmp/!!!"), "agent", "something unusable still has to be a name");
  for (const path of ["/tmp/My Agent", "/tmp/.hidden", "/tmp/agent (v2)", "/tmp/ÜBER"]) {
    // npm's rule, as npm states it: lowercase, no spaces, url-safe.
    assert.match(packageNameFor(path), /^[a-z0-9][a-z0-9._-]*$/, path);
  }
});
