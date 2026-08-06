/**
 * lib/promote-eval.ts — turning a production session into an eve eval file.
 *
 * The output of this module is TypeScript that eve loads. Two of its
 * properties are load-bearing in a way a reviewer cannot check by eye, because
 * both fail at eve's load time rather than in the dashboard:
 *
 *  1. The generated source must never carry an `id` or `name` key at
 *     definition level. eve derives an eval's identity from its file path and
 *     THROWS on either key, so a file with one is not a red test — it is a
 *     build that will not load.
 *  2. Denied-tool assertions must be session-scoped. A denied call spans two
 *     turns (the request lands in the parked turn, the rejection resolves in
 *     the resumed one), so a turn-scoped assertion can never match and the
 *     promoted eval is red for a reason that has nothing to do with the agent.
 *
 * Both are recorded in the module as things that were learned by running the
 * output. Neither is visible from the generator's own code.
 *
 * The module imports only a TYPE from lib/agent-client.ts, which type stripping
 * erases, so it loads under plain node with no bundler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { generateEval, recoverTurns, suggestFilename } from "../lib/promote-eval.ts";

const SESSION = "wrun_01JABCDEF9XYZ";

const event = (type, data) => ({ type, data });

const userMessage = (turnId, message) => event("message.received", { turnId, message });

const assistantReply = (turnId, text) =>
  event("message.completed", {
    turnId,
    message: { role: "assistant", parts: [{ type: "text", text }] },
  });

const toolsRequested = (turnId, ...toolNames) =>
  event("actions.requested", { turnId, actions: toolNames.map((toolName) => ({ toolName })) });

const denial = (turnId, toolName) =>
  event("action.result", {
    turnId,
    result: { toolName, output: { approval: { status: "denied" } } },
  });

function generate(events, title = "Deploy to production") {
  return generateEval({ sessionId: SESSION, title, events });
}

/* -------------------------------------------------------------------------- */
/* the two keys eve's loader throws on                                         */
/* -------------------------------------------------------------------------- */

