/**
 * `evestack skills` — routing, argument parsing, target choice, and the two
 * refusals.
 *
 * The pack itself is fetched, so the interesting failures here are all local:
 * a flag swallowed by doctor's parser, a default target that writes to the
 * wrong place, an overwrite that destroys a skill someone edited, and a served
 * path that escapes the directory it was asked to write into. None of those
 * need a network, and the ones that would are stubbed with a local server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectCommand, scaffoldCommand, COMMANDS, USAGE, unknownCommand } from "../src/cli.mjs";
import { defaultTarget, parseSkillsArgs, SKILLS_USAGE, skills } from "../src/skills.mjs";

function tmp(prefix = "evestack-skills-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A stand-in for /agent-pack.json, so the tests never touch the network. */
async function servePack(files) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "evestack", files }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/agent-pack.json`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join("") };
}

test("skills is routed before doctor's parser sees its flags", () => {
  // Same bug class as verify/open: parseArgs is doctor's and rejects unknown
  // flags, so `evestack skills --print` would exit 2 on "Unknown option".
  assert.equal(projectCommand(["skills"]), "skills");
  assert.equal(projectCommand(["skills", "--print"]), "skills");
  assert.equal(projectCommand(["skills", "--dir=x"]), "skills");
  assert.equal(scaffoldCommand(["skills"]), null);
});

test("skills is a known command, and a near miss suggests it", () => {
  assert.ok(COMMANDS.includes("skills"));
  assert.match(USAGE, /evestack skills/);
  assert.match(unknownCommand("skils"), /Did you mean `evestack skills`\?/);
});

test("--dir without a value is refused, never guessed", () => {
  // `--dir /some/path` would otherwise become `--dir` plus a stray positional
  // and quietly install to the default location instead of the one asked for.
  assert.throws(() => parseSkillsArgs(["--dir"]), /--dir needs a value/);
  assert.throws(() => parseSkillsArgs(["--nope"]), /Unknown option/);
  assert.deepEqual(parseSkillsArgs(["--dir=x", "--force"]), {
    print: false,
    force: true,
    json: false,
    help: false,
    dir: "x",
  });
});

test("the default target is agent/skills only inside an eve project", () => {
  const bare = tmp();
  assert.match(defaultTarget(bare).dir, /\.claude\/skills\/evestack$/);

  const project = tmp();
  mkdirSync(join(project, "agent", "skills"), { recursive: true });
  const target = defaultTarget(project);
  assert.match(target.dir, /agent\/skills\/evestack$/);
  // In a scaffolded project that directory is a real runtime location — eve
  // scans it — so landing there makes the pack loadable, not merely readable.
  assert.equal(target.reason, "eve project");
});

test("--help prints usage and writes nothing", async () => {
  const stdout = sink();
  const dir = tmp();
  const code = await skills(["--help"], { stdout, stderr: sink() });
  assert.equal(code, 0);
  assert.equal(stdout.text(), SKILLS_USAGE);
  assert.equal(existsSync(join(dir, "SKILL.md")), false);
});

test("a real install writes the tree, and refuses to overwrite it afterwards", async () => {
  const pack = await servePack([
    { path: "SKILL.md", content: "---\ndescription: x\n---\n\nbody\n" },
    { path: "references/cli.md", content: "# cli\n" },
  ]);
  process.env.EVESTACK_PACK_URL = pack.url;
  try {
    const dir = join(tmp(), "evestack");

    const first = await skills([`--dir=${dir}`], { stdout: sink(), stderr: sink() });
    assert.equal(first, 0);
    assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /description: x/);
    assert.equal(readFileSync(join(dir, "references", "cli.md"), "utf8"), "# cli\n");

    // Second run must not clobber: someone may have edited the skill.
    const stderr = sink();
    const second = await skills([`--dir=${dir}`], { stdout: sink(), stderr });
    assert.equal(second, 1);
    assert.match(stderr.text(), /already has 2 of these files/);
    assert.match(stderr.text(), /--force/);

    // …and --force is the way through.
    assert.equal(await skills([`--dir=${dir}`, "--force"], { stdout: sink(), stderr: sink() }), 0);
  } finally {
    delete process.env.EVESTACK_PACK_URL;
    await pack.close();
  }
});

test("a served path cannot escape the target directory", async () => {
  const pack = await servePack([{ path: "../../escaped.md", content: "no" }]);
  process.env.EVESTACK_PACK_URL = pack.url;
  try {
    const root = tmp();
    const dir = join(root, "nested", "evestack");
    const stderr = sink();
    const code = await skills([`--dir=${dir}`], { stdout: sink(), stderr });
    assert.equal(code, 1);
    assert.match(stderr.text(), /outside the target directory/);
    assert.equal(existsSync(join(root, "escaped.md")), false);
  } finally {
    delete process.env.EVESTACK_PACK_URL;
    await pack.close();
  }
});

test("an unreachable pack fails with the URL in the message, not a stack trace", async () => {
  // Port 1 on loopback refuses immediately — no timeout, no flake.
  process.env.EVESTACK_PACK_URL = "http://127.0.0.1:1/agent-pack.json";
  try {
    const stderr = sink();
    const code = await skills([`--dir=${join(tmp(), "x")}`], { stdout: sink(), stderr });
    assert.equal(code, 1);
    assert.match(stderr.text(), /Could not reach http:\/\/127\.0\.0\.1:1/);
    assert.match(stderr.text(), /agent\.md/);
  } finally {
    delete process.env.EVESTACK_PACK_URL;
  }
});

test("--print writes every file to stdout and touches nothing", async () => {
  const pack = await servePack([
    { path: "SKILL.md", content: "body\n" },
    { path: "references/cli.md", content: "# cli\n" },
  ]);
  process.env.EVESTACK_PACK_URL = pack.url;
  try {
    const dir = join(tmp(), "evestack");
    const stdout = sink();
    const code = await skills(["--print", `--dir=${dir}`], { stdout, stderr: sink() });
    assert.equal(code, 0);
    // The destination matters as much as the content, so each file is named.
    assert.match(stdout.text(), /===== SKILL\.md =====/);
    assert.match(stdout.text(), /===== references\/cli\.md =====/);
    assert.equal(existsSync(dir), false);
  } finally {
    delete process.env.EVESTACK_PACK_URL;
    await pack.close();
  }
});

/**
 * The success banner is the whole report, and all of it has to reach the stream
 * the caller supplied.
 *
 * THE DEFECT THIS PINS: `skills()` accepts `{ stdout }` and honoured it on the
 * --help, --print and --json paths, but built the install banner with
 * create-evestack/ui's PRINTING forms — `heading()`, `row()`, `fix()`,
 * `blank()` — and those write to the real `process.stdout` (ui.mjs:256-257).
 * Only the two `c.dim` lines went through the parameter. So a test holding a
 * sink saw two lines out of nine: no "Skill installed", no per-file rows, no
 * `npx evestack create`. The rest went past it to the terminal, in a separate
 * write sequence, which also means the two halves were not ordered relative to
 * each other. ui.mjs:259-269 names this hazard; status.mjs:442-446 is the fix.
 *
 * Asserted on the sink alone, with no `process.stdout` interceptor: the point
 * is that the sink is now sufficient. Against the old code the first assertion
 * below fails on an empty-ish string — measured, not assumed, by reverting the
 * banner and re-running this test.
 */
test("the whole install banner reaches the stream the caller supplied", async () => {
  const pack = await servePack([
    { path: "SKILL.md", content: "body\n" },
    { path: "references/cli.md", content: "# cli\n" },
  ]);
  process.env.EVESTACK_PACK_URL = pack.url;
  try {
    const dir = join(tmp(), "evestack");
    const stdout = sink();
    assert.equal(await skills([`--dir=${dir}`], { stdout, stderr: sink() }), 0);
    const text = stdout.text();

    // Every part of the banner, not just the two lines that used to make it.
    assert.match(text, /Skill installed/, "the heading went somewhere else");
    assert.match(text, /your agent now knows evestack/, "and so did its subtitle");
    assert.match(text, /SKILL\.md/, "the per-file rows went somewhere else");
    assert.match(text, /references\/cli\.md/);
    assert.ok(text.includes(dir), "the reader is never told where it was written");
    assert.match(text, /npx evestack create/, "the one line meant to be typed went somewhere else");

    // Ordering, which two interleaved write sequences cannot promise. A reader
    // gets the heading, then what was written, then where, then what to type.
    const at = (needle) => text.indexOf(needle);
    assert.ok(
      at("Skill installed") < at("SKILL.md") &&
        at("SKILL.md") < at(dir) &&
        at(dir) < at("npx evestack create"),
      `the banner arrived out of order:\n${text}`,
    );

    // A sink is not a TTY, so nothing in it should be coloured — this is the
    // `forStream` contract from ui.mjs:216-233, and the reason a captured
    // report can be compared and matched rather than only looked at.
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(text, /\x1b\[/, "escape sequences leaked into a non-TTY stream");
  } finally {
    delete process.env.EVESTACK_PACK_URL;
    await pack.close();
  }
});
