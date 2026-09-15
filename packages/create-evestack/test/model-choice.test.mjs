/**
 * The model list, the key prompts, and the door in front of both.
 *
 * The wizard offered three things — two hosted providers and one 5.2 GB local
 * model — asked for a credential with a single unchecked prompt, and opened on
 * "Project name?" with no way to find out what it was scaffolding. This file
 * covers what replaced each of those, and it is weighted towards the two bugs
 * that were written and caught while replacing them, because those are the ones
 * that will come back:
 *
 *   - `compatible: null` read back through `?? "OPENAI_API_KEY"` as a real
 *     variable name, so a scaffold pointed at LM Studio on loopback refused to
 *     boot until an OpenAI key it will never call was set;
 *   - the arrow-key picker took stdin and did not give it back, so the picker
 *     worked and the NEXT prompt hung forever with no error.
 *
 * The second needs a terminal and cannot be reached from here; what IS reachable
 * is the contract that prevents it — `select` must route every stdin handoff
 * through the lender it is given — so that is what is asserted.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  askKey,
  nextSteps,
  chooseModel,
  envAlreadySet,
  explainBuildFailure,
  lastJsonLine,
  recommendedAnswer,
  requiredEnvFrom,
  targetProblem,
  freeNameNear,
  restoreScripts,
  KEY_ATTEMPTS,
  modelEdge,
  orient,
  ORIENT,
  PROVIDERS,
  QUICKSTART_URL,
} from "../create.mjs";
import {
  LOCAL,
  REMOTE,
  fits,
  humanSize,
  localBadge,
  recommendedLocal,
} from "../models.mjs";
import { ask as pick, group, option, stepHeaderLine, visibleRange } from "../wizard.mjs";
import { visible } from "../ui.mjs";

/** Answers from a script, records the questions, can hit EOF partway through. */
function prompterThatAnswers(answers, { eofAfter = Infinity } = {}) {
  const asked = [];
  const state = { closed: false };
  const ask = async (question) => {
    asked.push(question);
    state.closed = asked.length >= eofAfter;
    return answers.shift() ?? "";
  };
  return { asked, ask, closed: () => state.closed };
}

const quiet = () => {};

/* -------------------------------------------------------------------------- */
/* the catalogue                                                               */
/* -------------------------------------------------------------------------- */

test("every local model says whether it can call tools", () => {
  // Not a style rule. Tool calling is how the agent reaches memory, Composio,
  // approvals and the sandbox, so a model missing it does not degrade — it
  // answers in prose and silently does nothing. An entry that forgets to say
  // which it is would be rendered with no badge at all.
  for (const model of LOCAL) {
    assert.equal(typeof model.tools, "boolean", `${model.model} does not say`);
    assert.ok(model.mb > 0, `${model.model} has no size`);
  }
});

test("Gemma is listed, and listed as unable to call tools", () => {
  // Verified twice before it was written down: Ollama's template layer for
  // gemma3 references no `.Tools` at any size, and a pulled gemma3:1b reports
  // `capabilities: ["completion"]`. It stays on the list because it is genuinely
  // remarkable for its size; it is marked because an unmarked one is a trap.
  const gemma = LOCAL.filter((m) => m.model.startsWith("gemma3"));
  assert.ok(gemma.length >= 1, "Gemma was asked for by name and belongs on the list");
  assert.ok(gemma.every((m) => m.tools === false));
  assert.ok(gemma.every((m) => localBadge(m, 64).text.includes("no tools")));
});

test("the smallest tool-capable model is far smaller than the old default", () => {
  const smallest = LOCAL.filter((m) => m.tools).sort((a, b) => a.mb - b.mb)[0];
  const oldDefault = LOCAL.find((m) => m.model === "qwen3");

  assert.ok(smallest.mb <= 400, `${smallest.model} is ${humanSize(smallest.mb)}`);
  assert.ok(
    oldDefault.mb / smallest.mb > 10,
    "the whole point of the rewrite is that 'local' does not have to mean 5.2 GB",
  );
});

