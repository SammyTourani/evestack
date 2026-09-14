/**
 * The scaffolding wizard — the implementation behind BOTH front doors.
 *
 *   npx create-evestack my-agent   -> index.mjs (this package's bin)
 *   evestack create my-agent       -> @evestack/cli's `evestack` bin, which
 *                                     imports `create-evestack/create`
 *
 * Two published names, one copy of this file. The alternative — an `evestack`
 * package carrying its own scaffolder — is two implementations that drift, and
 * the drift is invisible until someone reports a bug that was already fixed on
 * the other side.
 *
 * Which package holds the implementation is not arbitrary. It is this one,
 * because this one is dependency-free and already carries `template/`;
 * `evestack` depends on `pg` for `doctor`, and inverting the edge would put a
 * Postgres driver in front of every first-time `npx create-evestack`.
 *
 * Deliberately dependency-free. A scaffolder that installs a prompt library
 * before it can ask its first question is slower than the thing it scaffolds,
 * and every dependency here is one more supply-chain surface for a tool that
 * writes files and credentials.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  basename, C, DASHBOARD_IMAGE, detectPm, dim, freePort, makePrompter, ok,
  packageVersion, REPO, say, shellQuote, step, templateDir, warn, writeSecretFile,
} from "./shared.mjs";
import {
  EMBED_MODEL, LOCAL, NO_TOOLS_COST, REMOTE, fits, humanSize, localBadge, probeLocalModel,
  recommendedLocal, totalGb,
} from "./models.mjs";
import {
  CATALOG_HINT, gated, loadCatalog, needsBadge, summarise,
} from "./catalog.mjs";
import { BACK, CANCEL, ask as pick, group, option, runSteps } from "./wizard.mjs";
import { blank, box, c, color, g, pad, row, rule, shortPath, task, wordmark } from "./ui.mjs";

/** One finished thing, in the aligned two-column shape every command uses. */
const done = (label, detail) => row(g.OK, label, c.dim(detail), "", { labelWidth: 13 });

/* -------------------------------------------------------------------------- */
/* the wizard's shape                                                          */
/* -------------------------------------------------------------------------- */

/** padEnd against printable width, for the provider table. */
function padTo(s, n) {
  return `${s}${" ".repeat(Math.max(0, n - s.length))}`;
}

/* -------------------------------------------------------------------------- */
/* which model                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every one of these is written to .env.local as EVESTACK_PROVIDER. It is the
 * variable agent/agent.ts branches on (defaulting to "openai"), and a model name
 * written without it goes to whichever provider was already selected — which is
 * how the Ollama path used to fail, with `compaction trigger model
 * "openai/qwen3" does not have known AI Gateway context window metadata`.
 * Choosing a provider and not writing EVESTACK_PROVIDER is not a partial
 * configuration, it is a broken one.
 *
 * A Map, not an object literal, because the key is whatever the user typed:
 * `PROVIDERS["__proto__"]` on a literal returns Object.prototype, which is
 * truthy, so `?? default` never fires and the wizard goes on to write
 * `EVESTACK_PROVIDER=undefined` and `undefined=` into .env.local.
 */
export const PROVIDERS = new Map([
  ["1", { id: "openai", keyVar: "OPENAI_API_KEY", model: "gpt-5-mini", keyHint: "https://platform.openai.com/api-keys" }],
  ["2", { id: "anthropic", keyVar: "ANTHROPIC_API_KEY", model: "claude-sonnet-5", keyHint: "https://console.anthropic.com/settings/keys" }],
  // 3 stays Ollama, and 4 is appended rather than inserted, because these
  // numbers are an interface: `echo 3 | npx create-evestack` is in people's
  // shell history and in their CI, and renumbering would silently give them a
  // different provider than the one that worked yesterday.
  //
  // The model behind 3 DID change — `qwen3` (5.2 GB) to `qwen3:0.6b` (523 MB).
  // That is the point of the change rather than a side effect of it: the old
  // default was the largest local model on the list, picked for a laptop that
  // then had to run it beside Docker, Postgres, the dashboard and the agent.
  ["3", { id: "ollama", keyVar: null, model: "qwen3:0.6b", keyHint: null }],
  ["4", { id: "openrouter", keyVar: "OPENROUTER_API_KEY", model: "qwen/qwen3.8-27b", keyHint: "https://openrouter.ai/keys" }],
]);

/** "1, 2 or 3" — derived, so adding a provider cannot leave the prose behind. */
function choiceList() {
  const keys = [...PROVIDERS.keys()];
  return `${keys.slice(0, -1).join(", ")} or ${keys.at(-1)}`;
}

/** Taken only when there is nobody to ask: `--yes`, CI, a heredoc, a dead pipe. */
export const DEFAULT_PROVIDER = "1";

export const PROVIDER_QUESTION = "Which provider?";

/**
 * A bound on the loop below, and the reason there is one.
 *
 * Re-asking forever is right while a person is typing and wrong the instant
 * anything else is: a pty driven by a script that answers every prompt with a
 * newline would spin here until something killed it. Five refusals is far past
 * what a human does by accident, and what happens after them is printed.
 */
const CHOICE_ATTEMPTS = 5;

/**
 * Ask which provider, and do not guess.
 *
 * This was one `ask("Choose 1, 2 or 3:", "1")`, so a bare Enter — or a Down
 * arrow, because the prompt is numeric and not the arrow-key list people expect
 * — selected OpenAI in silence and the wizard went straight on to demand an
 * OPENAI_API_KEY. The user is then being asked for a credential belonging to a
 * product they did not choose, with nothing on screen saying why. Of the four
 * questions this is the one that decides the rest of the run: the provider,
 * whether a key is needed at all, whether anything leaves the machine, and what
 * the finish diagram says.
 *
 * So an unusable answer is refused and asked again. The default survives for the
 * one case that cannot answer, and there it is printed rather than assumed.
 *
 * `closed()` is what makes re-asking safe — see makePrompter for why `ask` alone
 * cannot tell Enter from EOF. Injected rather than imported, because that is
 * what makes this loop testable without a pty, and a pty is the only other way
 * to reach it.
 */
export async function chooseProvider({ ask, closed = () => false, nonInteractive = false, complain = warn }) {
  for (let attempt = 0; attempt < CHOICE_ATTEMPTS && !nonInteractive && !closed(); attempt += 1) {
    const answer = (await ask(PROVIDER_QUESTION, "")).trim();
    const picked = PROVIDERS.get(answer);
    if (picked) return { provider: picked, defaulted: false };
    // EOF, not a wrong answer: `ask` returned its fallback because stdin closed.
    if (closed()) break;
    complain(
      answer === ""
        ? `This one decides the provider, so it is not guessed. Type ${choiceList()}.`
        : `${JSON.stringify(printable(answer))} is not one of them. Type ${choiceList()}.`,
    );
  }
  return { provider: PROVIDERS.get(DEFAULT_PROVIDER), defaulted: true };
}

/**
 * What is wrong with this path, said in one line, or null if nothing is.
 *
 * Split from the asking so the wizard can re-ask and `--yes` can still fail
 * hard with the same words.
 */
export function targetProblem(target, existing) {
  if (existing.kind === "file") {
    return { short: `${shortPath(target)} is a file, not a directory.`, why: "create makes a new directory and fills it." };
  }
  if (existing.kind === "unreadable") {
    return {
      short: `${shortPath(target)} cannot be read — ${existing.code}.`,
      why:
        existing.code === "EACCES" || existing.code === "EPERM"
          ? "This user does not have permission to look inside it."
          : "The filesystem refused the lookup.",
    };
  }
  if (existing.kind === "directory" && existing.entries.length > 0) {
    const n = existing.entries.length;
    // Naming what is in there is usually the whole explanation: almost every
    // collision is an earlier scaffold the reader forgot about.
    const looksScaffolded = existing.entries.includes("package.json");
    return {
      short: `${shortPath(target)} already exists and is not empty.`,
      why: looksScaffolded
        ? `It holds ${n} ${n === 1 ? "entry" : "entries"} including package.json — probably an earlier project.`
        : `It holds ${n} ${n === 1 ? "entry" : "entries"}.`,
    };
  }
  return null;
}

/**
 * The nearest name that is free: `my-agent`, then `my-agent-2`, `my-agent-3`.
 *
 * Offered as the default on the re-ask, so recovering from a collision is one
 * keystroke rather than a decision.
 */
export function freeNameNear(name, exists = (p) => existsSync(p), cwd = process.cwd()) {
  const full = (n) => (isAbsolute(n) ? n : resolve(cwd, n));
  if (!exists(full(name))) return name;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${name}-${n}`;
    if (!exists(full(candidate))) return candidate;
  }
  return `${name}-${Date.now()}`;
}

/* -------------------------------------------------------------------------- */
/* the door for someone who has never seen this before                         */
/* -------------------------------------------------------------------------- */

/** Where someone who answers "I have no idea" is sent. */
export const QUICKSTART_URL = "https://evestack.vercel.app/docs/quickstart";

/**
 * A tutorial video, when there is one.
 *
 * Deliberately a named constant sitting empty rather than a URL invented here.
 * The wizard offers whichever of these exists, so filling this in is the whole
 * change — no branch to add, no copy to rewrite.
 */
export const TUTORIAL_URL = "";

export const ORIENT = { SETUP: "setup", DOCS: "docs", GUIDED: "guided" };

/**
 * How to hand a URL to the desktop, per platform.
 *
 * Exported because the only part worth testing is this mapping; actually
 * spawning a browser in a test suite is how a CI run ends up with 400 tabs.
 */
export function browserCommand(platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [] };
  // The empty string is the window TITLE argument. Without it `start` treats a
  // quoted URL as the title and opens nothing, which is the classic Windows
  // bug in this three-line function.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  return { command: "xdg-open", args: [] };
}

/**
 * Open a URL, and never let that failure become the wizard's failure.
 *
 * Detached and fully ignored: a browser launched from here outlives the
 * scaffolder, and an inherited stdio would let Chrome's startup chatter land in
 * the middle of the next question. `unref` so Node does not wait on it at exit.
 *
 * The URL is ALSO printed, every time, whether or not this works. Over SSH, in
 * a container, in WSL without an X server and on a headless CI box there is no
 * browser to open, and the failure mode of the spawn is silence — so the
 * printed line is the real deliverable and the spawn is the convenience.
 */
function openInBrowser(url) {
  try {
    const { command, args } = browserCommand();
    const child = spawn(command, [...args, url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The question before the questions.
 *
 * The old wizard opened on "Project name?", which assumes the reader already
 * decided to have a project. Someone who ran this to find out what it is had
 * four prompts and no way out except Ctrl-C, and the docs were never mentioned.
 *
 * Returns one of ORIENT. The docs answer is not an exit: it opens the page and
 * keeps going in guided mode, because they already typed the command and
 * throwing them back to a shell prompt to re-run it is a worse ending than
 * reading with the wizard still open.
 */
export async function orient({ ask, borrowStdin, nonInteractive = false }) {
  const items = [
    option("Set it up", ORIENT.SETUP, {
      badge: "~2 min", note: "four questions, sensible defaults",
    }),
    option(TUTORIAL_URL ? "Watch the tutorial first" : "Read the quickstart first", ORIENT.DOCS, {
      note: "opens in your browser, then comes back here",
    }),
    option("Explain as we go", ORIENT.GUIDED, {
      note: "the same questions, with what each one means",
    }),
  ];
  const { value: answer } = await pick({
    question: "First time with evestack?",
    items, borrowStdin, nonInteractive, fallbackAsk: ask, canBack: false, canForward: false,
  });
  if (answer !== ORIENT.DOCS) return answer ?? ORIENT.SETUP;

  const url = TUTORIAL_URL || QUICKSTART_URL;
  openInBrowser(url);
  say(`    ${c.dim(`${g.arrow} ${url}`)}`);
  dim("Opened in your browser. This wizard is still here — carry on when you are ready.");
  blank();
  return ORIENT.GUIDED;
}

/**
 * A paragraph that only a reader who asked for it has to scroll past.
 *
 * Guided mode is the whole reason the orientation question is worth asking: it
 * lets the default path stay short for people who know what they want, without
 * leaving everyone else to infer what a "World" or a "toolkit" is from a prompt.
 */
function explain(guided, lines) {
  if (!guided) return;
  for (const line of lines) say(`    ${c.dim(line)}`);
  blank();
}

/* -------------------------------------------------------------------------- */
/* which model                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The list, grouped, with the facts attached that the old three-line table had
 * nowhere to put.
 *
 * Sizes are marked against THIS machine, not against an abstract one. On 8 GB
 * the 5.2 GB model is flagged before it is chosen, which is the difference
 * between a warning and a working wizard: the old one printed the same fact one
 * question later, after the answer was already in.
 */
function modelItems(ram) {
  const remote = (badge) => REMOTE.filter((r) => r.badge === badge);
  const toOption = (r) => option(r.label, { kind: "remote", spec: r }, { badge: r.model, note: r.note });
  return [
    group(`Hosted ${g.sep} you bring an API key`),
    ...remote("hosted").map(toOption),
    group(""),
    group(`Gateway ${g.sep} one key, hundreds of models`),
    ...remote("gateway").map(toOption),
    group(""),
    group(`Local ${g.sep} free, private, nothing leaves this machine`),
    ...LOCAL.map((m) => {
      const badge = localBadge(m, ram);
      return option(m.label, { kind: "local", spec: m }, {
        badge: badge.text, badgeColor: badge.color, note: m.note,
      });
    }),
    group(""),
    group("Other"),
    ...remote("custom").map((r) => option(r.label, { kind: "remote", spec: r }, { note: r.note })),
  ];
}

/**
 * Ask which model, the way a list should be asked.
 *
 * Non-interactive still goes through `chooseProvider` — the numbered path, its
 * five-attempt bound and its EOF handling are unchanged and still the only
 * thing `--yes`, CI and every existing test touch. This function is the TTY
 * path layered over it, not a replacement for it.
 */
export async function chooseModel({ ask, closed, borrowStdin, nonInteractive = false, guided = false, canBack = true, ram = totalGb() }) {
  if (nonInteractive || !process.stdin.isTTY) {
    const { provider, defaulted } = await chooseProvider({ ask, closed, nonInteractive });
    if (defaulted) dim(`No answer, so this takes ${DEFAULT_PROVIDER}: ${provider.id} ${provider.model}.`);
    return settle({ ...provider, isLocal: provider.id === "ollama", defaulted });
  }

  explain(guided, [
    "The agent needs a model that can CALL TOOLS — that is how it reaches memory,",
    "your Composio toolkits, the sandbox and approvals. A model without them will",
    "answer in prose and quietly do nothing, so anything that cannot is marked.",
  ]);

  const answer = await pick({
    question: "Which model should the agent use?",
    hint: "Tool calling is the one property that matters — anything without it is marked.",
    items: modelItems(ram), borrowStdin, fallbackAsk: ask, canBack, initial: 0,
  });
  if (answer.back) return BACK;
  if (answer.cancelled) return CANCEL;
  const chosen = answer.value;

  if (chosen.kind === "local") {
    const m = chosen.spec;
    return settle({ id: "ollama", model: m.model, keyVar: null, keyHint: null, keyShape: null,
      isLocal: true, ctx: m.ctx, expectsTools: m.tools, defaulted: false });
  }

  const spec = chosen.spec;
  if (!spec.needsBaseUrl) return settle({ ...spec, isLocal: false, defaulted: false });

  // An OpenAI-compatible endpoint is two more facts, and neither has a default
  // worth guessing: the URL is whatever they are running, and the model id is
  // that server's own name for it. LM Studio's port is offered because it is by
  // far the most common answer and typing it is the only friction here.
  blank();
  dim("Anything that speaks the OpenAI API: LM Studio, llama.cpp, vLLM, Groq, Together.");
  const baseUrl = await ask("Base URL:", "http://127.0.0.1:1234/v1");
  const model = await ask("Model id:", "local-model");
  return settle({ ...spec, model, baseUrl, isLocal: isLoopback(baseUrl), defaulted: false });

  /**
   * Everything that follows from the choice, done here rather than by the
   * caller.
   *
   * The .env.local lines, the key prompt, the Ollama probes and the RAM check
   * all depend on which model was picked and on nothing else, so they belong
   * with the picking. Leaving them in `main` is what made this step impossible
   * to re-enter: coming back to change the model has to re-ask for the matching
   * key, and a caller holding half the state cannot do that.
   */
  async function settle(picked) {
    let ollamaBaseUrl = null;
    let apiKeyLine = "";
    let modelLine = `EVESTACK_PROVIDER=${picked.id}\nEVESTACK_MODEL=${picked.model}`;
    // Only the OpenAI-compatible path carries one, and agent.ts refuses to start
    // without it rather than silently calling api.openai.com.
    if (picked.baseUrl) modelLine += `\nEVESTACK_BASE_URL=${picked.baseUrl}`;
    // A local model's context window has to be declared: eve sizes compaction
    // from the AI Gateway catalog, which has never heard of qwen3:0.6b.
    if (picked.id === "ollama" && picked.ctx) modelLine += `\nEVESTACK_CONTEXT_WINDOW=${picked.ctx}`;

    if (picked.id === "ollama") {
      const ollama = await checkLocalModel(picked.model);
      ollamaBaseUrl = ollama.baseUrl;
      // The RAM warning fires only when it is TRUE of this machine and this
      // model. It used to be unconditional prose about a 5.2 GB download,
      // printed even to someone who had been given no other local option.
      const spec2 = LOCAL.find((m) => m.model === picked.model);
      if (spec2 && !fits(spec2, ram)) {
        const safe = recommendedLocal(ram);
        blank();
        warn(`${picked.model} is ${humanSize(spec2.mb)}, and this machine has ${Math.round(ram)} GB.`);
        warn("Beside Docker, Postgres, the dashboard and the agent that is tight enough to hang it.");
        dim(`${safe.label} (${humanSize(safe.mb)}) is the largest one that comfortably fits here.`);
      }
      apiKeyLine = "# Local models need no API key.";
    } else if (nonInteractive || closed()) {
      // `--yes`, CI, a heredoc. There is nobody to paste a key, and askKey would
      // spend its three attempts talking to a closed pipe before giving up — so
      // the line is written empty and the finish screen's "add your key before
      // you start" branch picks it up, exactly as it did before this step
      // learned to prompt.
      apiKeyLine = `${picked.keyVar}=`;
    } else if (picked.keyVar && !(picked.id === "compatible" && picked.isLocal)) {
      say();
      explain(guided, [
        "The key is written to .env.local, which is git-ignored and read by nothing",
        "but this project. Leave it blank and the scaffold still completes — the",
        "agent just will not answer until you add it.",
      ]);
      if (picked.keyHint) dim(`Paste a key now, or press Enter to skip — ${picked.keyHint}`);
      const { key } = await askKey({ ask, closed, label: picked.keyVar, shape: picked.keyShape });
      apiKeyLine = `${picked.keyVar}=${key}`;
    } else {
      // A loopback OpenAI-compatible server (LM Studio, llama.cpp) authenticates
      // nobody. Asking for a key there is asking a question with no right answer.
      apiKeyLine = `# ${picked.model} on ${picked.baseUrl ?? "this machine"} needs no API key.`;
    }
    return { ...picked, ollamaBaseUrl, apiKeyLine, modelLine };
  }
}

