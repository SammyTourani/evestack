/**
 * The first ninety seconds, as a stranger actually experienced them.
 *
 * Three separate findings from one cold run on an unprepared machine, all in the
 * part of the product that runs before anything works:
 *
 *   - the scaffolder printed nothing at all for two and a half minutes while a
 *     registry it never named failed to answer, and then gave up;
 *   - a bare Enter at "Choose 1, 2 or 3:" silently meant OpenAI, and the next
 *     thing on screen was a demand for an OPENAI_API_KEY nobody agreed to;
 *   - the finish diagram ended with "the only thing that leaves this machine"
 *     on the Ollama path, where nothing leaves the machine at all.
 *
 * None of the three is reachable from a test of the wizard as a whole — two need
 * a terminal and the third needs two minutes of a broken network — so the piece
 * that decides each one is pulled out and tested directly. That is what the
 * seams are for: a prompt loop that takes an injected reader, a pure
 * elapsed-to-note function, and a pure provider-to-sentence function.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  chooseProvider,
  DEFAULT_PROVIDER,
  installWaitNote,
  looksLikeANetworkFailure,
  modelEdge,
  PROVIDER_QUESTION,
  PROVIDERS,
} from "../create.mjs";

/**
 * A stand-in for makePrompter: answers from a script, records every question it
 * was asked, and can hit EOF partway through the way a closed pipe does.
 */
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

/** The complaint belongs to the wizard, not to the loop, so tests silence it. */
const quiet = () => {};

/* -------------------------------------------------------------------------- */
/* 5.2 - the question that decided the whole run, answered with a bare Enter   */
/* -------------------------------------------------------------------------- */

test("a bare Enter is asked again, not read as OpenAI", async () => {
  const p = prompterThatAnswers(["", "", "3"]);
  const { provider, defaulted } = await chooseProvider({ ask: p.ask, closed: p.closed, complain: quiet });

  assert.equal(p.asked.length, 3, "an empty answer has to come back as the same question");
  assert.equal(provider.id, "ollama", "and the answer finally given is the one taken");
  assert.equal(defaulted, false);
});

/** ESC [ B. Written as codes so this file carries no raw escape sequence. */
const DOWN_ARROW = String.fromCharCode(27) + "[B";

test("the keystroke that caused this is refused too", async () => {
  // The prompt is numeric and reads like a list, so this is what the first
  // person through the door actually pressed. It used to fall through the old
  // `?? PROVIDERS.get("1")` and select OpenAI in silence.
  const p = prompterThatAnswers([DOWN_ARROW, "2"]);
  const { provider } = await chooseProvider({ ask: p.ask, closed: p.closed, complain: quiet });

  assert.equal(p.asked.length, 2);
  assert.equal(provider.id, "anthropic");
});

test("--yes takes the documented default and asks nothing", async () => {
  const p = prompterThatAnswers([]);
  const { provider, defaulted } = await chooseProvider({ ask: p.ask, closed: p.closed, nonInteractive: true });

  assert.deepEqual(p.asked, [], "there is nobody to answer, so nothing is asked");
  assert.equal(defaulted, true, "and the caller is told, so it can print which one it took");
  assert.equal(provider, PROVIDERS.get(DEFAULT_PROVIDER));
});

test("a stdin that closes mid-question ends it instead of looping", async () => {
  const p = prompterThatAnswers([], { eofAfter: 1 });
  const { defaulted } = await chooseProvider({ ask: p.ask, closed: p.closed, complain: quiet });

  assert.equal(p.asked.length, 1, "EOF is not a wrong answer to complain about");
  assert.equal(defaulted, true);
});

test("an answer that never becomes valid still terminates", async () => {
  const p = prompterThatAnswers([]);
  const { defaulted } = await chooseProvider({ ask: p.ask, closed: p.closed, complain: quiet });

  assert.ok(p.asked.length > 1, "it did re-ask");
  assert.ok(p.asked.length <= 6, p.asked.length + " asks is a loop, not a dialogue");
  assert.deepEqual([...new Set(p.asked)], [PROVIDER_QUESTION]);
  assert.equal(defaulted, true, "and it says so rather than pretending someone chose");
});

/* -------------------------------------------------------------------------- */
/* 4.7 and 5.3 - a diagram that claimed an outbound call the free path lacks   */
/* -------------------------------------------------------------------------- */

test("the Ollama path is not described as leaving the machine", () => {
  const local = modelEdge("ollama", "qwen3", "http://127.0.0.1:11434");

  assert.match(local, /nothing leaves this machine/);
  assert.doesNotMatch(local, /the only thing that leaves/);
  assert.match(local, /127\.0\.0\.1:11434/, "and it says where the model actually is");
});

test("the hosted paths keep the claim, because of them it is true", () => {
  assert.match(modelEdge("openai", "gpt-5-mini"), /the only thing that leaves this machine/);
  assert.match(modelEdge("anthropic", "claude-sonnet-5"), /the only thing that leaves this machine/);
});

test("every provider names its own model in the line", () => {
  const all = [...PROVIDERS.values()];
  const named = all.every((p) => modelEdge(p.id, p.model).includes(p.model));

  assert.ok(named, all.map((p) => modelEdge(p.id, p.model)).join("\n"));
});

test("loopback is loopback however it is spelled", () => {
  const urls = [
    "http://localhost:11434",
    "http://[::1]:11434",
    "http://127.0.0.2:11434",
    "http://0.0.0.0:11434",
  ];
  const lines = urls.map((u) => modelEdge("ollama", "qwen3", u));

  assert.ok(lines.every((l) => /nothing leaves this machine/.test(l)), lines.join("\n"));
});