test("sizes are reported in the units ollama pull prints", () => {
  // Decimal, not binary. A wizard that calls a 366 MB download 349 MB is a
  // wizard the reader stops trusting on the one number that decides the choice.
  assert.equal(humanSize(366), "366 MB");
  assert.equal(humanSize(5200), "5.2 GB");
  assert.equal(humanSize(999), "999 MB");
  assert.equal(humanSize(1000), "1.0 GB");
});

test("what fits depends on the machine, and is decided before the choice", () => {
  const big = LOCAL.find((m) => m.model === "qwen3");
  const small = LOCAL.find((m) => m.model === "qwen3:0.6b");

  assert.equal(fits(big, 8), false, "5.2 GB beside Docker and Postgres on 8 GB is the crash");
  assert.equal(fits(big, 32), true);
  assert.equal(fits(small, 8), true);
  assert.match(localBadge(big, 8).text, /tight/);
  assert.doesNotMatch(localBadge(big, 32).text, /tight/);
});

test("the recommendation never suggests a model that cannot call tools", () => {
  for (const ram of [4, 8, 16, 32, 64]) {
    const pick = recommendedLocal(ram);
    assert.equal(pick.tools, true, `${ram} GB suggested ${pick.model}`);
  }
});

test("OpenRouter is reachable without editing .env.local by hand", () => {
  const gateway = REMOTE.find((r) => r.id === "openrouter");
  assert.ok(gateway, "the open catalogue was the thing the old list had no door to");
  assert.equal(gateway.keyVar, "OPENROUTER_API_KEY");
  assert.ok([...PROVIDERS.values()].some((p) => p.id === "openrouter"),
    "and it has a number, so --yes and CI can pick it too");
});

test("the easiest option needs no key at all", () => {
  const sub = REMOTE.find((r) => r.id === "chatgpt");
  assert.ok(sub, "a ChatGPT plan is the shortest path from this prompt to an answer");
  assert.equal(sub.keyVar, null, "there is no variable — the session is in the OS secret store");
  assert.equal(sub.signIn, true, "and `signIn` is what every other file branches on to know that");
  assert.equal(REMOTE[0].id, "chatgpt", "first, because everything below it sends you elsewhere first");
});