/**
 * Everything that has to be true before a local model can actually answer.
 *
 * Four separate things can be wrong and each has a different fix, which is why
 * this reports rather than throws: a scaffold with a missing model pull is
 * still a good scaffold, it just has one command left to run.
 *
 * The capability probe is the one that did not exist before. A table in a
 * scaffolder cannot know that someone re-quantised a tag or renamed a model,
 * and "can this thing call tools" is the single question that decides whether
 * evestack works at all — so it is asked of the running Ollama, about the exact
 * model chosen, rather than assumed from the name.
 */
async function checkLocalModel(model) {
  const ollama = await inspectOllama(model);
  if (!ollama.installed) {
    warn("Ollama is not on PATH. Install it from https://ollama.com, then:");
    warn(`  ollama pull ${model} && ollama pull ${EMBED_MODEL}`);
    return ollama;
  }
  if (!ollama.running) {
    warn(`Ollama is installed but not answering on ${ollama.baseUrl}. Start it, then:`);
    warn(`  ollama pull ${model} && ollama pull ${EMBED_MODEL}`);
    return ollama;
  }
  if (!ollama.hasChatModel) {
    warn(`Ollama does not have "${model}" yet. Before your first message:`);
    warn(`  ollama pull ${model}`);
  } else {
    const probe = await probeLocalModel(ollama.baseUrl, model);
    if (probe.known && probe.tools === false) {
      blank();
      warn(`${model} cannot call tools — your Ollama reports: ${probe.capabilities.join(", ")}.`);
      warn("The agent will start, answer normally, and silently do none of this:");
      for (const lost of NO_TOOLS_COST) warn(`  ${g.skip} ${lost}`);
      dim("Pick a different model at step 2 if you want any of it. Everything else still works.");
      blank();
    }
  }
  // A SECOND, SEPARATE model. The chat model cannot produce embeddings, so
  // `remember` and `recall` fail without this one — and they fail inside a tool
  // call, where the model tends to report success anyway.
  if (!ollama.hasEmbedModel) {
    warn("Long-term memory needs a local embedding model, which is a separate pull:");
    warn(`  ollama pull ${EMBED_MODEL}`);
    dim("Skip it if you do not want the remember/recall tools; nothing else uses it.");
  }
  return ollama;
}

/* -------------------------------------------------------------------------- */
/* credentials                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Three tries, then move on.
 *
 * The old behaviour was one prompt whose answer was written to .env.local
 * unexamined. Paste a key with a newline in it, paste the wrong key, paste
 * nothing because you wanted to find the page first — all three produced a
 * clean-looking scaffold and a failure much later, at the first model call or
 * the first toolkit, where nothing on screen connects back to this moment.
 *
 * Three is from the shape of the mistake rather than from a convention: the
 * realistic recovery is "oh, wrong tab" and that takes one retry, sometimes
 * two. A fourth prompt is no longer helping, it is refusing to let someone
 * leave — so the exit is automatic and it is announced.
 *
 * `shape` only ever rejects a key that CANNOT be right (an OpenAI key not
 * starting `sk-`). It deliberately does not try to judge length or charset:
 * this runs offline, prefixes are stable and published, and a validator that
 * guesses is a validator that eventually rejects a real key.
 */
export const KEY_ATTEMPTS = 3;

/** A bound on the name loop, for the same reason CHOICE_ATTEMPTS has one. */
const NAME_ATTEMPTS = 6;

export async function askKey(
  { ask, closed = () => false, label, shape = null, attempts = KEY_ATTEMPTS, complain = warn, note = dim },
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const answer = (await ask(`${label}:`, "")).trim();
    if (closed()) return { key: "", skipped: true, reason: "eof" };
    if (answer && (!shape || shape.test(answer))) return { key: answer, skipped: false };

    const left = attempts - attempt;
    if (left === 0) break;
    // "1 tries left" and "a OPENROUTER_API_KEY" both shipped in the first draft.
    // Copy assembled from a count and a variable name has to handle both, or the
    // retry prompt — the one screen whose entire job is to sound patient — reads
    // like it is itself broken.
    const tries = `${left} ${left === 1 ? "try" : "tries"} left`;
    const article = /^[AEIOU]/.test(label) ? "an" : "a";
    complain(
      answer === ""
        ? `Nothing pasted — ${tries}. Keep pressing Enter to skip it.`
        : `That is not ${article} ${label} (they start "${shape.source.replace(/[\^]/g, "")}") — ${tries}.`,
    );
  }
  note(`Skipping ${label}. Add it to .env.local later and restart; nothing else here depends on it.`);
  return { key: "", skipped: true, reason: "attempts" };
}

/**
 * Echoing back what someone typed is echoing back whatever they typed, and the
 * answer that produced this whole bug was a Down arrow — ESC, then "[B". Handed
 * back to the terminal raw that moves the cursor instead of printing it, so a
 * complaint about the input corrupts the screen it is complaining on.
 */
function printable(answer) {
  const safe = (ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || code === 0x7f ? "?" : ch;
  };
  return Array.from(answer.slice(0, 24), safe).join("");
}

/* -------------------------------------------------------------------------- */
/* bringing it up                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Run a command in the project under a live one-line progress row.
 *
 * `stdio: "inherit"` is what this used to do, and it is the reason bringUp's own
 * comment described the experience as "a long silence followed by a wall of
 * layer hashes". Three commands ran back to back, each printing hundreds of
 * lines of someone else's progress output, and the four things that were
 * actually happening were invisible inside it.
 *
 * So the child's output is captured and the row is the only thing on screen —
 * until it fails, at which point the captured tail is printed, because a failure
 * with its own output withheld is strictly worse than noise. `--verbose` puts
 * the raw stream back for anyone debugging the commands themselves.
 *
 * `shell` on Windows only, and not for cosmetic consistency: `npm`, `pnpm`,
 * `yarn` and `bun` are installed there as `.cmd` shims, which CreateProcess
 * cannot execute, so a bare spawn fails with ENOENT before the package manager
 * runs at all. templates/default/scripts/dev.mjs and start.mjs already pass
 * exactly this for exactly this reason. Every argument this file passes is a
 * literal without spaces, which is what makes the shell safe to use here.
 *
 * NOT VERIFIED ON WINDOWS — there is no Windows machine in this loop. The claim
 * being matched is the one the template's own scripts already make.
 *
 * ASYNC, and that part is load-bearing rather than a style choice. The first
 * version of this used `spawnSync`, which blocks the event loop for the whole
 * lifetime of the child — so the `setInterval` behind the progress row could
 * never fire. Measured: zero repaints across a two-second child. The spinner
 * painted frame one, froze at `0s`, and jumped straight to the finished row, so
 * an eighteen-second install looked exactly like a hang. That is worse than the
 * wall of layer hashes it was replacing, because a wall of output at least moves.
 *
 * The captured output is capped. A cold `docker compose --wait` pull emits a
 * lot, all of it progress noise, and only the tail is ever printed.
 */
const MAX_CAPTURE = 64 * 1024;

/**
 * npm config that arrives through the ENVIRONMENT and changes what an exit code
 * means. Stripped before every child, because a step here is only worth running
 * if its answer is the same for everybody.
 *
 * `npm_config_if_present` is the one that bit. npm reads `--if-present` from the
 * environment like every other config, and under it `npm run <missing-script>`
 * exits **0** instead of 1:
 *
 *     plain                        exit 1
 *     npm_config_if_present=true   exit 0
 *
 * Anyone whose shell is inside an `--if-present` invocation exports it — the
 * root `pnpm -r --if-present test` in this very repo does — and it is inherited
 * all the way down into the `npm run db:bootstrap` below. The schema step then
 * reports "✓ workflow tables created" having created nothing, `bringUp` returns
 * true, and the dashboard is started against a database with no schema. A step
 * whose failure is invisible is worse than no step.
 *
 * Found by test/bring-up.test.mjs, which failed only under the root `pnpm -r`
 * run and passed every other way — a difference that looked for a while like
 * flakiness and was the bug reporting itself.
 */
const UNSAFE_NPM_ENV = ["npm_config_if_present"];

/** Exported so test/bring-up.test.mjs can pin the stripping without Docker. */
export function childEnv() {
  const env = { ...process.env };
  for (const key of UNSAFE_NPM_ENV) delete env[key];
  return env;
}

function run(cwd, command, args, { verbose = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnv(),
      stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let output = "";
    const collect = (chunk) => {
      output += chunk;
      if (output.length > MAX_CAPTURE) output = output.slice(-MAX_CAPTURE);
    };
    child.stdout?.setEncoding("utf8").on("data", collect);
    child.stderr?.setEncoding("utf8").on("data", collect);
    // ENOENT for a package manager that is not installed arrives here, not as a
    // non-zero exit, and it has to resolve rather than reject or the progress
    // row never settles and the cursor stays hidden.
    child.on("error", (error) => resolve({ ok: false, output: `${output}${error.message}` }));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
  });
}

/** The last few lines of a failed command, which is the part that says why. */
function printTail(output, lines = 12) {
  const tail = output.split("\n").filter((l) => l.trim()).slice(-lines);
  if (tail.length === 0) return;
  blank();
  for (const line of tail) say(`      ${c.dim(line.slice(0, 100))}`);
  blank();
}

/* -------------------------------------------------------------------------- */
/* the silence in the middle                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the install is waiting on, said out loud before the reader gives up.
 *
 * Measured, on a machine whose npm was pinned to a corporate mirror: the first
 * command in the quickstart printed nothing at all for two and a half minutes
 * and then failed. The spinner already proves the process is alive and the
 * elapsed clock already proves it is moving, but neither says WHAT it is waiting
 * for — and "npm install, 2m 10s" is indistinguishable from a hang to the one
 * person who has never seen this command succeed.
 *
 * The registry is the answer nearly every time, and it is the fact nobody has to
 * hand: the row says `npm`, and the host it is talking to is three .npmrc files
 * away. Naming it turns "this is broken" into "this machine cannot reach
 * reposerver.example.com", which is something a stranger can act on.
 *
 * Pure and exported, so the thresholds can be tested without waiting out two
 * minutes of real time for each one.
 *
 * The notes do NOT repeat the command. The label beside them already says
 * `install`, and the detail column is only as wide as the terminal minus the
 * label and the elapsed clock — about 57 characters at the 80 columns most
 * people still run. A note that overflows wraps, and a wrapped line breaks the
 * spinner underneath it, because the repaint clears one line and not two. So
 * the host gets the room instead: it is the part nobody can guess.
 */
const INSTALL_WAIT_STAGES = [
  { after: 15_000, note: (where) => `resolving from ${where}` },
  { after: 45_000, note: (where) => `still waiting on ${where}` },
  { after: 120_000, note: (where) => `no answer from ${where} yet` },
];

export function installWaitNote(elapsedMs, registryHostname = null) {
  const where = registryHostname || "the registry";
  let note = null;
  for (const stage of INSTALL_WAIT_STAGES) {
    if (elapsedMs >= stage.after) note = stage.note(where);
  }
  return note;
}

/**
 * Asked once, five seconds in: late enough that a fast install never pays for
 * it, early enough that the answer is in hand before the first note needs it.
 */