test("a remote OLLAMA_BASE_URL is not called local", () => {
  // The one Ollama configuration where traffic really does leave. Getting this
  // wrong would be the same bug the branch exists to fix, pointing the other way.
  const remote = modelEdge("ollama", "qwen3", "http://192.168.1.50:11434");

  assert.doesNotMatch(remote, /nothing leaves/);
  assert.match(remote, /192\.168\.1\.50:11434/);
});

/* -------------------------------------------------------------------------- */
/* 5.1 - two and a half minutes of nothing at all                              */
/* -------------------------------------------------------------------------- */

test("a normal install is not narrated, and a stuck one is", () => {
  assert.equal(installWaitNote(0), null);
  assert.equal(installWaitNote(14_999), null, "an install that is simply working stays quiet");

  const first = installWaitNote(15_000, "registry.npmmirror.com");
  assert.match(first, /registry\.npmmirror\.com/, "naming the host is the whole point");
});

test("the row keeps changing, because a frozen row reads as a hang", () => {
  const notes = [15_000, 45_000, 120_000].map((ms) => installWaitNote(ms, "a-mirror.example.com"));

  assert.equal(new Set(notes).size, 3, notes.join(" / "));
});

test("the note fits the row it is printed in", () => {
  // rowLine puts it after 2 spaces, a glyph, a space and a 13-wide label, and
  // spread flushes the elapsed clock right against width(), which is 80 on most
  // terminals. Overflow wraps, and a wrapped line survives the spinner repaint,
  // which clears one line and not two.
  const worst = installWaitNote(300_000, "reposerver.w10external.com");

  assert.ok(worst.length <= 45, worst.length + " chars: " + worst);
});

test("a registry that could not be read still produces a sentence", () => {
  assert.match(installWaitNote(60_000), /the registry/);
});

/* -------------------------------------------------------------------------- */
/* 5.1 - and what it says once the wait has failed                             */
/* -------------------------------------------------------------------------- */

test("a network failure is told apart from a package that is not there", () => {
  const timedOut = "npm error network request to https://registry.npmjs.org/eve failed, reason: connect ETIMEDOUT";
  const noDns = "npm error code ENOTFOUND, npm error syscall getaddrinfo";
  const mirrorRefused = "ERR_PNPM_META_FETCH_FAIL GET https://mirror.internal/eve: request to https://mirror.internal/eve failed";
  const missing = "npm error 404 Not Found - GET https://registry.npmjs.org/@evestack%2fcomposio";
  const conflict = "npm error ERESOLVE unable to resolve dependency tree";

  assert.equal(looksLikeANetworkFailure(timedOut), true);
  assert.equal(looksLikeANetworkFailure(noDns), true);
  assert.equal(looksLikeANetworkFailure(mirrorRefused), true);
  // A 404 is the template asking for something that is not published. Answering
  // that with network advice sends someone to their VPN settings over a typo.
  assert.equal(looksLikeANetworkFailure(missing), false);
  assert.equal(looksLikeANetworkFailure(conflict), false);
  assert.equal(looksLikeANetworkFailure(""), false);
});

test("the line still fits an 80-column terminal", () => {
  // Printed as six spaces, an arrow, the provider name and then this. The widest
  // provider name is nine characters, which leaves about sixty here. Copy is not
  // owned by this file, so the budget is pinned instead of the wording.
  const widest = [...PROVIDERS.values()]
    .map((p) => modelEdge(p.id, p.model))
    .concat(modelEdge("ollama", "qwen3", "http://192.168.1.50:11434"))
    .sort((a, b) => b.length - a.length)[0];

  assert.ok(widest.length <= 60, widest.length + " chars: " + widest);
});

/* -------------------------------------------------------------------------- */
/* the scaffold has to be a git repository, and not for style reasons          */
/* -------------------------------------------------------------------------- */

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");

/**
 * A PATH where the package manager is a stub, so the slow networked step does
 * not run. git is deliberately NOT stubbed: it is the thing under test.
 */
function shimPath() {
  const bin = mkdtempSync(join(tmpdir(), "evestack-gitshim-"));
  const write = (name, body) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  const install = String.fromCharCode(35) + "!/bin/sh\ncase \"$1\" in install) mkdir -p node_modules/eve;; esac\nexit 0\n";
  ["npm", "pnpm", "yarn", "bun"].forEach((name) => write(name, install));
  // Neither is consulted by anything asserted here, and both are slow or absent
  // depending on the machine. Failing them keeps the wizard off those paths.
  ["docker", "ollama"].forEach((name) => write(name, String.fromCharCode(35) + "!/bin/sh\nexit 1\n"));
  return bin + ":" + process.env.PATH;
}

test("a fresh scaffold is its own git repository", () => {
  // Not a nicety. eve resolves its dev source root by walking parents until it
  // finds .git or pnpm-workspace.yaml, then copies that root package.json,
  // lockfiles and .npmrc into .eve/dev-runtime/snapshots/. With no .git here the
  // walk reaches $HOME on any machine whose dotfiles are in git, and a real run
  // put three copies of the user own ~/.npmrc — registry credential included —
  // inside the generated project. The resolver stops at the first marker, so a
  // .git at the app root is the whole fix.
  const parent = mkdtempSync(join(tmpdir(), "evestack-gitinit-"));
  const result = spawnSync(process.execPath, [ENTRY, "proj", "--yes"], {
    cwd: parent,
    encoding: "utf8",
    env: { ...process.env, PATH: shimPath() },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const dotGit = join(parent, "proj", ".git");
  assert.ok(existsSync(dotGit), "no .git in the scaffold: " + result.stdout);
  assert.ok(statSync(dotGit).isDirectory());
});