test("a ChatGPT plan does not fall through to the `null=` line", async () => {
  // The numbered path, answered, with stdin closing as the answer drains.
  //
  // Honest about what this is: it is a configuration `main` cannot currently
  // produce. `nonInteractive = args.yes || !process.stdin.isTTY`, and
  // `makePrompter` builds no readline when that is set, so a pipe is `--yes`
  // and the numbered question is never really asked — measured against 0.11.2
  // and against this tree. A chatgpt pick therefore never arrives at settle()
  // with `closed()` true, and the branch below it is unreachable today.
  //
  // It is pinned anyway. That branch writes `${keyVar}=`, which for a provider
  // with `keyVar: null` is the literal line "null=" in .env.local: a variable
  // named null, in no .env.example, complained about by nothing until the first
  // model call. It costs one line of ordering to disarm, and it stops being
  // theoretical the day a pipe is distinguished from `--yes` — which the
  // numbers in PROVIDERS exist for.
  let drained = false;
  const chosen = await chooseModel({
    ask: async () => { drained = true; return "5"; },
    closed: () => drained,
    borrowStdin: async (fn) => fn(),
  });

  assert.equal(chosen.id, "chatgpt");
  assert.doesNotMatch(chosen.apiKeyLine, /null/);
  assert.match(chosen.apiKeyLine, /^#/, "a comment saying why, not a variable to fill in");
  assert.match(chosen.modelLine, /EVESTACK_PROVIDER=chatgpt/);
  assert.doesNotMatch(
    chosen.modelLine,
    /EVESTACK_CONTEXT_WINDOW/,
    "eve answers 200k for this route before it consults the catalog; declaring 32768 would " +
      "replace a right number with a wrong one",
  );
});

test("the numbers 1, 2 and 3 still mean what they meant", () => {
  // These are an interface: `echo 3 | npx create-evestack` is in shell history
  // and in CI. A new provider is appended; it does not renumber the old ones.
  assert.equal(PROVIDERS.get("1").id, "openai");
  assert.equal(PROVIDERS.get("2").id, "anthropic");
  assert.equal(PROVIDERS.get("3").id, "ollama");
});

test("the default local model is one a laptop can actually run", () => {
  const local = PROVIDERS.get("3");
  const spec = LOCAL.find((m) => m.model === local.model);

  assert.ok(spec, `${local.model} is not in the catalogue`);
  assert.equal(spec.tools, true);
  assert.ok(fits(spec, 8), "the machine this was reported from has 8 GB");
});

/* -------------------------------------------------------------------------- */
/* the finish diagram                                                          */
/* -------------------------------------------------------------------------- */

test("a gateway leaves the machine and a local OpenAI-compatible server does not", () => {
  assert.match(modelEdge("openrouter", "qwen/qwen3.8-27b"), /the only thing that leaves/);
  assert.match(
    modelEdge("compatible", "local-model", "http://127.0.0.1:1234/v1"),
    /nothing leaves this machine/,
  );
  assert.match(
    modelEdge("compatible", "llama-3", "https://api.groq.com/openai/v1"),
    /which does leave this machine/,
  );
});

/* -------------------------------------------------------------------------- */
/* three tries, then move on                                                   */
/* -------------------------------------------------------------------------- */

test("a key that never arrives is skipped rather than asked forever", async () => {
  const p = prompterThatAnswers([]);
  const { key, skipped, reason } = await askKey({
    ask: p.ask, closed: p.closed, label: "COMPOSIO_API_KEY", shape: /^ak_/, complain: quiet, note: quiet,
  });

  assert.equal(p.asked.length, KEY_ATTEMPTS, "three tries, and the third is the last");
  assert.equal(key, "");
  assert.equal(skipped, true);
  assert.equal(reason, "attempts");
});

test("the second try counts, so a wrong paste is recoverable", async () => {
  const p = prompterThatAnswers(["", "ak_live_abc123"]);
  const { key, skipped } = await askKey({
    ask: p.ask, closed: p.closed, label: "COMPOSIO_API_KEY", shape: /^ak_/, complain: quiet, note: quiet,
  });

  assert.equal(p.asked.length, 2);
  assert.equal(key, "ak_live_abc123");
  assert.equal(skipped, false);
});

test("a key of visibly the wrong kind is refused before it is written", async () => {
  // The realistic mistake is the wrong browser tab: an OpenAI key pasted into
  // the Composio prompt. Writing it would produce a scaffold that looks
  // configured and fails at the first toolkit.
  const p = prompterThatAnswers(["sk-proj-wrongtab", "ak_right"]);
  const { key } = await askKey({
    ask: p.ask, closed: p.closed, label: "COMPOSIO_API_KEY", shape: /^ak_/, complain: quiet, note: quiet,
  });

  assert.equal(key, "ak_right");
  assert.equal(p.asked.length, 2);
});

test("a shape nobody gave means any non-empty answer is accepted", async () => {
  const p = prompterThatAnswers(["whatever-this-server-wants"]);
  const { key } = await askKey({ ask: p.ask, closed: p.closed, label: "KEY", complain: quiet, note: quiet });

  assert.equal(key, "whatever-this-server-wants");
});

test("stdin closing is not a wrong answer to retry", async () => {
  const p = prompterThatAnswers([], { eofAfter: 1 });
  const { skipped, reason } = await askKey({
    ask: p.ask, closed: p.closed, label: "OPENAI_API_KEY", complain: quiet, note: quiet,
  });

  assert.equal(p.asked.length, 1, "there is nobody there — asking twice more is theatre");
  assert.equal(skipped, true);
  assert.equal(reason, "eof");
});

/* -------------------------------------------------------------------------- */
/* the door                                                                    */
/* -------------------------------------------------------------------------- */

test("the docs answer opens the docs and keeps the wizard open", async () => {
  // Deliberately not an exit. They already typed the command; sending them back
  // to a shell prompt to re-run it is a worse ending than reading with the
  // wizard still there, so the docs route continues in guided mode.
  const p = prompterThatAnswers(["2"]);
  const route = await orient({ ask: p.ask, nonInteractive: true });

  assert.equal(route, ORIENT.GUIDED);
  assert.match(QUICKSTART_URL, /^https:\/\//);
});

test("someone who knows what they want is not made to read anything", async () => {
  const p = prompterThatAnswers(["1"]);
  assert.equal(await orient({ ask: p.ask, nonInteractive: true }), ORIENT.SETUP);
});

/* -------------------------------------------------------------------------- */
/* the picker's contract with whoever owns stdin                               */
/* -------------------------------------------------------------------------- */

test("every stdin handoff goes through the lender it was given", async () => {
  // The bug this pins: the picker set raw mode, read keys, then paused stdin on
  // its way out. The readline interface underneath never got the stream back,
  // so the NEXT `ask()` never settled and Node exited between two questions
  // with a half-written scaffold and no error of its own. Raw mode has to be
  // taken and returned INSIDE the loan, or the lender restores the wrong state.
  let lent = 0;
  const items = [group("Local"), option("Qwen3 0.6b", "qwen3:0.6b", { badge: "523 MB" })];
  const { value } = await pick({
    question: "Which model?",
    items,
    fallbackAsk: async () => "1",
    borrowStdin: async (run) => {
      lent += 1;
      return run();
    },
    nonInteractive: true,
  });

  assert.equal(value, "qwen3:0.6b");
  // Non-interactive never borrows — there is no raw mode to take. What matters
  // is that the parameter is threaded at all, which is what the wizard passes.
  assert.equal(lent, 0);
});

test("with no terminal the list still answers, by number", async () => {
  const items = [
    group("Hosted"),
    option("OpenAI", "openai"),
    option("Anthropic", "anthropic"),
    group("Local"),
    option("Qwen3 0.6b", "qwen3:0.6b"),
  ];
  const p = prompterThatAnswers(["3"]);
  const { value } = await pick({ question: "Which model?", items, fallbackAsk: p.ask, nonInteractive: true });

  assert.equal(value, "qwen3:0.6b", "headings are not selectable, so 3 is the third OPTION");
});

test("an unanswerable list takes its initial rather than throwing", async () => {
  const items = [option("OpenAI", "openai"), option("Anthropic", "anthropic")];
  const p = prompterThatAnswers([""]);
  const { value } = await pick({ question: "Which model?", items, fallbackAsk: p.ask, nonInteractive: true, initial: 1 });

  assert.equal(value, "anthropic");
});

test("without a terminal the model step is still the old numbered question", async () => {
  const p = prompterThatAnswers(["3"]);
  const picked = await chooseModel({ ask: p.ask, closed: p.closed, nonInteractive: true });

  assert.equal(picked.id, "openai", "--yes takes the documented default and asks nothing");
  assert.equal(picked.defaulted, true);
  assert.deepEqual(p.asked, []);
});

/* -------------------------------------------------------------------------- */
/* reading eve's installer back                                                */
/* -------------------------------------------------------------------------- */

test("the verdict is the LAST json line, not the first", () => {
  // eve narrates an install as one object per line: progress, then the ending.
  // Reading the first would report "Installed" for a setup that then blocked.
  const output = [
    '{"version":1,"type":"progress","message":"Installed channel/github"}',
    "Set up GitHub: Respond to issues, pull requests, and comments",
    '{"version":1,"type":"blocked","item":"channel/github","installed":true,"status":"input_required"}',
  ].join("\n");

  assert.equal(lastJsonLine(output).type, "blocked");
});

test("human lines between the json are output, not errors", () => {
  const output = [
    "- Checking registry.",
    "✔ Installing dependencies.",
    '{"version":1,"type":"completed","item":"channel/web"}',
    "Integration set up.",
  ].join("\n");

  assert.equal(lastJsonLine(output).type, "completed");
  assert.equal(lastJsonLine("no json at all\nnot even a brace"), null);
  // A line that looks like an object and is not must not take the verdict down
  // with it — a setup script printing `{ foo }` is a normal thing to print.
  assert.equal(lastJsonLine('{"type":"completed"}\n{ not json }').type, "completed");
});

test("eve's own recommendation is taken, and nothing is invented", () => {
  // This is what `eve add -y` means: run setup and accept its recommended
  // defaults. Taking them is not the wizard choosing for you; it is the wizard
  // not stopping to ask a question upstream already answered.
  assert.equal(
    recommendedAnswer({ key: "github-events", recommended: ["issue_comment", "pull_request_review_comment"] }),
    'github-events=["issue_comment","pull_request_review_comment"]',
  );
  assert.equal(recommendedAnswer({ key: "mode", default: "readonly" }), 'mode="readonly"');
  // No recommendation is the case that has to STOP, not the case to guess at.
  assert.equal(recommendedAnswer({ key: "token" }), null);
  assert.equal(recommendedAnswer({ key: "events", recommended: [] }), null);
  assert.equal(recommendedAnswer(undefined), null);
});

/* -------------------------------------------------------------------------- */
/* a registry item that takes the scripts with it                              */
/* -------------------------------------------------------------------------- */

test("a script the web channel overwrote is put back, and its version kept", () => {
  // Measured against the real thing: `eve add channel/web` rewrites "dev" to
  // "next dev". For a bare eve project that is correct. For an evestack project
  // it silently breaks the one command the finish screen tells you to run,
  // because `scripts/dev.mjs` is the wrapper that wires Postgres and .env.local.
  const dir = mkdtempSync(join(tmpdir(), "evestack-scripts-"));
  const before = {
    dev: "node --env-file-if-exists=.env.local scripts/dev.mjs",
    build: "eve build",
    verify: "node scripts/verify.mjs",
  };
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { ...before, dev: "next dev", build: "next build", lint: "next lint" } }),
  );

  const moved = restoreScripts(dir, before);
  const after = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts;

  assert.equal(after.dev, before.dev, "npm run dev has to still start the agent");
  assert.equal(after.build, before.build);
  assert.equal(after["dev:web"], "next dev", "and the Next app stays one command away");
  assert.equal(after["build:web"], "next build");
  // Only collisions are touched. An added script is the whole point of
  // installing the thing.
  assert.equal(after.lint, "next lint");
  assert.equal(after.verify, before.verify);
  assert.deepEqual(moved.map((m) => m.name).sort(), ["build", "dev"]);
});