const REGISTRY_LOOKUP_AFTER = 5_000;

let registryLookup = null;

/**
 * The registry host this package manager is really configured with.
 *
 * `config get registry` reads the whole chain — project, user, global and the
 * environment — which is the only way to get the value the install is actually
 * using rather than the default everybody assumes. It is a local read, so it
 * cannot itself hang on the network that is already stuck.
 *
 * Only npm and pnpm are asked. Yarn Berry spells it `npmRegistryServer` and bun
 * has no `config get` at all, and a confidently wrong host here would be worse
 * than none: this exists to remove a guess, not to add one.
 *
 * Memoised, because the answer cannot change inside one run and both the
 * progress row and the failure message want it.
 */
export function registryHost(pm) {
  registryLookup ??= readRegistry(pm).then((url) => {
    if (!url) return null;
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  });
  return registryLookup;
}

function readRegistry(pm) {
  const fromEnv = process.env.npm_config_registry?.trim();
  if (fromEnv) return Promise.resolve(fromEnv);
  if (pm !== "npm" && pm !== "pnpm") return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // A `timeout` rather than a Promise.race: a race leaves the child running,
    // and an orphan holding a pipe keeps the event loop alive past the point
    // where the scaffold has finished and should have exited.
    const child = spawn(pm, ["config", "get", "registry"], {
      env: childEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
      timeout: 5_000,
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => done(null));
    child.on("close", () => done(out.trim().split("\n").pop()?.trim() || null));
  });
}

/**
 * Escalate a progress row while something slow runs. Returns the stop function.
 *
 * Nothing here can print a second line: `task` repaints the current line every
 * 90ms, so anything written beside it lands in the middle of the spinner. The
 * note is therefore the whole message, which is why it stays short.
 */