test("the generated source carries no id or name key", () => {
  const { source } = generate([
    userMessage("turn_0", "run the deploy"),
    toolsRequested("turn_0", "shell"),
    assistantReply("turn_0", "Deployed."),
  ]);
  // Definition level is two-space indent, which is what assertNoLegacyKeys
  // looks for and what eve's loader actually reads.
  assert.doesNotMatch(source, /^ {2}id\s*:/m);
  assert.doesNotMatch(source, /^ {2}name\s*:/m);
  // ...and neither may any of eve's rejected legacy keys appear.
  for (const key of ["input", "run", "checks", "scores", "expected", "thresholds", "parseOutput", "model", "requires"]) {
    assert.doesNotMatch(source, new RegExp(`^ {2}${key}\\s*:`, "m"), key);
  }
  // The one key that IS expected there, so this test cannot pass vacuously
  // against an empty file.
  assert.match(source, /^ {2}description:/m);
  assert.match(source, /^ {2}async test\(t\) \{/m);
});

test("a hostile title or message cannot inject a key into the generated file", () => {
  // Everything user-controlled goes through JSON.stringify, so a newline in a
  // title or a message stays inside the string literal. If that ever stopped
  // being true, the first thing an attacker-shaped input would reach for is the
  // `id` key that breaks the loader — or a line of arbitrary TypeScript in a
  // file a human is about to commit.
  const payload = '\n  id: "hijacked",\n  name: "hijacked",\n  console.log("owned")';
  const { source } = generate(
    [userMessage("turn_0", payload), assistantReply("turn_0", payload)],
    payload,
  );
  assert.doesNotMatch(source, /^ {2}id\s*:/m);
  assert.doesNotMatch(source, /^ {2}name\s*:/m);
  assert.doesNotMatch(source, /console\.log\("owned"\)/);
  // The literal newline became an escape sequence rather than a real line break.
  assert.match(source, /\\n {2}id: \\"hijacked/);
});

/* -------------------------------------------------------------------------- */
/* denied tools                                                                */
/* -------------------------------------------------------------------------- */

test("a denied tool is asserted on the session, never on the turn", () => {
  const { source } = generate([
    userMessage("turn_0", "delete the production database"),
    toolsRequested("turn_0", "shell"),
    denial("turn_1", "shell"),
  ]);

  // Session-scoped, with an explicit status: a denied call never reaches
  // "completed", which is what `calledTool` defaults to.
  assert.match(source, /^\s*t\.calledTool\("shell", \{ status: "rejected" \}\);$/m);
  // The turn-scoped form is the bug. It can never match, because neither turn
  // holds both halves of the call.
  assert.doesNotMatch(source, /turn1\.calledTool\("shell"/);

  // The denial is replayed rather than skipped: that path used to end the
  // durable session on the next turn.
  assert.match(source, /turn1\.parked\(\);/);
  assert.match(source, /const turn1Resumed = await t\.respondAll\("deny"\);/);
  assert.match(source, /turn1Resumed\.succeeded\(\);/);
  // A parked turn did not succeed, so the plain success assertion must be gone.
  assert.doesNotMatch(source, /^\s*turn1\.succeeded\(\);$/m);
});

test("a turn that both ran and was denied tools asserts only on the ones that ran", () => {
  const { source } = generate([
    userMessage("turn_0", "check and then deploy"),
    toolsRequested("turn_0", "read_file", "shell"),
    denial("turn_1", "shell"),
  ]);
  assert.match(source, /turn1\.calledTool\("read_file"\);/);
  assert.doesNotMatch(source, /turn1\.calledTool\("shell"\)/);
  assert.match(source, /t\.calledTool\("shell", \{ status: "rejected" \}\);/);
});

test("a denial reported as an error code is recognised as a denial", () => {
  // Both shapes exist in the stream: the approval verdict on the output, and
  // TOOL_EXECUTION_DENIED on the error.
  const { source } = generate([
    userMessage("turn_0", "rm -rf /"),
    toolsRequested("turn_0", "shell"),
    event("action.result", {
      turnId: "turn_1",
      result: { toolName: "shell" },
      error: { code: "TOOL_EXECUTION_DENIED" },
    }),
  ]);
  assert.match(source, /t\.calledTool\("shell", \{ status: "rejected" \}\);/);
});

test("a successful tool result is not mistaken for a denial", () => {
  const { source } = generate([
    userMessage("turn_0", "read the file"),
    toolsRequested("turn_0", "read_file"),
    event("action.result", {
      turnId: "turn_0",
      result: { toolName: "read_file", output: { text: "contents" } },
    }),
  ]);
  assert.match(source, /turn1\.calledTool\("read_file"\);/);
  assert.match(source, /turn1\.succeeded\(\);/);
  assert.doesNotMatch(source, /rejected/);
  assert.doesNotMatch(source, /respondAll/);
});

/* -------------------------------------------------------------------------- */
/* turn recovery                                                               */
/* -------------------------------------------------------------------------- */

test("a denial arriving on a turn of its own attaches to the turn that asked", () => {
  // Answering an approval starts a NEW turn: the user message opens turn_0 and
  // the action.result carrying the denial arrives on turn_1, which has no
  // message.received of its own. Keying strictly on turnId drops every denial
  // on the floor — the generated eval then silently loses the one assertion
  // worth having.
  const turns = recoverTurns([
    userMessage("turn_0", "delete everything"),
    toolsRequested("turn_0", "shell"),
    denial("turn_1", "shell"),
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].deniedTools, ["shell"]);
});

test("turns are attributed by id, not by arrival order", () => {
  // Events from two turns interleave whenever one of them parked.
  const turns = recoverTurns([
    userMessage("turn_0", "first"),
    userMessage("turn_1", "second"),
    toolsRequested("turn_0", "read_file"),
    assistantReply("turn_1", "done with the second"),
    assistantReply("turn_0", "done with the first"),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].userMessage, "first");
  assert.deepEqual(turns[0].toolNames, ["read_file"]);
  assert.equal(turns[0].assistantReply, "done with the first");
  assert.equal(turns[1].userMessage, "second");
  assert.deepEqual(turns[1].toolNames, []);
});

test("a user message with no plain text falls back to its structured parts", () => {
  const turns = recoverTurns([
    event("message.received", {
      turnId: "turn_0",
      parts: [{ text: "hello " }, { text: "world" }, { image: "ignored" }],
    }),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].userMessage, "hello world");
});

test("an empty user message opens no turn", () => {
  // Otherwise the generated eval starts with `await t.send("")`, which is not a
  // test of anything.
  assert.deepEqual(recoverTurns([event("message.received", { turnId: "turn_0", message: "" })]), []);
  assert.deepEqual(recoverTurns([event("message.received", { turnId: "turn_0", parts: [] })]), []);
  assert.deepEqual(recoverTurns([]), []);
});

test("the user's own echoed message is not recorded as the assistant's reply", () => {
  const turns = recoverTurns([
    userMessage("turn_0", "hello"),
    event("message.completed", {
      turnId: "turn_0",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    }),
  ]);
  assert.equal(turns[0].assistantReply, null);
});

test("non-text parts of a reply are skipped rather than concatenated as blanks", () => {
  const turns = recoverTurns([
    userMessage("turn_0", "hello"),
    event("message.completed", {
      turnId: "turn_0",
      message: {
        role: "assistant",
        parts: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "hi" }],
      },
    }),
  ]);
  assert.equal(turns[0].assistantReply, "hi");
});

test("events for a turn that never opened are dropped, not crashed on", () => {
  // A replay window can start mid-session.
  assert.deepEqual(recoverTurns([toolsRequested("turn_9", "shell"), denial("turn_9", "shell")]), []);
  assert.deepEqual(recoverTurns([event("turn.failed", { turnId: "turn_9" })]), []);
  assert.deepEqual(recoverTurns([event("something.unknown", {})]), []);
  assert.deepEqual(recoverTurns([{ type: "message.received", data: null }]), []);
});

test("a duplicate tool name is recorded once", () => {
  const turns = recoverTurns([
    userMessage("turn_0", "go"),
    toolsRequested("turn_0", "shell", "shell"),
    toolsRequested("turn_0", "shell"),
  ]);
  assert.deepEqual(turns[0].toolNames, ["shell"]);
});

/* -------------------------------------------------------------------------- */
/* warnings and the shape of the file                                          */
/* -------------------------------------------------------------------------- */

test("a failed turn still asserts success, and says so out loud", () => {
  const { source, warnings } = generate([
    userMessage("turn_0", "do the thing"),
    event("turn.failed", { turnId: "turn_0" }),
  ]);
  // Red until the bug is fixed is exactly what a regression test is for.
  assert.match(source, /turn1\.succeeded\(\);/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed turn/);
});

test("a session with no recoverable messages produces a warning, not an empty test body", () => {
  const { source, warnings } = generate([]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No user messages were recovered/);
  assert.match(source, /No user messages recovered/);
  // Still a loadable file rather than a syntax error.
  assert.match(source, /export default defineEval\(\{/);
});

test("the observed reply is a commented suggestion, never a live assertion", () => {
  // We can see what the agent said; we cannot see what it should have said. An
  // active messageIncludes on an observed string is a test that asserts the
  // present, which passes forever and catches nothing.
  const reply = "I deployed version 4.2.0 to production and the health check came back green";
  const { source } = generate([userMessage("turn_0", "deploy"), assistantReply("turn_0", reply)]);
  assert.doesNotMatch(source, /^\s*turn1\.messageIncludes/m);
  assert.match(source, /^\s*\/\/ turn1\.messageIncludes\("/m);
  // Truncated to an excerpt: the full reply of a chatty turn would be a
  // hundred-column comment nobody edits.
  assert.doesNotMatch(source, /health check came back green/);
});

test("only defineEval is imported", () => {
  // An `includes` import for a commented-out line is an unused import in every
  // generated file, which is a lint error in the project it lands in.
  const { source } = generate([userMessage("turn_0", "hi"), assistantReply("turn_0", "hello")]);
  const imports = source.split("\n").filter((line) => line.startsWith("import "));
  assert.deepEqual(imports, ['import { defineEval } from "eve/evals";']);
});

test("the session id and a usable description reach the file", () => {
  const { source } = generate([userMessage("turn_0", "hi")], "Deploy to production");
  assert.match(source, new RegExp(`session ${SESSION}`));
  assert.match(source, /description: "Deploy to production"/);

  // With no title the description has to say what to do about it, since a file
  // full of "undefined" is worse than one that asks.
  const untitled = generateEval({ sessionId: SESSION, title: null, events: [] });
  assert.match(untitled.source, /describe the behaviour under test/);
  const blank = generateEval({ sessionId: SESSION, title: "   ", events: [] });
  assert.match(blank.source, /describe the behaviour under test/);
});

test("each turn gets its own handle, numbered from one", () => {
  const { source } = generate([
    userMessage("turn_0", "first"),
    userMessage("turn_1", "second"),
    userMessage("turn_2", "third"),
  ]);
  assert.match(source, /const turn1 = await t\.send\("first"\);/);
  assert.match(source, /const turn2 = await t\.send\("second"\);/);
  assert.match(source, /const turn3 = await t\.send\("third"\);/);
});

/* -------------------------------------------------------------------------- */
/* the filename, which is the eval's identity                                  */
/* -------------------------------------------------------------------------- */

test("the filename is a stable, readable slug plus a disambiguating suffix", () => {
  // The path IS the identity, so two sessions with the same title must not
  // collide — hence the last six characters of the session id.
  assert.equal(
    suggestFilename("wrun_01JABCDEF9XYZ", "Deploy to production"),
    "deploy-to-production-ef9xyz.eval.ts",
  );
  assert.notEqual(
    suggestFilename("wrun_aaaaaa", "Same title"),
    suggestFilename("wrun_bbbbbb", "Same title"),
  );
});

test("a title that slugifies to nothing still produces a usable filename", () => {
  for (const title of [null, "", "   ", "!!!", "———", "***"]) {
    const name = suggestFilename("wrun_abcdef", title);
    assert.equal(name, "session-abcdef.eval.ts", JSON.stringify(title));
  }
});

test("the slug is bounded, lower-cased and free of path characters", () => {
  const name = suggestFilename("wrun_abcdef", "A/B TEST: ../../etc/passwd & friends".repeat(5));
  assert.doesNotMatch(name, /[^a-z0-9.-]/);
  assert.doesNotMatch(name, /\.\./);
  assert.ok(name.endsWith(".eval.ts"));
  // 48-character slug + "-" + 6-character suffix + ".eval.ts".
  assert.equal(name.length, 48 + 1 + 6 + ".eval.ts".length);
});

test("a session id shorter than the suffix does not produce a stray separator", () => {
  assert.equal(suggestFilename("wrun_ab", "T"), "t-ab.eval.ts");
});