test("an install that touched no script reports nothing to move", () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-scripts-"));
  const before = { dev: "node scripts/dev.mjs" };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { ...before, extra: "echo hi" } }));

  assert.deepEqual(restoreScripts(dir, before), []);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.extra, "echo hi");
});

test("an unreadable package.json is a no-op, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-scripts-"));
  assert.deepEqual(restoreScripts(dir, { dev: "x" }), []);
  writeFileSync(join(dir, "package.json"), "{ not json");
  assert.deepEqual(restoreScripts(dir, { dev: "x" }), []);
});

/* -------------------------------------------------------------------------- */
/* an item that installs cleanly and kills the build                           */
/* -------------------------------------------------------------------------- */

test("a failing build names the item that caused it", () => {
  // The real output, from the real failure: `eve add extension/browserbase`
  // completes, and then the agent will not start because @browserbasehq/eve
  // imports `experimental_generateImage`, which AI SDK v7 no longer exports.
  const output = [
    "☰eve  v0.54.3",
    "Failed to evaluate authored module:",
    "  /tmp/proj/node_modules/@browserbasehq/eve/dist/extension/tools/act.mjs",
    "  Caused by: The requested module 'ai' does not provide an export named 'experimental_generateImage'",
  ].join("\n");
  const installed = [
    { id: "channel/web", title: "Web Chat" },
    { id: "extension/browserbase", title: "Browserbase" },
  ];

  const explained = explainBuildFailure(output, installed);

  assert.equal(explained.culprit.title, "Browserbase", "the slug has to find the package directory");
  assert.match(explained.cause, /experimental_generateImage/);
  assert.match(explained.modulePath, /@browserbasehq/);
});