function watchInstall(pm, emit) {
  const started = Date.now();
  let host = null;
  let asked = false;
  let shown = null;
  const tick = () => {
    const elapsed = Date.now() - started;
    if (!asked && elapsed >= REGISTRY_LOOKUP_AFTER) {
      asked = true;
      registryHost(pm).then(
        (found) => {
          host = found;
        },
        () => {},
      );
    }
    const note = installWaitNote(elapsed, host);
    if (note && note !== shown) {
      shown = note;
      emit(note);
    }
  };
  const timer = setInterval(tick, 1_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Does this failure read as the network rather than the project?
 *
 * It is the difference between "run it again" and "this machine cannot reach
 * the registry", and it is the failure a first-timer is both most likely to hit
 * and least able to name. Deliberately narrow: a 404 for a package that does not
 * exist is NOT this, and answering that with network advice would send someone
 * to look at their VPN over a typo.
 */
const NETWORK_FAILURE = new RegExp(
  [
    "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN",
    "ERR_SOCKET_TIMEOUT", "ERR_PNPM_META_FETCH_FAIL", "network timeout",
    "request to \\S+ failed", "self[- ]signed certificate",
    "unable to (?:verify the first certificate|get local issuer)",
  ].join("|"),
  "i",
);

export function looksLikeANetworkFailure(output) {
  return NETWORK_FAILURE.test(String(output ?? ""));
}

/**
 * A step that runs a command and reports it as one row.
 *
 * Returns false at the first failure so the caller can stop — these three
 * depend on each other in order, and running `db:bootstrap` against a Postgres
 * that never started produces a second, more confusing error on top of the
 * first.
 */
/**
 * What landed, and what is still owed — printed once, at the end, where it can
 * be acted on.
 *
 * Split three ways on purpose. Installed-and-ready needs no words. Installed-
 * but-gated is the interesting row: the files are there and one credential is
 * missing, so the useful thing is the exact line that finishes it. Not-installed
 * is a failure and says so.
 *
 * This exists because the alternative is a wizard that quietly leaves three of
 * your five channels half-configured and lets you discover it one message at a
 * time.
 */
function reportPicked({ ready, pending, failed, moved = [], broke = null, missingEnv = [], pm }) {
  if (ready.length === 0 && pending.length === 0 && failed.length === 0) return;

  blank();
  if (ready.length > 0) {
    say(`  ${c.green(g.ok)} ${c.bold(`${ready.length} ready`)} ${c.dim(g.sep)} ${c.dim(ready.map((i) => i.title).join(", "))}`);
  }
  if (pending.length > 0) {
    say(`  ${c.yellow(g.warn)} ${c.bold(`${pending.length} installed, setup unfinished`)}`);
    for (const item of pending) {
      say(`      ${c.dim(g.branch)} ${c.bold(item.title)} ${c.dim(g.sep)} ${c.dim(item.why)}`);
      say(`        ${c.dim(`${pm} exec ${item.command}`)}`);
    }
  }
  if (failed.length > 0) {
    say(`  ${c.red(g.fail)} ${c.bold(`${failed.length} did not install`)}`);
    for (const item of failed) {
      say(`      ${c.dim(g.branch)} ${c.bold(item.title)} ${c.dim(g.sep)} ${c.dim(`${pm} exec eve add ${item.id}`)}`);
    }
  }
  if (moved.length > 0) {
    blank();
    say(`  ${c.dim("The web channel wanted these script names. Yours were kept; its versions moved:")}`);
    for (const script of moved) {
      say(`      ${c.dim(g.branch)} ${c.bold(`${pm} run ${script.parked}`)} ${c.dim(g.sep)} ${c.dim(script.command)}`);
    }
  }
  if (missingEnv.length > 0) {
    blank();
    say(`  ${c.yellow(g.warn)} ${c.bold("Add these to .env.local, or the agent will not start:")}`);
    for (const item of missingEnv) {
      say(`      ${c.dim(g.branch)} ${c.bold(`${item.name}=`)} ${c.dim(`${g.sep} required by ${item.file}`)}`);
    }
    dim("These are asserted with `!` in the file the install wrote, which means unset is a");
    dim("hard failure at boot rather than a warning — `Invalid extension config` names the");
    dim("zod field and never the variable, so it is spelled out here instead.");
  }
  // Last, loudest, and unconditional: an agent that will not compile is not a
  // finished scaffold, whatever the rows above say.
  if (broke) {
    blank();
    const name = broke.culprit?.title ?? "One of these";
    say(`  ${c.redBold(`${g.fail} ${name} stops the agent from building.`)}`);
    if (broke.cause) dim(broke.cause);
    else if (broke.modulePath) dim(broke.modulePath);
    blank();
    say(`  ${c.bold("Until that is undone, `" + pm + " run dev` will not start.")}`);
    if (broke.culprit) {
      const file = `agent/extensions/${broke.culprit.id.split("/").pop()}.ts`;
      say(`    ${c.bold(`rm ${file}`)}`);
      say(`    ${c.bold(`${pm} uninstall`)} ${c.dim("the package it added, listed in package.json")}`);
    }
    dim("A registry item is third-party code, and it can disagree with the versions this");
    dim("template pins. Removing the item is always the quick way back to a working agent.");
  }
}

/* -------------------------------------------------------------------------- */
/* installing what was picked                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which environment variables the newly-installed files insist on.
 *
 * eve's generated wiring says what it needs, in TypeScript, with a non-null
 * assertion: `agent/extensions/browserbase.ts` is

 *     export default browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
 *
 * The `!` is the whole signal. An optional setting is written `?? ""` or `?.`;
 * an asserted one is a promise that the variable is there, and when it is not
 * the agent does not warn — it refuses to start, with
 * `Invalid extension config: apiKey: Too small`. That message names a zod field,
 * not a variable, and nothing on screen connects it back to the thing that was
 * just installed.
 *
 * So the files are read and the assertions are collected. It is a regex over
 * generated code rather than a parse, which is the right size for the job: the
 * generator writes this one shape, and a miss costs a hint rather than
 * producing a wrong one.
 */
export function requiredEnvFrom(target, files) {
  const needed = new Map();
  for (const file of files) {
    let source;
    try {
      source = readFileSync(join(target, file), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*!/g)) {
      const name = match[1];
      if (!needed.has(name)) needed.set(name, file);
    }
  }
  return needed;
}

/** Names already set to something non-empty in the generated .env.local. */
export function envAlreadySet(target) {
  const set = new Set();
  try {
    for (const line of readFileSync(join(target, ".env.local"), "utf8").split("\n")) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (match && match[2].trim() !== "") set.add(match[1]);
    }
  } catch {
    /* no .env.local is the same as nothing set */
  }
  return set;
}

/** Every file under agent/, relative to the project, for before/after diffing. */
function agentFiles(target) {
  const root = join(target, "agent");
  const found = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`);
      else found.push(`agent/${rel}`);
    }
  };
  walk(root, "");
  return found;
}

/**
 * Prove the agent still compiles after the installs, and name what broke it.
 *
 * WHY THIS IS WORTH 1.5 SECONDS. `eve add extension/browserbase` reports a
 * clean, completed install and then the agent will not start at all:
 * `@browserbasehq/eve` imports `experimental_generateImage` from `ai`, which
 * AI SDK v7 no longer exports. Nothing in the install says so. The first sign
 * is `npm run dev` dying on a module path inside `node_modules`, in a project
 * the reader has never run before and has no reason to suspect.
 *
 * A registry item is third-party code being dropped into a template that pins
 * its own `ai` version, so this class of mismatch is structural rather than a
 * one-off — it will happen again with a different package. `eve build` is the
 * cheapest possible check for it (measured at 1.5s on the failing project) and
 * it prints both the module and the cause.
 *
 * Reported, never undone. The reader chose the item; silently removing it would
 * be a surprise of a different kind. What they get is the fact, the cause, and
 * the two commands that reverse it.
 */
async function verifyStillBuilds({ target, runner, installed }) {
  const result = await run(target, runner.command, [...runner.prefix, "build"], { verbose: false });
  if (result.ok) return null;
  return explainBuildFailure(result.output, installed);
}

/**
 * Read a failed `eve build` and say which installed item caused it.
 *
 * Split out from the command so the interesting half is testable without
 * building anything: the join between a failing module PATH
 * (`node_modules/@browserbasehq/eve/dist/…`) and a registry ID
 * (`extension/browserbase`) is a slug match, and slug matches are exactly the
 * kind of thing that quietly stops working.
 */
export function explainBuildFailure(output, installed = []) {
  const text = String(output ?? "");
  const modulePath = /Failed to evaluate authored module:\s*\n?\s*(\S+)/.exec(text)?.[1] ?? "";
  const cause = /Caused by:\s*(.+)/.exec(text)?.[1]?.trim() ?? "";
  // The path is a package directory and the id is a registry slug, so the join
  // is the slug appearing in the path. Three characters is the floor: `web`
  // and `x` would match half of node_modules.
  const culprit = installed.find((item) => {
    const slug = String(item.id).split("/").pop().replace(/[^a-z0-9]/gi, "").toLowerCase();
    return slug.length > 3 && modulePath.toLowerCase().includes(slug);
  });
  return { modulePath, cause, culprit };
}

/**
 * Install the chosen channels and integrations with eve's own installer.
 *
 * `eve add` and not a reimplementation: an evestack project IS an eve project,
 * the registry is eve's, and the install writes eve's files into eve's layout.
 * A second installer here would be a second thing to keep current against a
 * catalogue somebody else publishes.
 *
 * `--non-interactive` is the flag that makes this safe to run unattended, and it
 * was measured rather than assumed: `channel/web` and `channel/telegram` both
 * complete with exit 0 and a `{"type":"completed"}` line, including on a machine
 * with no Vercel account, where the setup prints "choose Vercel Connect or
 * portable credentials" and carries on. Without it, a credential prompt inside a
 * sub-process would hang the wizard with no way to answer and no way out.
 *
 * Failures do not stop the run. Nine installs where the fourth needs an account
 * you do not have should leave you with eight, not with a dead scaffold — so
 * each one is reported on its own row and the command to finish it is printed at
 * the end.
 */
/**
 * Put back any npm script a registry item overwrote, and re-home its version.
 *
 * MEASURED, not hypothetical. `eve add channel/web` rewrites the scaffold's
 * `package.json` scripts to run Next:
 *
 *     "dev":   "node --env-file-if-exists=.env.local scripts/dev.mjs"  ->  "next dev"
 *     "build": "eve build"                                             ->  "next build"
 *     "start": "node --env-file-if-exists=.env.local scripts/start.mjs" -> "next start"
 *
 * For a bare eve project that is right — the Next app IS the app. For an
 * evestack project it is not: `scripts/dev.mjs` is the wrapper that loads
 * `.env.local`, points the agent at Postgres and verifies the trace exporter,
 * and the finish screen this wizard prints ends with `npm run dev   # the
 * agent`. After the rewrite that command starts a web server instead, and
 * nothing on screen says so.
 *
 * So: every script that existed before the install and changed during it is
 * restored, and the installer's version is parked under `<name>:web` where it
 * is still one command away. Scripts the item ADDED are left exactly as they
 * are — this only ever undoes a collision, never an addition.
 */
export function restoreScripts(target, before) {
  const path = join(target, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const after = pkg.scripts ?? {};
  const moved = [];
  for (const [name, original] of Object.entries(before)) {
    const now = after[name];
    if (now === undefined || now === original) continue;
    // Park the installer's version rather than dropping it: the Next app it
    // just scaffolded has to be runnable, or installing the channel was
    // pointless.
    const parked = `${name}:web`;
    if (after[parked] === undefined) after[parked] = now;
    after[name] = original;
    moved.push({ name, parked, command: now });
  }
  if (moved.length === 0) return [];
  pkg.scripts = after;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return moved;
}

/**
 * The last NDJSON object eve printed, which is the one that says how it ended.
 *
 * eve narrates `eve add --non-interactive` as one JSON object per line and the
 * final one carries the verdict. Parsed leniently — a line that is not JSON is
 * ordinary human output from a setup script, not an error.
 */
export function lastJsonLine(output) {
  let found = null;
  for (const line of String(output ?? "").split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{") || !text.endsWith("}")) continue;
    try {
      found = JSON.parse(text);
    } catch {
      /* a brace-wrapped line that is not JSON is just output */
    }
  }
  return found;
}

/**
 * The answer eve itself recommends, in the `--answer key=<JSON>` shape.
 *
 * Taking it is exactly what `eve add -y` means — "run setup and accept its
 * recommended defaults" — so this is not the wizard inventing a preference, it
 * is the wizard not stopping to ask a question upstream has already answered.
 * Returns null when there is no recommendation, because guessing one would be
 * a different thing entirely.
 */
export function recommendedAnswer(question) {
  if (!question?.key) return null;
  const value = question.recommended ?? question.default;
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return `${question.key}=${JSON.stringify(value)}`;
}

/** At most this many setup questions are auto-answered before giving up. */
const SETUP_ROUNDS = 4;

/**
 * Install one registry item, answering what can be answered.
 *
 * Three endings, and they are genuinely different things:
 *
 *   ready     — installed and set up. Nothing left to do.
 *   pending   — installed, and setup stopped on something this wizard cannot
 *               supply: a credential, or a prerequisite like a linked Vercel
 *               project. The FILES ARE THERE; only the last mile is missing.
 *   failed    — the install itself did not happen.
 *
 * Collapsing `pending` into `failed` is what the first version did, and it told
 * someone their GitHub channel "did not install" when in fact it had installed
 * and was one `eve link` away from working. That is a worse lie than silence.
 */
async function addOne({ target, runner, item, verbose }) {
  const answers = [];
  for (let round = 0; round < SETUP_ROUNDS; round += 1) {
    const result = await run(
      target,
      runner.command,
      [
        ...runner.prefix, "add", item.id, "--non-interactive",
        // Only the first pass installs; the later ones are answering questions
        // about files that are already on disk.
        ...(round > 0 ? ["--skip-install"] : []),
        ...answers.flatMap((answer) => ["--answer", answer]),
      ],
      { verbose },
    );
    const last = lastJsonLine(result.output);

    if (last?.type === "completed") return { state: "ready" };

    if (last?.type === "blocked" && last.status === "input_required") {
      const answer = recommendedAnswer(last.question);
      if (answer) {
        answers.push(answer);
        continue;
      }
      return {
        state: "pending",
        why: last.question?.message ?? "setup needs an answer",
        command: `eve add ${item.id}`,
      };
    }

    if (last?.type === "blocked" && last.status === "prerequisite_required") {
      return {
        state: "pending",
        why: last.prerequisite?.message ?? "setup needs something else first",
        command: last.prerequisite?.command ?? `eve add ${item.id}`,
      };
    }

    if (last?.installed) {
      return { state: "pending", why: "setup did not finish", command: `eve add ${item.id}` };
    }
    return { state: "failed", why: result.ok ? "the installer reported nothing" : "the installer failed" };
  }
  return { state: "pending", why: "setup asked more than this wizard can answer", command: `eve add ${item.id}` };
}

/**
 * Install the chosen channels and integrations with eve's own installer.
 *
 * `eve add` and not a reimplementation: an evestack project IS an eve project,
 * the registry is eve's, and the install writes eve's files into eve's layout.
 * A second installer here would be a second thing to keep current against a
 * catalogue somebody else publishes.
 *
 * `--non-interactive` is what makes this safe to run unattended, and it was
 * measured rather than assumed: it never prompts, and it reports what it needs
 * as structured JSON instead. Without it a credential prompt inside a
 * sub-process would hang the wizard with no way to answer and no way out.
 *
 * Failures do not stop the run. Nine installs where the fourth needs an account
 * you do not have should leave you with eight, not with a dead scaffold.
 */
async function addRegistryItems({ target, items, verbose }) {
  if (items.length === 0) return { ready: [], pending: [], failed: [] };
  const ready = [];
  const pending = [];
  const failed = [];
  // The project's own eve, not a global one and not npx: the scaffold pins a
  // version, and the installer has to be that version or it writes files the
  // pinned runtime does not understand.
  const eveBin = join(target, "node_modules", ".bin", "eve");
  const runner = existsSync(eveBin) ? { command: eveBin, prefix: [] } : { command: "npx", prefix: ["--yes", "eve"] };

  blank();
  rule();
  blank();

  // Snapshot before anything runs, so a collision can be told from an addition,
  // and a newly-written file from one that was always there.
  const filesBefore = new Set(agentFiles(target));
  const scriptsBefore = (() => {
    try {
      return { ...JSON.parse(readFileSync(join(target, "package.json"), "utf8")).scripts };
    } catch {
      return {};
    }
  })();

  for (const [index, item] of items.entries()) {
    const counter = `${index + 1} of ${items.length}`;
    const row = verbose ? null : task("add", `${item.title} ${c.dim(g.sep)} ${counter}`, { labelWidth: 13 });
    if (verbose) say(`  ${g.MARK} ${c.bold("add")} ${c.dim(`${item.id}  ${counter}`)}`);
    const outcome = await addOne({ target, runner, item, verbose });
    if (outcome.state === "ready") {
      ready.push(item);
      row ? row.done(`${item.title} added`) : ok(`${item.title} added`);
    } else if (outcome.state === "pending") {
      pending.push({ ...item, ...outcome });
      row ? row.done(`${item.title} installed ${c.dim("— setup unfinished")}`) : ok(`${item.title} installed`);
    } else {
      failed.push({ ...item, ...outcome });
      row ? row.fail(`${item.title} — ${outcome.why}`) : warn(`${item.title} — ${outcome.why}`);
    }
  }
  const moved = restoreScripts(target, scriptsBefore);
  // Only worth asking if something actually landed.
  const broke = ready.length + pending.length > 0
    ? await verifyStillBuilds({ target, runner, installed: [...ready, ...pending] })
    : null;
  const added = agentFiles(target).filter((file) => !filesBefore.has(file));
  const set = envAlreadySet(target);
  const missingEnv = [...requiredEnvFrom(target, added)]
    .filter(([name]) => !set.has(name))
    .map(([name, file]) => ({ name, file }));
  return { ready, pending, failed, moved, broke, missingEnv };
}

async function runStep({ cwd, label, doing, done, command, args, verbose, whenFailed, explain }) {
  if (verbose) say(`  ${g.MARK} ${c.bold(label)} ${c.dim(doing)}`);
  const t = verbose ? null : task(label, doing);
  const result = await run(cwd, command, args, { verbose });
  if (result.ok) {
    if (t) t.done(done);
    else ok(done);
    return true;
  }
  // `explain` reads the failure and replaces the generic line when it recognises
  // one. It is given the chance BEFORE `whenFailed` is printed rather than after,
  // because a wrong sentence on screen is not repaired by a right one under it.
  const explained = explain?.(result.output) ?? null;
  if (t) t.fail(explained?.headline ?? whenFailed);
  else warn(explained?.headline ?? whenFailed);
  // `--verbose` streamed the child's output straight to the terminal, so there is
  // nothing captured to re-print; the explanation is still worth saying.
  printTail(result.output);
  for (const line of explained?.detail ?? []) dim(line);
  if (explained) blank();
  return false;
}

/**
 * The registry said no, and `docker compose logs dashboard` will not say so.
 *
 * A pull that fails leaves NO container, so the generic "the logs have the
 * reason" advice is not merely unhelpful here — it is wrong, and it sends the
 * reader to an empty output to look for an error that was on screen a moment
 * ago and scrolled. That mattered the day this was written: the tree pins
 * `0.4.0` and GHCR does not have it, so a project scaffolded from this tree
 * gets a bare `manifest unknown` and nothing to do about it.
 *
 * The repository's own docker-compose.yml survives an unpublished tag because it
 * carries `build:` alongside `image:`. A scaffolded project cannot: it holds no
 * dashboard source and no Dockerfile, so there is nothing for `build:` to point
 * at. What it CAN do is find a local build — Compose only pulls an image it does
 * not already have, and the repository's `build:` tags its result with exactly
 * the name this compose file names — so "build it in a clone, once" is a real
 * fallback and is the third option below.
 *
 * Narrow on purpose. A port conflict, a full disk and a dead daemon all fail
 * this same step, and answering any of them with a registry explanation would be
 * worse than the generic line. Only the registry's own vocabulary matches.
 *
 * Exported so test/bring-up.test.mjs can pin the strings without a daemon.
 */
const REGISTRY_REFUSALS = [
  "manifest unknown",
  "manifest for",
  "not found: name unknown",
  "pull access denied",
  "repository does not exist",
  "denied: denied",
  "requested access to the resource is denied",
  "unauthorized: authentication required",
];

export function dashboardPullFailure(output, image = DASHBOARD_IMAGE) {
  const haystack = String(output ?? "").toLowerCase();
  if (!REGISTRY_REFUSALS.some((phrase) => haystack.includes(phrase))) return null;
  return {
    headline: `could not be pulled — the registry has no ${image}`,
    detail: [
      "`docker compose logs dashboard` has nothing to show: the pull failed, so no",
      "container was ever created. Three ways forward, and the agent works without",
      "any of them:",
      "",
      `  1. Check whether the tag is really there:`,
      `       docker manifest inspect ${image}`,
      "",
      "  2. Point at a tag that is, in .env beside the compose file (NOT .env.local —",
      "     Compose interpolates from .env and the shell only):",
      `       EVESTACK_DASHBOARD_IMAGE=${image.replace(/:[^:]*$/, ":latest")}`,
      "",
      "  3. Build it once from a clone. The repository's own compose file carries",
      "     `build:` beside `image:` and tags the result with the same name this",
      "     project asks for, so this project then finds it locally with no further",
      "     configuration:",
      `       git clone ${REPO} && cd evestack`,
      "       docker compose build dashboard",
      "",
      "Then re-run: docker compose --profile dashboard up -d",
    ],
  };
}

/**
 * The three commands that have one correct answer, in the order they depend on
 * each other, stopping at the first failure.
 *
 * Exported, with `only: "database"` to stop after the schema, so that
 * test/bring-up.test.mjs can drive the real Docker path — the async spawn, the
 * progress rows, a container genuinely starting — without a 230 MB image pull
 * in CI. The first two steps need only the pgvector image the test already
 * requires; the third is the one that costs bandwidth.
 */
export async function bringUp(target, pm, dashboardPort, { verbose = false, only = null } = {}) {
  blank();
  if (
    !(await runStep({
      cwd: target, verbose, label: "postgres", command: "docker",
      args: ["compose", "up", "-d", "--wait", "postgres"],
      doing: "starting the container",
      done: "up, and accepting connections",
      whenFailed: "did not come up — the commands below will show you why",
    }))
  ) {
    return false;
  }

  if (
    !(await runStep({
      cwd: target, verbose, label: "schema", command: pm, args: ["run", "db:bootstrap"],
      doing: "creating the workflow tables",
      done: "workflow tables created",
      whenFailed: "not created — fix what is printed above, then re-run it",
    }))
  ) {
    return false;
  }

  if (only === "database") return true;

  // The one that takes real time on a cold machine: a ~230 MB pull.
  if (
    !(await runStep({
      cwd: target, verbose, label: "dashboard", command: "docker",
      args: ["compose", "--profile", "dashboard", "up", "-d", "--wait"],
      doing: `pulling ${DASHBOARD_IMAGE.split("/").pop()}`,
      done: `up on :${dashboardPort}`,
      whenFailed: "did not start — `docker compose logs dashboard` has the reason",
      // True for a container that started and died, and false for the one
      // failure that has no container at all. See dashboardPullFailure.
      explain: dashboardPullFailure,
    }))
  ) {
    // Not fatal, and said so: the agent is useful without the dashboard, and
    // stopping here would leave a working stack looking like a failed install.
    say(`  ${c.dim("Everything else is up — the agent works without it.")}`);
    return false;
  }
  return true;
}

/**
 * Which of the three Docker failures this is — not merely whether it works.
 *
 * `docker info` collapses "no docker binary", "daemon not running" and "socket
 * permission denied" into one exit code, so every one of them used to print
 * "Start Docker Desktop", which is the wrong instruction two thirds of the time
 * and on Linux or Colima three times out of three: it names an application the
 * reader does not have.
 *
 * `docker version` separates them, because the CLIENT half answers even when
 * the daemon does not. Measured on Docker 29.5.1: daemon up exits 0 with both
 * halves populated; daemon down exits 1 with the client half still populated
 * and the server half empty. A missing binary produces no output at all.
 * `docker info` cannot express that difference — there is no field in it that
 * survives a dead daemon.
 *
 * Returns a reason rather than a boolean so the caller can say the true thing.
 */
function dockerState() {
  const r = spawnSync("docker", ["version", "--format", "{{.Client.Version}}|{{.Server.Version}}"], {
    encoding: "utf8",
  });
  // ENOENT from spawn itself, or a shell that found nothing to run.
  if (r.error?.code === "ENOENT" || r.status === null) return "absent";
  const [client = "", server = ""] = (r.stdout ?? "").trim().split("|");
  if (r.status === 0 && server.trim() !== "") return "running";
  // The client answered and the server did not. That is a daemon that is down,
  // or a socket this user cannot open; `docker version` reports both the same
  // way, so the message names both rather than guessing between them.
  if (client.trim() !== "") return "daemon-down";
  return "absent";
}

/** Kept as the yes/no the call sites want, now derived from the reason. */
function hasDocker() {
  return dockerState() === "running";
}

function hasOllama() {
  return spawnSync("ollama", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * What is actually available from the local Ollama, asked over its HTTP API.
 *
 * `ollama list` would need the CLI to be the same install the agent will talk
 * to; the agent uses OLLAMA_BASE_URL, so this asks the same endpoint the agent
 * will. A tag matches with or without an explicit `:latest`, because `qwen3`
 * and `qwen3:latest` are the same model and the user may have pulled either
 * spelling.
 */
async function inspectOllama(chatModel, embedModel = "nomic-embed-text") {
  const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
  const result = {
    baseUrl,
    installed: hasOllama(),
    running: false,
    hasChatModel: false,
    hasEmbedModel: false,
  };
  try {
    const response = await fetch(new URL("/api/tags", baseUrl), {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return result;
    const body = await response.json();
    result.running = true;
    // Reaching the API proves Ollama is there even if its CLI is not on PATH —
    // a remote OLLAMA_BASE_URL, or a GUI install that never linked the binary.
    result.installed = true;
    const tags = new Set(
      (Array.isArray(body?.models) ? body.models : []).flatMap((m) =>
        typeof m?.name === "string" ? [m.name, m.name.replace(/:latest$/, "")] : [],
      ),
    );
    const has = (name) => tags.has(name) || tags.has(name.replace(/:latest$/, ""));
    result.hasChatModel = has(chatModel);
    result.hasEmbedModel = has(embedModel);
  } catch {
    // Not running, or not reachable. `running` stays false and the caller says so.
  }
  return result;
}

/**
 * Scaffold a project. Returns the process exit code.
 *
 * A return value rather than `process.exit`, because this is now called as a
 * library by `evestack create` as well as by this package's bin — and a
 * library that tears the process down cannot be tested or wrapped.
 */
export async function create(argv) {
  // Arguments first, and nothing at all before them.
  //
  // Neither --help nor --version was handled here, and src/cli.mjs routes `create`
  // before it parses anything, so `evestack create --help` fell through to the
  // wizard with no name to use: it took the default and scaffolded a project
  // literally called `my-agent`, then ran a package-manager install in it.
  const args = parseCreateArgs(argv);
  if (args.help) {
    say(CREATE_USAGE);
    return 0;
  }
  if (args.version) {
    say(packageVersion());
    return 0;
  }
  if (args.error) {
    console.error(`\n${C.red}${args.error}${C.reset}\n`);
    return 1;
  }

  // Non-interactive when asked for, or when stdin is not a terminal (CI, a
  // piped heredoc, a Dockerfile). Without this the process would reach EOF
  // mid-prompt and exit 0 having created nothing, which looks like success.
  const nonInteractive = args.yes || !process.stdin.isTTY;
  const positional = args.positional;

  const { ask, confirm, borrowStdin, closed, close } = await makePrompter(nonInteractive);

  wordmark({ big: true });
  blank();

  // Asked before the steps, and outside them, because it is not one of the
  // things the wizard needs to know — it is the question of whether the reader
  // wants to be asked them at all.
  const route = positional[0] ? ORIENT.SETUP : await orient({ ask, borrowStdin, nonInteractive });
  const guided = route === ORIENT.GUIDED;

  // Fetched once, up front, so the Channels step opens on a list instead of on
  // a spinner. Two seconds here is invisible; two seconds between a keypress
  // and a list is the whole feel of the thing.
  const catalog = await loadCatalog({ offline: nonInteractive });

  const ram = totalGb();
  const ctx = {
    name: positional[0] ?? null,
    target: null,
    model: null,
    channels: [],
    integrations: [],
    wantComposio: false,
    composioKey: "",
    wantStart: false,
    fatal: null,
    cancelled: false,
  };

  const byId = new Map([...catalog.channels, ...catalog.integrations].map((item) => [item.id, item]));
  const chosenChannels = () => ctx.channels.map((id) => byId.get(id)).filter(Boolean);
  const chosenIntegrations = () => ctx.integrations.map((id) => byId.get(id)).filter(Boolean);

  /** A registry row as a list option: what it is, and what it will ask you for. */
  const registryItems = (rows) =>
    rows.map((row) => {
      const badge = needsBadge(row);
      return option(row.title, row.id, { badge: badge.text, badgeColor: badge.color, note: row.note });
    });

  const steps = [
    {
      title: "Where",
      run: async () => {
        explain(guided, [
          "A new directory with the agent, a docker-compose.yml and the scripts that",
          "drive them. Nothing outside it is touched, and it is a git repo from the",
          "start — which is also the boundary of what eve copies into the sandbox.",
        ]);

        // A COLLISION IS NOT FATAL HERE, AND USED TO BE.
        //
        // `npx evestack create my-agent` against an existing directory printed
        // the wordmark, printed this step's header, then exited on a bare line:
        //
        //     /Users/…/my-agent already exists and is not empty.
        //
        // A wizard that has just drawn its first screen and has a prompter open
        // does not need to quit over a name. It asks for another one — and
        // offers a free one as the default, so recovering is one keystroke.
        //
        // The hard exit survives for the case that genuinely cannot be asked:
        // `--yes`, CI, a closed pipe. Same words, different ending.
        //
        // EXACTLY ONE `ask` PER PASS. The first draft asked at the top of the
        // loop and again at the bottom, so a rejected name prompted twice and
        // the second prompt discarded the first answer.
        let taken = ctx.name;
        let suggestion = freeNameNear("my-agent");
        for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
          const answer = taken ?? (await ask(`Project name? ${c.dim(`(${suggestion})`)}`, suggestion));
          taken = null;
          if (!answer || (closed() && !answer)) return CANCEL;

          const target = isAbsolute(answer) ? answer : resolve(process.cwd(), answer);
          const problem = targetProblem(target, inspectTarget(target));
          if (!problem) {
            ctx.name = answer;
            ctx.target = target;
            say(`    ${c.dim(`${g.arrow} ${shortPath(target)}`)}`);
            return undefined;
          }

          // Nobody to ask: `--yes`, CI, a pipe that closed. Fail with the words.
          if (nonInteractive || closed()) {
            ctx.fatal = `${problem.short}\n  ${problem.why}`;
            return CANCEL;
          }

          blank();
          warn(problem.short);
          dim(problem.why);
          suggestion = freeNameNear(basename(answer));
          dim(`${shortPath(resolve(process.cwd(), suggestion))} is free — press Enter to take it.`);
          blank();
        }
        ctx.fatal = "Too many names in a row were already taken.";
        return CANCEL;
      },
    },
    {
      title: "Model",
      run: async (_ctx, { first }) => {
        const model = await chooseModel({
          ask, closed, borrowStdin, nonInteractive, guided, ram, canBack: !first,
        });
        if (model === BACK) return BACK;
        if (model === CANCEL) return CANCEL;
        ctx.model = model;
        return undefined;
      },
    },
    {
      title: "Channels",
      get count() {
        return ctx.channels.length;
      },
      run: async () => {
        explain(guided, [
          "A channel is a way in: somewhere a person says something and the agent",
          "answers. Web Chat is self-contained; the rest connect an account you",
          "already have. Everything here is installed with `eve add`.",
        ]);
        const answer = await pick({
          question: "Where should people reach your agent?",
          hint: `Pick any number, or none. ${CATALOG_HINT}.`,
          items: registryItems(catalog.channels),
          multi: true,
          selected: new Set(ctx.channels),
          borrowStdin,
          nonInteractive,
          fallbackAsk: ask,
        });
        if (answer.back) return BACK;
        if (answer.cancelled) return CANCEL;
        ctx.channels = answer.values ?? [];
        return undefined;
      },
    },
    {
      title: "Integrations",
      get count() {
        return ctx.integrations.length;
      },
      run: async () => {
        explain(guided, [
          "Tools the agent can call: memory backends, a browser, a code host, a",
          "task tracker. These are the verbs — the channels above are the doors.",
        ]);
        const answer = await pick({
          question: "What should your agent be able to work with?",
          hint: `Optional. ${CATALOG_HINT}.`,
          items: registryItems(catalog.integrations),
          multi: true,
          selected: new Set(ctx.integrations),
          borrowStdin,
          nonInteractive,
          fallbackAsk: ask,
        });
        if (answer.back) return BACK;
        if (answer.cancelled) return CANCEL;
        ctx.integrations = answer.values ?? [];
        return undefined;
      },
    },
    {
      title: "Services",
      run: async () => {
        explain(guided, [
          "Postgres holds every session, memory and trace, so the agent survives a",
          "restart. The dashboard is a container that reads it and can drive the agent.",
          "Composio is one key for 1,000+ third-party toolkits.",
        ]);
        ctx.wantComposio = await confirm(
          `Enable tool sign-in via Composio? 1,000+ toolkits, the managed ones one click ${C.dim}(Gmail, Slack, Notion, Linear…)${C.reset}`,
          ctx.wantComposio || true,
        );
        if (ctx.wantComposio) {
          dim("Get a key at https://app.composio.dev — or press Enter to skip.");
          // Three tries and then on with the scaffold. This prompt was the one
          // place someone reliably stalled: the key lives behind a sign-up, so
          // the honest first answer is an empty line, and the old wizard took
          // that as final and wrote `COMPOSIO_API_KEY=` — a setting that looks
          // configured and is not.
          const { key } = await askKey({ ask, closed, label: "COMPOSIO_API_KEY", shape: /^ak_/ });
          ctx.composioKey = key;
        }

        const docker = dockerState();
        if (docker !== "running") {
          // Two different sentences, because they are two different problems and
          // the fix for one is not the fix for the other.
          if (docker === "absent") {
            warn("No `docker` command found, so this step is skipped — Postgres and the sandbox need it.");
            dim("Install Docker Engine, Docker Desktop, Colima or OrbStack, then run the commands printed at the end.");
          } else {
            warn("Docker is installed but its daemon is not answering, so this step is skipped.");
            dim("Start it (Docker Desktop, `colima start`, or `sudo systemctl start docker`) — or, if it IS running, check you can reach its socket: `docker version` says which half failed.");
          }
          ctx.wantStart = false;
        } else if (nonInteractive || !process.stdout.isTTY) {
          // In CI, in a heredoc, or under --yes, "shall I pull 230 MB" has
          // nobody to answer it, and a scaffolder that does it anyway is one
          // people stop running unattended.
          dim("Skipped: not an interactive terminal. The commands are printed at the end.");
          ctx.wantStart = false;
        } else {
          ctx.wantStart = await confirm(
            `Start Postgres, create the schema and pull the dashboard? ${C.dim}(~230 MB)${C.reset}`,
            true,
          );
          // If stdin died while the question was on screen — a terminal that
          // closed, a harness that fed its input and left — `confirm` hands back
          // its default, and the default here starts containers and pulls
          // 200 MB on behalf of nobody.
          if (closed()) {
            ctx.wantStart = false;
            dim("Skipped: stdin closed before this was answered.");
          }
        }
        return undefined;
      },
    },
    {
      title: "Review",
      run: async (_ctx, { last }) => {
        const channels = chosenChannels();
        const integrations = chosenIntegrations();
        const model = ctx.model;
        say(`  ${c.bold("Review your agent")}`);
        blank();
        const line = (label, value) => say(`    ${c.dim(pad(label, 14))}${value}`);
        line("Directory", shortPath(ctx.target));
        line("Model", `${model.model || model.id} ${c.dim(`(${model.id})`)}`);
        line("Channels", summarise(channels));
        line("Integrations", summarise(integrations));
        line("Composio", ctx.composioKey ? c.green("key set") : ctx.wantComposio ? c.yellow("enabled, no key yet") : c.dim("off"));
        line("Services", ctx.wantStart ? "Postgres, schema and dashboard, started now" : c.dim("not started — commands printed at the end"));

        // What will stop and ask for something, said BEFORE the install rather
        // than discovered during it. This is the whole reason `needs` is carried
        // through the catalogue.
        const asks = [...gated(channels), ...gated(integrations)];
        if (asks.length > 0) {
          blank();
          warn(`${asks.length} of these will ask for a credential: ${asks.map((a) => a.title).join(", ")}.`);
          dim("Anything that cannot be answered now is left for you, with the command to finish it.");
        }
        blank();

        const answer = await pick({
          question: "Ready?",
          items: [
            option("Install and finish setup", "go", { note: "writes the project, then installs what you picked" }),
            option("Back", "back", { note: "change any answer above" }),
          ],
          borrowStdin,
          nonInteractive,
          fallbackAsk: ask,
          canBack: true,
          canForward: false,
        });
        if (answer.cancelled) return CANCEL;
        if (answer.back || answer.value === "back") return BACK;
        return undefined;
      },
    },
  ];

  const outcome = await runSteps(steps, ctx);
  close();

  if (ctx.fatal) {
    console.error(`\n${C.red}${ctx.fatal}${C.reset}`);
    return 1;
  }
  if (outcome === CANCEL) {
    say();
    dim("Cancelled. Nothing was written.");
    return 130;
  }

  // The rest of this function still reads these names, and they are what the
  // steps above were collecting.
  const { target, model: chosen } = ctx;
  const useOllama = chosen.id === "ollama";
  const ollamaBaseUrl = chosen.ollamaBaseUrl ?? null;
  const apiKeyLine = chosen.apiKeyLine;
  const modelLine = chosen.modelLine;
  const wantComposio = ctx.wantComposio;
  const composioLine = wantComposio
    ? ctx.composioKey
      ? `COMPOSIO_API_KEY=${ctx.composioKey}`
      : "COMPOSIO_API_KEY="
    : "# COMPOSIO_API_KEY=ak_...";
  const wantStart = ctx.wantStart;
  // Re-read rather than carried from the Services step: minutes can pass between
  // that question and this line — the dependency install alone is a minute — and
  // Docker Desktop finishing its start in the meantime is the common case.
  const dockerUp = dockerState() === "running";

  // ---- scaffold -------------------------------------------------------------
  blank();
  rule();
  blank();
  // Guarded rather than left to throw. `npx create-evestack /etc/foo` reaches
  // here with nothing existing at the path and no permission to create it, and
  // index.mjs prints message-only — so an unguarded mkdirSync showed the user
  // `EACCES: permission denied, mkdir '/etc/foo'` and nothing else.
  try {
    mkdirSync(target, { recursive: true });
  } catch (error) {
    const code = error?.code ?? "unknown";
    console.error(
      `\n${C.red}Could not create ${target} — ${code}.${C.reset}\n` +
        (code === "EACCES" || code === "EPERM" || code === "EROFS"
          ? `  ${dirname(target)} is not writable by this user.\n` +
            `  Scaffold somewhere you own, e.g. ${shellQuote(join(process.cwd(), basename(target)))}.`
          : `  ${error?.message ?? error}`),
    );
    return 1;
  }
  const source = templateDir();
  cpSync(source, target, {
    recursive: true,
    filter: (src) => isTemplateFile(source, src),
  });

  // Shipped as `gitignore` because npm silently renames a packaged `.gitignore`
  // to `.npmignore`, so the file would never survive publish under its real
  // name. Restoring it here is what keeps a generated .env.local out of git.
  const ignoreSrc = join(target, "gitignore");
  if (existsSync(ignoreSrc)) {
    renameSync(ignoreSrc, join(target, ".gitignore"));
  }

  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) {
    // Reached only if the copy silently produced nothing. Say so here rather
    // than letting the next line die on an ENOENT that names the wrong file.
    console.error(
      `\n${C.red}The agent template did not copy — ${pkgPath} is missing.${C.reset}\n` +
        `  Template source: ${source}\n` +
        `  Please report this at ${REPO}/issues`,
    );
    return 1;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // Normalised, because a directory name is not an npm name. `npx
  // create-evestack "My Agent"` wrote `"name": "My Agent"` — capitals and a
  // space are both invalid — and npm then refused the install with
  // `Invalid name`, from a manifest the user never typed. projectNameFor a few
  // lines down had always normalised the same string for Compose.
  pkg.name = packageNameFor(target);
  pkg.private = true;
  delete pkg.description;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  done("project", shortPath(target));

  // Credentials are generated, never defaulted. eve fails closed on non-loopback
  // traffic, so a shipped default password would be the one thing standing
  // between a stranger and someone's agent.
  const password = randomBytes(18).toString("base64url");
  // The trace-ingest shared secret, generated for the same reason and one step
  // further: unlike the password, there is NO working value to fall back to.
  // The dashboard's `ingestAuthorized()` accepts this token or a session, and an
  // OTLP exporter cannot hold a session — so with the variable unset on both
  // sides every span POST is a 401. Worse, @vercel/otel treats a 401 as a
  // successful export (the fetch promise resolves), so the batch is dropped
  // silently and the dashboard just looks empty. A generated value is the only
  // configuration in which trace export works at all.
  //
  // Hex rather than the password's base64url: it is what the dashboard's own
  // docs tell you to paste (`openssl rand -hex 32`), and it is trivially safe to
  // carry in an HTTP header.
  //
  // ONE FILE FEEDS BOTH SIDES. The dashboard service in the docker-compose.yml
  // written below reads `env_file: .env.local` — this exact file — so the agent
  // on the host and the dashboard in the container read one variable from one
  // place and cannot drift. That is what lets the whole dashboard step be
  // `docker compose --profile dashboard up -d` with nothing to copy across.
  const ingestToken = randomBytes(32).toString("hex");
  // The database password, generated for exactly the reason stated above and
  // previously the one credential that was not.
  //
  // The compose file this writes used to carry `POSTGRES_PASSWORD: evestack`
  // and publish `"5433:5432"` — no interface prefix, so 0.0.0.0 — while pinning
  // the dashboard beside it to 127.0.0.1. Verified exploitable from another
  // machine on the same network: connecting to the LAN address on 5433 with
  // evestack/evestack returned rows. That database holds every prompt, tool
  // result and memory the agent has ever produced.
  //
  // Generating it fixed half of that. The other half: the generated value was
  // written INTO docker-compose.yml, twice — POSTGRES_PASSWORD and the
  // dashboard's WORKFLOW_POSTGRES_URL — and docker-compose.yml is a file this
  // scaffold means to be committed. The .gitignore it ships ignores .env and
  // .env.* and quite deliberately not the compose file, so the credential
  // generated because "a shipped default password would be the one thing
  // standing between a stranger and someone's agent" went into git on the first
  // `git add -A`, while the same password in .env.local was carefully ignored.
  // It is now written only to .env (below) and referenced from the compose file.
  //
  // base64url so it is safe unquoted in a URL, in a compose interpolation and in
  // an env file: the alphabet is [A-Za-z0-9_-] and contains no $, # or quote.
  const dbPassword = randomBytes(18).toString("base64url");

  // Ports are chosen against the machine, not assumed.
  //
  // `attach` has always done this; `create` hardcoded 5433 and 4000, which is
  // the wrong way round — `create` is the command someone runs first, and runs
  // twice. A second project, or a clone of this repo with its own compose file,
  // took the port and `docker compose up` failed halfway with
  // `Bind for 0.0.0.0:5433 failed: port is already allocated`, leaving a
  // container created but with nothing published. `docker compose ps` then
  // says "healthy" while the port is missing, so the failure surfaces one
  // command later as a raw ECONNREFUSED out of a migration library.
  const pgPort = await freePort(5433);
  const dashboardPort = await freePort(4000);
  // The agent's port is PINNED, not discovered.
  //
  // `eve dev` takes 2000 and silently auto-increments when it is busy, and
  // nothing recorded where it landed — so the compose file below pointed the
  // dashboard at a hardcoded :2000 and `verify` probed 2000..2004 and believed
  // the first answer. With two projects up, the second project's dashboard
  // drove the FIRST project's agent: real runs, started in the wrong place,
  // with nothing anywhere saying so. Recording the port turns three guesses
  // into one fact.
  const agentPort = await freePort(2000);
  // 0600, not the umask. Everything below the "Route auth" heading is a live
  // credential, and this file measured -rw-r--r-- before — see writeSecretFile()
  // for the reading and for why that matters more than the .gitignore does.
  const envLocalWarning = writeSecretFile(
    join(target, ".env.local"),
    [
      "# evestack — generated. Never commit this file.",
      "",
      "# Model provider",
      apiKeyLine,
      modelLine,
      "",
      "# The port the agent listens on. `npm run dev` passes it to eve, the",
      "# dashboard container is pointed at it, and `evestack verify` reads it —",
      "# so a second project on this machine cannot be mistaken for this one.",
      `EVESTACK_AGENT_PORT=${agentPort}`,
      "",
      "# Durable sessions (docker compose provides this Postgres)",
      `WORKFLOW_POSTGRES_URL=postgres://evestack:${dbPassword}@127.0.0.1:${pgPort}/evestack`,
      "WORKFLOW_POSTGRES_MAX_POOL_SIZE=20",
      "WORKFLOW_POSTGRES_WORKER_CONCURRENCY=20",
      "",
      "# Route auth — generated for this project. Also the dashboard sign-in.",
      "EVESTACK_AUTH_USER=evestack",
      `EVESTACK_AUTH_PASSWORD=${password}`,
      "",
      "# Dashboard trace export",
      `EVESTACK_DASHBOARD_URL=http://127.0.0.1:${dashboardPort}/api/ingest/v1/traces`,
      "# Read by BOTH halves: the agent sends it as the x-evestack-ingest-token",
      "# header, and the dashboard container gets it from this same file via",
      "# `env_file:` in docker-compose.yml. Change it in one place or neither —",
      "# a mismatch is a 401 on every span, which looks like 'no traces yet'.",
      `EVESTACK_INGEST_TOKEN=${ingestToken}`,
      "",
      "# Integrations",
      composioLine,
      "",
    ].join("\n"),
  );
  done("credentials", ".env.local — a unique auth password and trace-ingest token");
  if (envLocalWarning) warn(envLocalWarning);

  // Compose only accepts [a-z0-9][a-z0-9_-]* as a project name, and a directory
  // name is not constrained to that — so normalise rather than emit a file that
  // fails to parse.
  //
  // THE SUFFIX IS THE POINT. Compose treats `name:` as the project identity, so
  // two directories that normalise to the same name are ONE project: the second
  // `docker compose up` recreates the first one's containers and both agents
  // then read one database, with nothing anywhere saying so.
  //
  // This used to be the bare basename, which fixed an earlier collision against
  // the literal string "evestack" and left the far likelier one wide open —
  // `my-agent` is the DEFAULT name, so two default scaffolds collide by default.
  // Observed on this machine: ~/evestack-trial/my-agent and
  // ~/evestack-stranger/my-agent, with the surviving container reporting
  // `com.docker.compose.project.working_dir` pointing at the second directory.
  // One agent's sessions, memories and traces were in the other's database.
  //
  // Hashing the ABSOLUTE PATH rather than counting upwards keeps the name stable
  // for a given directory — it has to be, or every `docker compose` in that
  // project would address a different stack than the last one did.
  const composeProject = projectNameFor(target);

  // The database password, in the one file Compose will read it from.
  //
  // This is the distinction the leak turned on, so it is worth stating exactly:
  // `env_file:` on a service sets variables INSIDE that container, while
  // `${...}` in the compose file is INTERPOLATION, resolved on the host before
  // the file is parsed — and interpolation reads the shell and `.env`, and never
  // .env.local. Verified both ways against Compose v5.1.3: `${VAR:?msg}` filled
  // from this .env initialises Postgres with that password (a wrong password
  // over TCP from another container is refused with `password authentication
  // failed`), and the same reference with the value only in .env.local fails the
  // parse outright with `required variable ... is missing a value`.
  //
  // So POSTGRES_PASSWORD and the dashboard's in-container connection string are
  // both interpolated from here. docker-compose.yml stays committable and
  // carries no secret; this file and .env.local are both ignored by the
  // .gitignore written above.
  // 0600 for the same reason .env.local is: git ignores this file, and the mode
  // is what stops the account at the next desk reading it out of the filesystem.
  const envWarning = writeSecretFile(join(target, ".env"), composeEnvFile(dbPassword));
  done("database", ".env — the generated password, read by Compose, ignored by git");
  if (envWarning) warn(envWarning);

  writeFileSync(join(target, "docker-compose.yml"), composeFile(composeProject, { pgPort, dashboardPort, agentPort }));
  done("compose", "docker-compose.yml — Postgres, dashboard behind a profile");

  // A git repository, because eve decides what to copy by walking up from here.
  //
  // eve/dist/.../dev-runtime-source-snapshot.js resolves the DEV SOURCE ROOT by
  // walking parents until it finds `.git` or `pnpm-workspace.yaml`, and then
  // copies that root's package.json, lockfiles and .npmrc into
  // .eve/dev-runtime/snapshots/<id>/source/. A scaffold with no .git of its own
  // therefore inherits whichever directory above it has one — and for anyone who
  // keeps their dotfiles in git, that is $HOME.
  //
  // Measured on a real scaffold before this line existed: three byte-identical
  // copies of the user's ~/.npmrc, registry credential and all, sitting under
  // .eve/ in a project directory they had no reason to look in. Same sha1 as the
  // original. It is gitignored and it never leaves the machine, and it is still a
  // credential copied somewhere nobody asked for. The same resolution is what
  // made eve's dev watcher rebuild the project whenever an unrelated dotfile in
  // $HOME changed.
  //
  // The resolver stops at the FIRST marker it finds, so a .git here ends the walk
  // whatever is above it — including inside another checkout, which is exactly
  // the case that would otherwise keep the bug.
  //
  // `git init` and no commit. A commit needs user.name and user.email, which a
  // fresh machine does not have, and it would run whatever commit.gpgsign points
  // at — a signing agent that puts up a prompt turns a scaffolder into a hang.
  // The empty repository is the whole of what the fix needs.
  const git = await run(target, "git", ["init", "-q"]);
  const initialised = git.ok && existsSync(join(target, ".git"));
  initialised
    ? done("git", ".git — an empty repo, and the boundary of what eve copies")
    : warnNoGit();

  // ---- install --------------------------------------------------------------
  const pm = detectPm();
  const installing = args.verbose ? null : task("install", `${pm} install`, { labelWidth: 13 });
  if (args.verbose) say(`  ${g.MARK} ${c.bold("install")} ${c.dim(`${pm} install`)}`);
  // The row above proves the process is alive; this says what it is waiting on.
  // Off a TTY the spinner does not animate at all, so there the same notes are
  // printed as their own lines — a CI log that goes quiet for two minutes has
  // the same problem, and some runners kill the job over it.
  const live = color && process.stdout.isTTY;
  const stopWatching = installing
    ? watchInstall(pm, (note) => (live ? installing.update(note) : dim(note)))
    : null;
  // `shell` on Windows for the reason run() states: npm/pnpm/yarn/bun are `.cmd`
  // shims there and a bare spawn cannot execute them, so every Windows run ended
  // at "Created, but dependencies are not installed" and exit 1. Not verified on
  // Windows from here — this matches what the template's own scripts already do.
  const install = await run(target, pm, ["install"], { verbose: args.verbose });
  stopWatching?.();
  // A failed install leaves an empty node_modules, and the steps below would
  // then fail one after another with unrelated-looking errors. Report it as the
  // failure it is — including the exit code, so CI and shell `&&` chains stop
  // here instead of proceeding on a project that cannot run.
  const installed = install.ok && existsSync(join(target, "node_modules", "eve"));
  if (installed) {
    if (installing) installing.done("dependencies installed");
    else ok("Dependencies installed");
  } else if (installing) {
    installing.fail("failed — the project exists, but it cannot run yet");
    printTail(install.output);
  }

  // localhost, not 127.0.0.1, because this one is for a human to click.
  const dashboardUrl = `http://localhost:${dashboardPort}`;

  if (!installed) {
    blank();
    say(`  ${c.yellowBold("Created, but dependencies are not installed.")}`);
    // WHICH failure it was decides whether running the command again is worth
    // anything, and the tail printed above is npm's wording, not an explanation.
    if (looksLikeANetworkFailure(install.output)) {
      const where = (await registryHost(pm)) ?? `whichever registry ${pm} is set to`;
      blank();
      say(`  ${c.bold("That failure is the network, not the template.")}`);
      dim(`The install was talking to ${where}.`);
      dim("A VPN, a proxy that filters npm, or a private mirror that does not carry");
      dim("these packages all look exactly like this. Check which one is in play:");
      say(`    ${c.bold(`${pm} config get registry`)}`);
    }
    blank();
    say(`  ${c.bold("Finish it")}`);
    // Quoted: a project called "My Agent" printed `cd My Agent`, which is two
    // arguments and a command that does not work.
    say(`    ${c.bold(`cd ${shellQuote(basename(target))} && ${pm} install`)}`);
    blank();
    dim("If the install failed on a 404 for @evestack/composio, that package is not");
    dim("published yet. Drop it from package.json and delete agent/tools/composio.ts —");
    dim("everything else in the template works without it.");
    blank();
    return 1;
  }

  // ---- what was picked ------------------------------------------------------
  //
  // After the dependency install, because `eve add` runs the project's own eve
  // and there is no `node_modules/.bin/eve` until the install has finished.
  const wanted = [...chosenChannels(), ...chosenIntegrations()];
  const { ready, pending, failed, moved, broke, missingEnv } = await addRegistryItems({ target, items: wanted, verbose: args.verbose });

  // ---- bring it up ----------------------------------------------------------
  //
  // Two of these are pure setup with one correct answer and the third is a pull;
  // none needs a decision, all of them fail in ways that are hard to read, and
  // every one is a chance for a first-timer to stop. The question was asked in
  // step 4, before the install, so this part needs nobody at the keyboard.
  let up = false;
  if (wantStart) {
    up = await bringUp(target, pm, dashboardPort, { verbose: args.verbose });
  }

  // ---- what you have --------------------------------------------------------
  blank();
  rule();
  blank();
  architecture({
    agentPort, pgPort, dashboardPort, provider: chosen.id, model: chosen.model, up, ollamaBaseUrl,
  });
  blank();
  say(`  ${c.bold("Dashboard")}   ${c.brandBold(dashboardUrl)}`);
  say(`  ${c.bold("Sign in")}     evestack ${c.dim("/")} ${c.bold(password)}`);
  say(`  ${c.dim("Both are in .env.local, which the dashboard container reads too.")}`);
  say(`  ${c.dim("`npx evestack open` prints them again — this terminal will scroll.")}`);
  blank();

  if (!useOllama && apiKeyLine.endsWith("=")) {
    say(`  ${c.yellowBold(`Add ${chosen.keyVar} to .env.local before you start.`)}`);
    blank();
  }

  const cd = shellQuote(basename(target));
  if (!up) {
    // The manual list, printed only when something is genuinely left to do.
    say(`  ${c.bold("Next")}`);
    say(`    ${c.bold(`cd ${cd}`)}`);
    if (!dockerUp) say(`    ${c.dim("start Docker Desktop")}`);
    say(`    ${c.bold("docker compose up -d postgres")}              ${c.dim("# durable sessions")}`);
    // `npx --package=@workflow/world-postgres bootstrap` looks equivalent and is
    // not: its CLI loads `.env` via dotenv and never reads `.env.local`, so it
    // silently falls back to postgres://world:world@localhost:5432/world and dies
    // on ECONNREFUSED. The script wires the generated .env.local in explicitly.
    say(`    ${c.bold(`${pm} run db:bootstrap`)}                        ${c.dim("# create the workflow schema")}`);
    say(`    ${c.bold("docker compose --profile dashboard up -d")}   ${c.dim(`# the dashboard on :${dashboardPort}`)}`);
    say(`    ${c.bold(`${pm} run dev`)}                                ${c.dim("# the agent")}`);
    blank();
    say(`  ${c.dim("Then `npx evestack status` from anywhere inside the project.")}`);
    reportPicked({ ready, pending, failed, moved, broke, missingEnv, pm });
    blank();
    return 0;
  }

  // Everything but the agent is up, and the agent is a foreground process that
  // belongs to this terminal. Offering to start it is the difference between
  // finishing with a running stack and finishing with one more thing to paste.
  say(`  ${c.bold("One command left")}`);
  say(`    ${c.bold(`cd ${cd} && ${pm} run dev`)}`);
  blank();
  say(`  ${c.dim("Then, in another terminal:")} ${c.bold("npx evestack tour")} ${c.dim("— a guided first run.")}`);
  reportPicked({ ready, pending, failed, moved, broke, missingEnv, pm });
  blank();

  if (await confirmRunAgent(cd)) {
    say(`  ${c.dim(`${g.arrow} ${pm} run dev  ·  Ctrl-C stops it. Your data stays in Postgres.`)}`);
    blank();
    // stdio inherited: eve's dev UI, its colours and its TTY detection are all
    // exactly as they would be if it had been typed. This process becomes a
    // passthrough, and its exit code becomes eve's.
    const dev = spawnSync(pm, ["run", "dev"], {
      cwd: target,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return dev.status ?? 0;
  }
  // Said once, here, because the split is the reason nothing in this project has
  // to be scrubbed before it is pushed.
  dim("docker-compose.yml is safe to commit: the credentials are in .env and .env.local,");
  dim("both of which the generated .gitignore ignores.");
  blank();
  say(`  ${c.dim("Nothing here bills you. No Vercel account, no metered compute.")}`);
  blank();
  return 0;
}

/**
 * The four moving parts, and which of them ever leaves the machine.
 *
 * This is the piece of teaching the scaffolder never did. It finished by
 * printing a list of commands, which tells someone what to type and nothing
 * about what they now have — and evestack is three local processes on three
 * ports plus a model, which is exactly the shape that a paragraph fails to
 * explain and a six-line picture does not. Whether that model call leaves the
 * machine depends on the provider — it does for OpenAI and Anthropic, and does
 * not for Ollama, which listens on 127.0.0.1:11434 — which is what modelEdge
 * below is for.
 *
 * Drawn with the ports this project actually chose, not the defaults: on a
 * machine already running one scaffold these are 2001, 5434 and 4001, and a
 * diagram that lied about that would be worse than none.
 */
function architecture({ agentPort, pgPort, dashboardPort, provider, model, up, ollamaBaseUrl = null }) {
  const port = (n) => c.brand(`:${n}`);
  // Running state as a glyph at the head of the row rather than a "not started"
  // suffix: the suffix pushed the two container rows past the frame, and a
  // status is a thing you scan down a column for anyway.
  const dot = (running) => (running ? c.green(g.dot) : c.dim(g.dot));
  const part = (running, name, p, what) =>
    `  ${dot(running)} ${c.bold(padTo(name, 11))}${port(p)}   ${c.dim(what)}`;

  say(`  ${g.MARK} ${c.bold("your machine")}`);
  box(
    [
      // The agent is never running at this point — it is the command that comes
      // next — so it is drawn in the same "not yet" state as the containers when
      // they were skipped.
      part(false, "agent", agentPort, `${detectPm()} run dev — your terminal`),
      `      ${c.dim(g.pipe)}`,
      `      ${c.dim(`${g.down}  writes every turn`)}`,
      part(up, "postgres", pgPort, "docker — sessions, memory, traces, cost"),
      `      ${c.dim(g.up)}`,
      `      ${c.dim(`${g.pipe}  reads, and drives the agent`)}`,
      part(up, "dashboard", dashboardPort, "docker — open this one"),
    ],
    { indent: 4, inner: 64 },
  );
  say(`      ${c.dim(g.pipe)}`);
  // This line used to end "the only thing that leaves this machine" for every
  // provider, which is true for OpenAI and Anthropic and FALSE for Ollama — that
  // runs on 127.0.0.1:11434 and nothing leaves at all. It undersold the $0
  // path's best property at the moment someone first reads it. modelEdge is the
  // branch that fixes it; the copy pass anticipated exactly this shape.
  say(
    `      ${c.dim(`${g.bl}${g.bar}${g.arrow}`)} ${c.bold(provider)} ` +
      `${c.dim(modelEdge(provider, model, ollamaBaseUrl))}`,
  );
  // Always, not `if (!up)`. The agent is never running at this point — it is the
  // command that comes next — so there is a dim dot on screen even on the fully
  // successful path, and a live run showed it there with nothing to explain it.
  say(`      ${c.dim(`${g.dot} dim = not started yet`)}`);
}

/**
 * The last line of the diagram: where the model is, and whether reaching it
 * leaves the machine.
 *
 * It read "the only thing that leaves this machine" for every provider. On the
 * Ollama path that is false — ollama is a local process on 127.0.0.1:11434, and
 * a live run of the whole stack opened zero non-loopback sockets — so the free,
 * fully local option, the one the product leads with, was the single place the
 * diagram undersold it. Two of the three providers really do leave the machine,
 * which is exactly why this branches rather than being softened into a sentence
 * that is true of both.
 *
 * The third branch is not hypothetical either: OLLAMA_BASE_URL is a supported
 * setting (templates/default/.env.example, docs/local-setup.mdx) and pointing it
 * at another host is the one Ollama configuration where traffic does leave.
 * Claiming otherwise would be this same bug again, in the other direction.
 *
 * THE WORDING IS NOT OWNED HERE. These strings are placeholders pending the copy
 * pass; the branch is the part this file is responsible for. One constraint on
 * whatever replaces them: the line is printed as six spaces, an arrow, the
 * provider name and then this, so anything past about 60 characters wraps on an
 * 80-column terminal. The test beside this pins that budget.
 */
export function modelEdge(provider, model, localBaseUrl = null) {
  // Two providers are decided by their URL rather than by their name. Ollama is
  // loopback by default and remote if someone pointed it at a server; an
  // OpenAI-compatible endpoint is the reverse — usually remote (Groq, Together)
  // and local when it is LM Studio or llama.cpp on this desk. Neither can be
  // answered from the provider id alone, which is why the URL is the input.
  const decidedByUrl = provider === "ollama" || provider === "compatible";
  if (!decidedByUrl) return `${model} — the only thing that leaves this machine`;
  const url = localBaseUrl || "http://127.0.0.1:11434";
  const where = hostOf(url);
  if (!isLoopback(url)) return `${model} — on ${where}, which does leave this machine`;
  return `${model} — on ${where}; nothing leaves this machine`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * IPv6 arrives bracketed from URL.host and bare from URL.hostname; 0.0.0.0 as a
 * destination means this machine everywhere this runs. Anything unparseable is
 * treated as remote, because the claim being guarded is the one to be earned.
 */
function isLoopback(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
}


/**
 * Said out loud, because the consequence is not one anybody would guess: with no
 * .git in the project, eve walks up and treats the nearest directory that has
 * one as the source root, then copies that directory's package.json, lockfiles
 * and .npmrc into .eve/. On a machine whose dotfiles are in git, that is $HOME.
 */
function warnNoGit() {
  warn("git init did not run — is git installed? This project has no .git.");
  dim("Create one before `npm run dev`. Without it eve walks up to the nearest");
  dim("directory that has one and copies that directory's .npmrc into .eve/.");
}

/**
 * Offer to hand this terminal to the agent.
 *
 * The last line of the old output was `npm run dev`, to be copied into a shell
 * that had just been told four other things. It is the only remaining step, it
 * has one correct answer, and the reason it was never automated is that it runs
 * in the foreground — which is an argument for asking, not for refusing.
 *
 * Never in CI or a pipe: a scaffolder that blocks forever holding a foreground
 * process is a broken CI step.
 */
async function confirmRunAgent(cd) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { confirm, closed, close } = await makePrompter(false);
  const yes = await confirm(
    `Start it now? ${C.dim}(holds this terminal — or run \`cd ${cd}\` and start it yourself)${C.reset}`,
    true,
  );
  // A default taken from a dead stdin must not spawn a foreground process
  // and take the terminal with it. Same defect as the question above.
  const answered = yes && !closed();
  close();
  return answered;
}

// Build leftovers and secrets that must never reach a generated project.
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  ".eve",
  ".output",
  ".next",
  "dist",
  ".env.local",
  "tsconfig.tsbuildinfo",
]);

/**
 * Decide whether a template path is copied.
 *
 * Exported because scripts/sync-template.mjs needs exactly this decision when it
 * copies templates/default into the package before publish, and had its own
 * substring-against-the-absolute-path version of it — the bug below, one step
 * earlier in the pipeline, where it copied nothing and then died on an ENOENT for
 * the manifest.
 *
 * Matched against the path *relative to the template root*, one segment at a
 * time. Testing the absolute path instead — which this did — silently copies
 * nothing under `npx`, because npm stages the package at
 * `~/.npm/_npx/<hash>/node_modules/create-evestack/template/…` and every source
 * path therefore contains `node_modules`. Substring matching had the same class
 * of bug for anyone whose project lived under a directory named `dist`.
 */
export function isTemplateFile(templateRoot, src) {
  const rel = relative(templateRoot, src);
  if (rel === "") return true; // the template root itself
  return !rel.split(sep).some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

/**
 * What is already at the target path, in the shapes that need different answers.
 *
 * The guard used to be `existsSync(target) && readdirSafe(target).length > 0`,
 * and readdirSafe returned [] for anything it could not read. On a FILE that is
 * ENOTDIR, so the guard decided the path was empty enough and mkdirSync then
 * threw `EEXIST: file already exists, mkdir '/path/README.md'` — an errno, and
 * index.mjs prints message-only, so that errno was the entire explanation the
 * user got for pointing at a file. EACCES on a directory had the same shape.
 *
 * `readdirSync`, not a shell — the reason survives from readdirSafe: this once
 * ran `ls -A ${JSON.stringify(p)}` through execSync, and JSON.stringify is not a
 * shell quoter. It escapes `"` and `\` and leaves `$` alone, and `$(…)` and
 * backticks expand inside double quotes, so `npx create-evestack '$(touch
 * pwned)'` executed that command before the wizard printed its first question.
 * readdirSync takes the path as a path and cannot be talked into anything else.
 */
function inspectTarget(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", code: error?.code ?? "unknown" };
  }
  if (!stats.isDirectory()) return { kind: "file" };
  try {
    return { kind: "directory", entries: readdirSync(path) };
  } catch (error) {
    return { kind: "unreadable", code: error?.code ?? "unknown" };
  }
}

/**
 * The flags `create` accepts, and why an unknown one is now refused.
 *
 * The whole parser was `argv.filter((a) => !a.startsWith("-"))`. It dropped a
 * flag it did not recognise and KEPT the value that followed it, so the value
 * became the directory name. Verified: `npx create-evestack --port 5000` created
 * a directory called `5000`, `--template minimal` created `minimal`, and
 * `my-agent --dry-run` — a flag that exists on `attach` and is advertised two
 * lines away in the shared usage — scaffolded for real and then offered to start
 * containers. `-my-agent` was discarded entirely and the wizard asked for a name
 * it had just been given.
 *
 * A name is not a place to put an argument nobody parsed, so every flag is now
 * either known or an error, and `--` ends the options for the rare directory
 * that really is called `--help`.
 */
const CREATE_FLAGS = new Map([
  ["--yes", "yes"], ["-y", "yes"],
  ["--verbose", "verbose"],
  ["--help", "help"], ["-h", "help"],
  ["--version", "version"], ["-V", "version"],
]);

/** Flags that are real somewhere else, so the error can say where. */
const FLAGS_ELSEWHERE = new Map([
  ["--dry-run", "attach"],
  ["-n", "attach"],
  ["--json", "verify"],
  ["--open", "verify"],
  ["--no-open", "verify and open"],
  ["--sql", "doctor"],
  ["--verbose", "doctor"],
]);

export const CREATE_USAGE = `evestack create — scaffold a new self-hosted eve agent

  npx create-evestack [name] [--yes]
  evestack create [name] [--yes]

Creates the directory, copies the agent template into it, generates this
project's credentials into .env.local and .env, writes a docker-compose.yml for
Postgres plus the dashboard, and installs dependencies.

Options
  --yes, -y       take every default and ask nothing. Implied when stdin is not
                  a terminal — CI, a heredoc, a Dockerfile. It also declines to
                  start containers, because nobody is there to say no
  --verbose       show the raw npm and docker output instead of one line each
  --help, -h      this
  --version, -V   print create-evestack's version

An existing non-empty directory is refused, never merged into. To scaffold into
a directory whose name starts with a dash, end the options first:

  npx create-evestack -- --weird-name
`;

export function parseCreateArgs(argv) {
  const parsed = { positional: [], yes: false, verbose: false, help: false, version: false, error: null };
  let endOfFlags = false;
  for (const arg of argv) {
    if (endOfFlags || !arg.startsWith("-")) {
      if (!endOfFlags && arg === "-") {
        parsed.error = unknownFlag(arg);
        return parsed;
      }
      parsed.positional.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      continue;
    }
    const key = CREATE_FLAGS.get(arg.split("=")[0]);
    // `--yes=true` is not a flag this takes a value for either: refuse rather
    // than silently accept a value that changes nothing.
    if (!key || arg.includes("=")) {
      parsed.error = unknownFlag(arg);
      return parsed;
    }
    parsed[key] = true;
  }
  if (parsed.positional.length > 1) {
    parsed.error =
      `create takes one directory name, and got ${parsed.positional.length}: ` +
      `${parsed.positional.map((p) => JSON.stringify(p)).join(", ")}.\n` +
      "  Nothing was created. Quote a name with spaces in it.";
  }
  return parsed;
}

function unknownFlag(flag) {
  const name = flag.split("=")[0];
  const lines = [`Unknown option ${JSON.stringify(flag)} — nothing was created.`];
  const elsewhere = FLAGS_ELSEWHERE.get(name);
  if (elsewhere) {
    lines.push(`  ${name} is a flag on \`${elsewhere}\`, not on \`create\`.`);
  }
  // The `-my-agent` case: what was meant is almost certainly a directory name.
  if (/^-[^-]/.test(name) && name.length > 2) {
    lines.push(`  To scaffold into a directory called ${JSON.stringify(flag)}:`);
    lines.push(`    npx create-evestack -- ${shellQuote(flag)}`);
  }
  lines.push("", "  create takes one directory name and:", "    --yes, -y      accept every default and ask nothing",
    "    --help, -h     the full usage", "    --version, -V  print the version");
  return lines.join("\n");
}

/**
 * The generated project's npm manifest name.
 *
 * A directory name is not an npm name: capitals, spaces and a leading dot are
 * all legal in one and rejected by the other. This was the bare basename, so
 * `npx create-evestack "My Agent"` wrote `"name": "My Agent"` and npm refused
 * the install it went on to run — from a manifest the user never typed, three
 * screens after the mistake. projectNameFor below had always normalised the same
 * string for Compose; this is the same idea against npm's rules.
 */
export function packageNameFor(target) {
  const slug = basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "")
    .slice(0, 214);
  return slug || "agent";
}

/**
 * The Compose project name for a scaffolded directory.
 *
 * Exported so test/compose.test.mjs asserts THIS derivation rather than its own
 * copy of it — a collision test that re-implements the hashing would keep
 * passing after the real one changed.
 */
export function projectNameFor(target) {
  const slug =
    basename(target).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "") ||
    "evestack";
  return `${slug}-${createHash("sha256").update(target).digest("hex").slice(0, 6)}`;
}