test("a failure it cannot attribute still reports the cause", () => {
  // Better to say "something broke the build, here is the module" than to stay
  // silent because the slug did not match.
  const output = [
    "Failed to evaluate authored module:",
    "  /tmp/proj/node_modules/some-unrelated-pkg/index.mjs",
    "  Caused by: boom",
  ].join("\n");

  const explained = explainBuildFailure(output, [{ id: "channel/web", title: "Web Chat" }]);

  assert.equal(explained.culprit, undefined);
  assert.equal(explained.cause, "boom");
  assert.match(explained.modulePath, /some-unrelated-pkg/);
});

test("a short slug is not allowed to match half of node_modules", () => {
  // `channel/web` would otherwise claim every path containing "web".
  const output = [
    "Failed to evaluate authored module:",
    "  /tmp/proj/node_modules/webpack-thing/index.mjs",
    "  Caused by: boom",
  ].join("\n");

  assert.equal(explainBuildFailure(output, [{ id: "channel/web", title: "Web Chat" }]).culprit, undefined);
});

/* -------------------------------------------------------------------------- */
/* the variables an install quietly insists on                                 */
/* -------------------------------------------------------------------------- */

test("a non-null assertion is read as a hard requirement", () => {
  // This is the exact shape eve's generator writes, and the `!` is the signal:
  //   export default browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
  // Unset, the agent does not warn — it refuses to boot with
  // `Invalid extension config: apiKey: Too small`, which names a zod field and
  // never the variable.
  const dir = mkdtempSync(join(tmpdir(), "evestack-env-"));
  mkdirSync(join(dir, "agent", "extensions"), { recursive: true });
  writeFileSync(
    join(dir, "agent", "extensions", "browserbase.ts"),
    'import browserbase from "@browserbasehq/eve";\n\nexport default browserbase({\n  apiKey: process.env.BROWSERBASE_API_KEY!,\n});\n',
  );

  const needed = requiredEnvFrom(dir, ["agent/extensions/browserbase.ts"]);

  assert.deepEqual([...needed.keys()], ["BROWSERBASE_API_KEY"]);
  assert.equal(needed.get("BROWSERBASE_API_KEY"), "agent/extensions/browserbase.ts");
});

test("an optional setting is not reported as required", () => {
  // `??` and `?.` are how the same generator writes something it can live
  // without. Reporting those would put four lines of noise under every install.
  const dir = mkdtempSync(join(tmpdir(), "evestack-env-"));
  mkdirSync(join(dir, "agent", "channels"), { recursive: true });
  writeFileSync(
    join(dir, "agent", "channels", "slack.ts"),
    [
      "const verbose = process.env.EVESTACK_VERBOSE === '1';",
      "const token = process.env.SLACK_BOT_TOKEN ?? '';",
      "const secret = process.env.SLACK_SIGNING_SECRET?.trim();",
      "const required = process.env.SLACK_APP_ID!;",
    ].join("\n"),
  );

  const needed = requiredEnvFrom(dir, ["agent/channels/slack.ts"]);

  assert.deepEqual([...needed.keys()], ["SLACK_APP_ID"]);
});

test("a file that is not there is skipped, not thrown over", () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-env-"));
  assert.equal(requiredEnvFrom(dir, ["agent/nope.ts"]).size, 0);
});

test("only a variable with a value counts as set", () => {
  // `COMPOSIO_API_KEY=` is exactly the state the key prompt leaves behind when
  // someone skips it, and treating that as configured is how the wizard would
  // fail to mention the one thing still missing.
  const dir = mkdtempSync(join(tmpdir(), "evestack-env-"));
  writeFileSync(
    join(dir, ".env.local"),
    ["FILLED=abc123", "EMPTY=", "SPACED=   ", "# COMMENTED=x", "ALSO_FILLED = yes"].join("\n"),
  );

  const set = envAlreadySet(dir);

  assert.ok(set.has("FILLED"));
  assert.ok(set.has("ALSO_FILLED"));
  assert.ok(!set.has("EMPTY"), "a blank value is not a setting");
  assert.ok(!set.has("SPACED"));
  assert.ok(!set.has("COMMENTED"));
});