/**
 * The one variable the compose file reads from `.env`.
 *
 * Exported so a test asserts the compose file and the generated `.env` agree on
 * the name — a compose file interpolating a variable nothing writes fails at
 * parse time with `required variable ... is missing a value`, and a `.env`
 * writing a variable nothing reads is a password sitting in a file for no
 * reason.
 */
export const DB_PASSWORD_VAR = "EVESTACK_DB_PASSWORD";

/**
 * The `.env` beside the compose file: the database password, and nothing that is
 * not needed to start the stack.
 *
 * Exported so the same string a scaffold gets is the string a test checks — a
 * test that rebuilt this content would keep passing while the real file drifted
 * back into the compose file.
 */
export function composeEnvFile(dbPassword) {
  return [
    "# evestack — generated. Read by `docker compose`, and never committed.",
    "",
    "# Compose interpolates ${...} in docker-compose.yml from this file (or the",
    "# shell) and from nowhere else — it does not read .env.local. That is the whole",
    "# reason this file exists: docker-compose.yml is meant to be committed, so the",
    "# database password cannot be in it.",
    `${DB_PASSWORD_VAR}=${dbPassword}`,
    "",
    "# The agent gets the same password from WORKFLOW_POSTGRES_URL in .env.local,",
    "# because it runs on the host and connects over the published port. Rotate it in",
    "# both files together, and remember that Postgres only applies POSTGRES_PASSWORD",
    "# when the data volume is first created — `docker compose down -v` (which deletes",
    "# the sessions) is what makes a new password take effect.",
    "",
    "# To run your own dashboard image instead of the published one:",
    `# EVESTACK_DASHBOARD_IMAGE=${DASHBOARD_IMAGE}`,
    "",
    // Written commented-out so the names are discoverable from the file Compose
    // actually reads. The defaults are in docker-compose.yml's `x-logging`
    // anchor — 10 MB × 3 files per container — and they exist because Docker's
    // json-file driver rotates nothing by default while both services here are
    // `restart: unless-stopped`. Unprefixed on purpose: an EVESTACK_* name would
    // claim the app reads it, and Compose consumes both of these on the host
    // before a container exists.
    "# The container log ceiling, per container. Compose reads these from here.",
    "# LOG_MAX_SIZE=10m",
    "# LOG_MAX_FILE=3",
    "",
  ].join("\n");
}