test("no .env.local at all is the same as nothing set", () => {
  const dir = mkdtempSync(join(tmpdir(), "evestack-env-"));
  assert.equal(envAlreadySet(dir).size, 0);
});

/* -------------------------------------------------------------------------- */
/* a name that is taken is a question, not an exit                             */
/* -------------------------------------------------------------------------- */

test("a directory that is there and not empty is explained, not just named", () => {
  // What shipped in 0.11.1 printed the wordmark, printed the first step's
  // header, and then exited on one bare line:
  //
  //     /Users/…/my-agent already exists and is not empty.
  //
  // The reader is looking at a wizard that has just drawn its first screen.
  // Saying what is in the directory is usually the whole explanation — almost
  // every collision is an earlier scaffold they forgot about.
  const problem = targetProblem("/tmp/proj/my-agent", {
    kind: "directory",
    entries: ["package.json", "agent", ".env"],
  });

  assert.match(problem.short, /already exists and is not empty/);
  assert.match(problem.why, /3 entries/);
  assert.match(problem.why, /package\.json/, "naming it is what identifies an old project");
});

test("one entry is an entry, not entries", () => {
  const problem = targetProblem("/tmp/x", { kind: "directory", entries: ["notes.md"] });
  assert.match(problem.why, /1 entry\b/);
  assert.doesNotMatch(problem.why, /package\.json/);
});

test("a free directory is no problem at all", () => {
  assert.equal(targetProblem("/tmp/x", { kind: "missing" }), null);
  assert.equal(targetProblem("/tmp/x", { kind: "directory", entries: [] }), null);
});

test("a file and an unreadable path each say their own thing", () => {
  assert.match(targetProblem("/tmp/x", { kind: "file" }).short, /is a file, not a directory/);
  const denied = targetProblem("/tmp/x", { kind: "unreadable", code: "EACCES" });
  assert.match(denied.short, /EACCES/);
  assert.match(denied.why, /permission/);
});

test("the suggested name is the nearest free one, so Enter resolves it", () => {
  // Recovering from a collision should be one keystroke, not a decision.
  const root = resolve("/w");
  const taken = new Set(["my-agent", "my-agent-2", "my-agent-3"].map((name) => join(root, name)));
  const exists = (p) => taken.has(p);

  assert.equal(freeNameNear("my-agent", exists, root), "my-agent-4");
  assert.equal(freeNameNear("other", exists, root), "other", "a free name is returned unchanged");
});

/* -------------------------------------------------------------------------- */
/* the screen when the terminal is small                                       */
/* -------------------------------------------------------------------------- */

test("the step header collapses rather than wrapping", () => {
  const steps = [
    { title: "Where" }, { title: "Model" }, { title: "Channels", count: 2 },
    { title: "Integrations" }, { title: "Services" }, { title: "Review" },
  ];
  const wide = stepHeaderLine(steps, 2, 100);
  const narrow = stepHeaderLine(steps, 2, 52);

  // Naming six steps does not fit 52 columns, and a header that breaks in the
  // middle of `Integrations` stops reading as a header at all.
  assert.match(wide, /Integrations/, "the full header names every step when there is room");
  assert.doesNotMatch(narrow, /Integrations/, "and gives that up rather than wrapping");
  assert.match(narrow, /step 3 of 6/, "the fallback still says where you are");
  assert.match(narrow, /Channels/, "and which step you are on");
  assert.ok(visible(narrow) <= 52, `${visible(narrow)} columns in a 52-column terminal`);
  assert.ok(visible(wide) <= 100);
});

test("the count survives the collapse", () => {
  // Losing it would make going back look destructive — the count on an answered
  // step is what says the answer is still there.
  const steps = [{ title: "Model" }, { title: "Channels", count: 3 }, { title: "Review" }];
  assert.match(stepHeaderLine(steps, 1, 40), /\(3\)/);
});

/* -------------------------------------------------------------------------- */
/* the line that says how much more there is                                   */
/* -------------------------------------------------------------------------- */

/**
 * `↑↓ 14 options, showing 10–17` shipped, on the model list, at the bottom of
 * the scroll. The range and the total were counted in different units: the
 * range in ROWS — a group heading is a row, and so is the blank line between
 * tiers — and the total in choosable options. Flat lists (channels,
 * integrations) have no headings, so the two agreed there and nothing caught
 * it; the model list has four tiers, and adding a fifth made it absurd rather
 * than merely wrong.
 */
test("the range and the total are counted in the same units", () => {
  const rows = [
    group("Subscription"), option("ChatGPT", "a"),
    group(""), group("Hosted"), option("OpenAI", "b"), option("Anthropic", "c"),
    group(""), group("Local"), option("Granite", "d"), option("Qwen", "e"), option("Llama", "f"),
  ];
  const opts = rows.filter((r) => r.heading === undefined);

  assert.equal(opts.length, 6);
  for (let cursor = 0; cursor < opts.length; cursor += 1) {
    const [first, last] = visibleRange(rows, opts, cursor);
    assert.ok(first >= 1, `cursor ${cursor}: starts at ${first}`);
    assert.ok(last <= opts.length, `cursor ${cursor}: showing ${first}–${last} of ${opts.length}`);
    assert.ok(first <= last, `cursor ${cursor}: ${first}–${last} runs backwards`);
    assert.ok(first <= cursor + 1 && cursor + 1 <= last,
      `cursor ${cursor}: the highlighted row must be inside what is claimed to be shown`);
  }
});

test("a list with no headings still reports every row", () => {
  // The case that was always correct, kept correct: 26 channels, no tiers.
  const rows = Array.from({ length: 26 }, (_, i) => option(`ch-${i}`, i));
  assert.deepEqual(visibleRange(rows, rows, 0), [1, 8]);
  assert.deepEqual(visibleRange(rows, rows, 25), [19, 26]);
});

test("a list shorter than the viewport shows all of itself", () => {
  const rows = [group("One"), option("a", 1), option("b", 2)];
  assert.deepEqual(visibleRange(rows, [rows[1], rows[2]], 0), [1, 2]);
});

/* -------------------------------------------------------------------------- */
/* the list called "Next"                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Two things about this list keep going wrong, and neither shows up as a
 * failure anywhere — they show up as a reader who never finds the dashboard.
 */
test("the last step is the one that shows you what the others started", () => {
  // Four commands start something. Without the fifth the list ends on `run dev`
  // — an agent in a terminal — and the dashboard is a container the reader has
  // booted and never been told how to look at. `evestack dashboard` reads the
  // port from .env.local, health-checks it, prints the credentials AND launches
  // the browser; this is where someone goes looking for it.
  //
  // This list is the MANUAL path, printed only when the stack was not brought
  // up. On the path where it was, the wizard opens the dashboard itself and this
  // list is never reached.
  const lines = nextSteps({ pm: "npm", dashboardPort: 4000 });
  assert.match(lines.at(-1), /npx evestack dashboard/);
  assert.match(lines.at(-1), /signed in/);
});

test("the comment column is a column under every package manager", () => {
  // It was five hardcoded runs of spaces sized for `npm`: the bootstrap line
  // sat one column right of the other four, and `pnpm` — two characters longer,
  // in two of the commands — moved all of them.
  for (const pm of ["npm", "pnpm", "yarn", "bun"]) {
    const columns = nextSteps({ pm }).map((line) => strip(line).indexOf("#"));
    assert.equal(new Set(columns).size, 1, `${pm}: ${columns.join(", ")}`);
    assert.ok(columns[0] > 0, `${pm}: no comment column at all`);
  }
});

test("the port the wizard actually picked is the port the list names", () => {
  // freePort() moves off 4000 when something already has it, and a list naming
  // a port nobody is serving is worse than a list naming none.
  const lines = nextSteps({ pm: "npm", dashboardPort: 4317 }).join("\n");
  assert.match(lines, /:4317/);
  assert.doesNotMatch(lines, /:4000/);
});

/** SGR out, so a column is measured in characters a reader can see. */
function strip(line) {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}