export function composeFile(projectName, { pgPort = 5433, dashboardPort = 4000, agentPort = 2000 } = {}) {
  // The compose project name has to be unique to this DIRECTORY PATH, not to its
  // name. Compose treats `name:` as the project identity, so two scaffolds — or
  // one scaffold plus a cloned evestack repo — become the SAME project: the
  // second `docker compose up` recreates the first one's container and both
  // agents silently share one database. Observed twice, most recently with two
  // directories both called `my-agent`, which is the DEFAULT name.
  //
  // The trade this makes, stated because the generated file says it too: the
  // name is derived from the absolute path, so MOVING the project directory
  // gives it a new identity and Compose no longer recognises the old containers
  // and volume. That is visible and recoverable — `docker compose up -d` makes
  // fresh ones, and the old volume is still there to copy out of. Sharing a
  // database with an unrelated agent is neither.
  //
  // NO SECRET IN THIS FILE. It used to carry the generated database password
  // twice — POSTGRES_PASSWORD, and the dashboard's WORKFLOW_POSTGRES_URL — and
  // this is the one generated file the scaffold means you to commit: the
  // .gitignore it writes covers .env and .env.*, deliberately not this. So the
  // password that exists because "a shipped default would be the one thing
  // standing between a stranger and someone's agent" was committed by the first
  // `git add -A`. Both references are now `${...}`, which Compose interpolates
  // from `.env` on the host before parsing, and `.env` is ignored.
  //
  // `:?` rather than `:-`: a missing password must stop the command, not start a
  // Postgres with an empty one. Compose prints the text after `?` verbatim.
  //
  // The dashboard sits behind a profile so a plain `docker compose up -d` starts
  // Postgres alone — the agent is useful without the dashboard, and pulling a
  // ~230 MB image is not something to do to someone who only asked for a
  // database.
  const password = `\${${DB_PASSWORD_VAR}:?missing — it belongs in the .env file beside this one}`;
  return `# evestack — your whole stack, on your machine, for $0.
#
# The "name:" line below is this directory's identity to Docker Compose, and it
# carries a hash of the directory's full path so that two projects with the same
# folder name cannot silently share one database. Move this directory and Compose
# will not recognise the containers and volume it made here — bring them up again
# and copy out of the old volume if you need what was in it.
#
#   docker compose up -d postgres              durable sessions
#   docker compose --profile dashboard up -d   + the dashboard on :${dashboardPort}
#
# THIS FILE IS SAFE TO COMMIT, and that is the reason ${DB_PASSWORD_VAR} appears
# below instead of the password itself. Compose fills those in from the .env file
# beside this one, which the generated .gitignore ignores along with .env.local.
# Keep it that way: a password pasted in here goes into git the next time anyone
# runs \`git add -A\`, and the database it opens holds every prompt, tool result
# and memory this agent has produced.
#
# The dashboard is a pull, not a build. To run your own image instead — a local
# build, a fork, a private registry — set EVESTACK_DASHBOARD_IMAGE in that same
# .env, or export it in your shell.
name: ${projectName}

# ── Log rotation ─────────────────────────────────────────────────────────────
#
# Docker's default \`json-file\` driver has NO max-size and NO max-file. Both
# services below carry \`restart: unless-stopped\`, which is a promise to keep
# running for months, and for months the daemon appends to
# /var/lib/docker/containers/<id>/<id>-json.log until the disk is full. Nothing
# in Docker warns first, and a full disk stops Postgres, which stops everything.
#
# 10 MB × 3 files is a 30 MB ceiling per container, 60 MB for the pair. Resize
# it from the .env beside this file — \`LOG_MAX_SIZE=50m\`, or \`LOG_MAX_FILE=1\`
# to keep a single file. Those two names are unprefixed, like DASHBOARD_PORT: an
# EVESTACK_* name would imply the app reads it, and nothing does. Compose
# interpolates both on the host before it parses this file, and neither ever
# reaches a container.
#
# \`driver: json-file\` is stated rather than inherited on purpose. Without it the
# daemon's default driver is used, and WHICH options are legal depends on the
# driver — max-size/max-file belong to json-file, and a host whose daemon
# defaults to journald or awslogs would not apply them. Naming the driver is what
# makes this ceiling mean the same thing on every machine. Change it here if you
# ship logs somewhere else, and change the options with it.
#
# One anchor rather than the same four lines under each service, and the same
# shape the evestack repository's own docker-compose.yml uses, so the two files
# can be read against each other. A YAML alias is resolved at parse time, not by
# Compose — \`docker compose config\` prints the ceiling expanded under both
# services — so this is a way of writing the value once, not an extra layer to
# debug. Verified with Compose v5.1.0: both services report max-size 10m /
# max-file 3, and \`LOG_MAX_SIZE=50m LOG_MAX_FILE=1 docker compose config\` moves
# both of them together.
x-logging: &container-logs
  driver: json-file
  options:
    max-size: "\${LOG_MAX_SIZE:-10m}"
    max-file: "\${LOG_MAX_FILE:-3}"

services:
  postgres:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    logging: *container-logs
    environment:
      POSTGRES_USER: evestack
      # From .env, never from here. Compose resolves this on the host before it
      # parses the file — that is interpolation, and it reads the shell and .env
      # and NOT .env.local. (A service's \`env_file:\` is the other mechanism, and
      # it sets variables inside the container; the dashboard below uses it.)
      POSTGRES_PASSWORD: "${password}"
      POSTGRES_DB: evestack
    ports:
      # 127.0.0.1 on purpose, and this line is the whole reason the password is
      # generated per project rather than shipped. Publishing "${pgPort}:5432" binds
      # 0.0.0.0, and a machine on the same network could reach this database and
      # authenticate — verified, on a real LAN, against the old default
      # credentials. It holds every prompt, tool result and memory the agent has
      # produced, which makes it a more valuable target than the dashboard that
      # was already pinned to loopback two services down.
      #
      # Reaching it from another host is a deliberate act: publish it yourself,
      # or put it behind something that terminates TLS and authenticates.
      - "127.0.0.1:${pgPort}:5432"
    volumes:
      - evestack-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U evestack -d evestack"]
      interval: 3s
      timeout: 3s
      retries: 20

  dashboard:
    # Pinned to a tag, not \`latest\`: this is the image version tested against
    # the agent template this project was scaffolded from. \`latest\` exists in
    # the registry for anyone who would rather track the newest.
    #
    # NO \`build:\` HERE, AND THAT IS NOT AN OVERSIGHT. The evestack repository's
    # own docker-compose.yml carries \`build:\` beside \`image:\`, so an unpublished
    # tag there just builds from source. This project holds no dashboard source
    # and no Dockerfile, so there is nothing for a \`build:\` to point at, and a
    # tag missing from the registry fails here as:
    #
    #   Error response from daemon: manifest unknown
    #
    # with NO container created — which means \`docker compose logs dashboard\`
    # prints nothing, and is the wrong place to look. Three ways out:
    #
    #   docker manifest inspect ${DASHBOARD_IMAGE}   # is the tag there at all?
    #
    #   EVESTACK_DASHBOARD_IMAGE=...:latest   in .env beside this file. NOT
    #   .env.local — Compose interpolates from .env and the shell only.
    #
    #   Build it once from a clone: the repository's \`build:\` tags its result
    #   with exactly the name below, and Compose only pulls an image it does not
    #   already have, so this project then finds it with no further change:
    #     git clone ${REPO} && cd evestack && docker compose build dashboard
    #
    # The agent is fully usable without any of this. The dashboard sits behind a
    # profile precisely so that it is optional.
    image: \${EVESTACK_DASHBOARD_IMAGE:-${DASHBOARD_IMAGE}}
    profiles: ["dashboard"]
    restart: unless-stopped
    logging: *container-logs
    depends_on:
      postgres:
        condition: service_healthy
    # The generated credentials, without a second copy of them in a second file.
    # EVESTACK_AUTH_USER and EVESTACK_AUTH_PASSWORD are what the dashboard signs
    # you in with AND what it presents to your agent. With either missing it
    # refuses to work, by design — it starts agent runs, approves gated shell
    # commands and deletes memories — and it refuses like this:
    #
    #   GET /signin        200, and the page says which two variables are unset.
    #                      It renders NO sign-in form, so there is nothing to
    #                      sign in with; the gate lets this one through so an
    #                      operator sees prose instead of a bare 503.
    #   GET /api/health    503 {"status":"unconfigured"}, which is what makes
    #                      \`docker ps\` show this container as unhealthy.
    #   GET /api/auth/session, GET /api/auth/signout
    #                      405. The gate lets any GET on the sign-in tier
    #                      through, and both routes export POST only.
    #   everything else    503, naming the two variables — every POST included,
    #                      so the two routes above cannot be reached the way
    #                      they are meant to be called either.
    #
    # EVESTACK_INGEST_TOKEN rides along in the same file, and that is the whole
    # reason it can be generated once: your agent runs on the host and reads
    # .env.local directly, this container reads the same .env.local through the
    # line below, so both halves of the trace-ingest shared secret come from one
    # place. Edit it there and restart both — the agent's exporter sends it as
    # \`x-evestack-ingest-token\`, and a value that does not match is a 401 on
    # every span that the OTLP exporter reports to the agent as a success.
    #
    # The model key rides along in the same file, which is a real if small cost:
    # anyone who owns this container can already start runs that spend that key,
    # so the marginal exposure is close to nothing and the alternative is the
    # same secret duplicated into a .env that drifts.
    env_file:
      - .env.local
    environment:
      # .env.local says 127.0.0.1:${pgPort} because the AGENT runs on your host.
      # Inside a container "127.0.0.1" is the container, so the same database is
      # reached over the compose network instead — and the password comes from
      # .env by interpolation, exactly as it does for Postgres above. This line
      # overrides the value env_file just supplied, which is the order Compose
      # documents and the reason both halves stay consistent.
      WORKFLOW_POSTGRES_URL: postgres://evestack:${password}@postgres:5432/evestack
      # \`npm run dev\` also runs on the host, not in compose.
      EVESTACK_AGENT_URL: \${EVESTACK_AGENT_URL:-http://host.docker.internal:${agentPort}}
      # Where the Skills page looks. Points at the mount below, and without both
      # halves the page scans the wrong directory — see the volume's comment.
      EVESTACK_SKILLS_DIR: /agent-skills
      # ── /sandboxes is OFF, and this is one of the three lines that turn it on
      #
      # This variable and the mount at the end of \`volumes:\` below are halves of
      # one switch, and neither half does anything alone: set this and the page
      # reports that the daemon did not answer, because that path is not in this
      # container; mount it and leave this unset and the page reports the feature
      # is off. The \`group_add:\` under that mount is the third line, and it is
      # not optional either — the comment there says why.
      #
      # The value is the path INSIDE this container, which is the right-hand side
      # of the mount. Keep the two strings identical.
      # EVESTACK_DOCKER_SOCKET: /var/run/docker.sock
    volumes:
      # YOUR agent/skills, so the Skills page scans the skills your agent
      # actually loads.
      #
      # Without this mount the page is not empty, which is what made the problem
      # hard to see. lib/skills.ts falls back to the template's skills bundled
      # INSIDE the image, so the page renders a skill called \`memory-hygiene\` —
      # the same name the scaffolder writes into this project — and looks like it
      # is reading yours. It is reading its own copy. The page labels the source
      # ("bundled template", with the absolute path), and a label is a weaker
      # thing than being right.
      #
      # That matters more here than on other pages. eve advertises every skill in
      # this directory to the model and hands it a \`load_skill\` tool, so anything
      # in it can put instructions into a live turn without a human seeing them
      # first — which is why the page scans them at all. A scanner pointed at the
      # wrong directory reports a clean verdict about files nobody is running.
      #
      # Read-only: the dashboard has no reason to write here, and this container
      # already holds a database URL and can start agent runs.
      - ./agent/skills:/agent-skills:ro

      # ── MOUNTING THIS MAKES THE DASHBOARD ROOT ON YOUR MACHINE ─────────────
      #
      # Read that plainly before uncommenting it. A process that can talk to the
      # Docker socket can start a container with \`/\` bind-mounted and write
      # anything, anywhere, as root. This container already takes a password on
      # loopback and can start agent runs; the socket hands whoever gets past
      # that the whole machine. It ships commented out because that is a choice
      # somebody has to make deliberately, not a default to inherit.
      #
      # What it buys: /sandboxes lists the containers eve is running — which of
      # them still has the network, which has been up for hours, which belongs to
      # a session that no longer exists. Nothing on that page writes. The
      # dashboard issues GET requests only and has no stop or remove button.
      #
      # THERE IS NO READ-ONLY DOCKER SOCKET, and \`:ro\` is not one. Measured
      # against Docker 29.2.1: through a \`:ro\` socket mount, as a non-root
      # container user, \`POST /containers/create\` with \`Binds: ["/:/host"]\`
      # answered 201 Created. So \`:ro\` is left off rather than written down as
      # a reassurance that does not hold — a label is a weaker thing than being
      # right. A socket that really is read-only means a filtering proxy in front
      # of the daemon, with the variable above pointing at the proxy.
      #
      # The LEFT side is a path on the DAEMON filesystem, which under Docker
      # Desktop and Colima is a VM and not your host. /var/run/docker.sock is
      # right for Docker Desktop, Colima and Linux; rootless Docker keeps it
      # under XDG_RUNTIME_DIR. Confirm yours with \`docker context inspect\`.
      # - /var/run/docker.sock:/var/run/docker.sock
    # The third line, and the one that is easiest to leave out.
    #
    # Unless your daemon publishes the socket world-writable it is mode 660, owned
    # by a group this image is not in — it runs as \`node\`, uid 1000 — so the
    # mount ALONE answers \`connect EACCES\` and the page then reports the
    # daemon unreachable, which reads like a broken feature and not a missing
    # line. Read the number from the daemon, not from your own /etc/group:
    #
    #   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine:3 \\
    #     stat -c '%g' /var/run/docker.sock
    #
    # The placeholder is deliberately not a plausible number. A wrong one is
    # another EACCES to chase; this one refuses to create the container at all,
    # with \`Unable to find group REPLACE_WITH_YOUR_DOCKER_GID\`.
    # group_add:
    #   - "REPLACE_WITH_YOUR_DOCKER_GID"
    ports:
      # 127.0.0.1 on purpose. The process inside binds 0.0.0.0 because nothing
      # could reach it otherwise; the published mapping is where exposure is
      # actually decided, and this one keeps the control plane on loopback.
      - "127.0.0.1:${"$"}{DASHBOARD_PORT:-${dashboardPort}}:4000"
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  evestack-pgdata:
`;
}
