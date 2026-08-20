/**
 * The template's system prompt may only promise the model tools it actually has.
 *
 * WHY THIS IS A CONTRACT AND NOT A LINT RULE. `templates/default/agent/instructions.md`
 * is the system prompt every scaffolded evestack agent starts life with, and its
 * second paragraph names the sandbox tools by their model-facing names. Nothing
 * type-checks a prompt. Nothing in eve raises when a prompt describes a tool the
 * harness never advertised — the model simply calls a name that is not in its
 * tool list, gets an error back, and improvises. That failure is invisible in
 * CI, invisible in `eve dev`, and shows up as an agent that "sometimes wastes a
 * turn" in production. Exactly the shape of silent breakage the rest of this
 * suite exists for.
 *
 * WHAT MADE IT REAL. Until 2026-08-19 that paragraph read:
 *
 *   Use `bash`, `read_file`, `write_file`, `glob`, and `grep` to work in it.
 *
 * eve 0.39.0 (`4c1bd80`) removed `glob` and `grep` from the default agent tool
 * set: "Agents can opt into either sandbox search tool by exporting
 * `defineGlobTool()` or `defineGrepTool()` from the corresponding tool file."
 * The definitions still exist and `eve/tools/defaults` still exports them, so
 * nothing about the upgrade looks like a removal from the outside — but a
 * default-scaffolded agent on 0.39 no longer has either tool, while the prompt
 * kept promising both. The repo pins `^0.30.8`, so this was never broken for
 * users; it was a lie waiting for an upgrade. The prompt now names only tools
 * that are default on both releases, and this contract is what keeps it that
 * way.
 *
 * The single source of truth is templates/default. packages/create-evestack/template
 * is a copy, but a GENERATED one — .gitignore:19 ignores it and
 * packages/create-evestack/scripts/sync-template.mjs rebuilds it from
 * templates/default at pack time — so it is deliberately not read here. A
 * contract that asserted against a build artifact would pass on a machine that
 * had never run the sync and fail on one that had, for reasons having nothing
 * to do with eve.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";
import { compare } from "../lib/semver.mjs";

const INSTRUCTIONS = "templates/default/agent/instructions.md";

/**
 * eve's own registry of framework-provided tools, minified but structurally
 * legible: the default set and the opt-in set are two flat array literals of
 * import bindings, side by side.
 *
 *   REGISTERED_FRAMEWORK_TOOLS=[ASK_QUESTION_TOOL_DEFINITION,BASH_TOOL_DEFINITION,…]
 *   OPT_IN_FRAMEWORK_TOOLS=[GLOB_TOOL_DEFINITION,GREP_TOOL_DEFINITION]
 *
 * Read statically rather than by calling `getFrameworkToolDefinitions()`, which
 * is the obvious approach and does not work: an unpacked eve tarball has no
 * node_modules, so importing anything under `dist/src/runtime/` fails on the
 * peer dependency `ai` ("Cannot find package 'ai' imported from
 * dist/src/shared/tool-schema.js"). The whole point of
 * EVESTACK_CONTRACT_EVE_DIR is to interrogate a candidate release before
 * installing it, so an assertion that only works on an installed eve would not
 * run in the one situation it is for.
 */
const FRAMEWORK_TOOLS_INDEX = "dist/src/runtime/framework-tools/index.js";
const DEFAULT_SET_RE = /REGISTERED_FRAMEWORK_TOOLS\s*=\s*\[([^\]]*)\]/;
const DEFINITION_RE = /[A-Z][A-Z0-9_]*_TOOL_DEFINITION/g;

/**
 * Tool name → the binding eve names its definition after.
 *
 * The convention is mechanical (`read_file` → `READ_FILE_TOOL_DEFINITION`) with
 * one exception, and the exception is why this map exists rather than a bare
 * `toUpperCase()`: the `load_skill` tool's definition is `SKILL_TOOL_DEFINITION`.
 * Deriving blindly would have looked for `LOAD_SKILL_TOOL_DEFINITION`, found
 * nothing, and reported a default tool as missing — a false failure on a name
 * eve ships perfectly well.
 */
const DEFINITION_ALIASES = { load_skill: "SKILL_TOOL_DEFINITION" };
const definitionFor = (tool) => DEFINITION_ALIASES[tool] ?? `${tool.toUpperCase()}_TOOL_DEFINITION`;

/**
 * Backticked lowercase identifiers in the prompt.
 *
 * The leading `[a-z]` is what keeps `` `/workspace` `` out — a path, not a tool
 * — and the filter below is what keeps ordinary backticked prose out. A word
 * only becomes a promise this contract enforces if eve knows a framework tool
 * definition by that name; `` `recall` `` and `` `forget` `` are authored by
 * templates/default/agent/tools/ and eve has never heard of them, so naming one
 * in the prompt is not eve's problem and is correctly ignored.
 */
const BACKTICKED_RE = /`([a-z][a-z0-9_]*)`/g;

/**
 * Tools eve moved OUT of the default set, and the release that did it.
 *
 * Pinned in both directions, like the WITHDRAWN table in contract 14: below the
 * named version the tool must still be a default, at or above it must not be.
 * A release that puts `glob` back is good news and still a failure here,
 * because the prompt is allowed to promise it again only once someone has
 * checked that it is true.
 */
const MOVED_TO_OPT_IN = {
  glob: { since: "0.39.0", changelog: "4c1bd80" },
  grep: { since: "0.39.0", changelog: "4c1bd80" },
};

const promises = {
  id: "tools/the-prompt-only-promises-tools-the-agent-has",
  title: "every tool templates/default's system prompt names is in eve's default tool set",
  assumption:
    "eve registers `bash`, `read_file` and `write_file` by default for every agent, and `glob` and `grep` are " +
    "opt-in from 0.39.0 onward (`4c1bd80`) rather than defaults.",
  evestackUse:
    "templates/default/agent/instructions.md is the system prompt of every scaffolded evestack agent, and it " +
    "names its sandbox tools by their model-facing names. Nothing checks a prompt against the harness: a name " +
    "the agent does not have produces no error at build time, no error at boot, and no error in `eve dev` — the " +
    "model calls it, the harness rejects an unknown tool, and the turn is spent recovering. The prompt named " +
    "`glob` and `grep` until 2026-08-19, which was true on the pinned eve and false from 0.39.0 on.",

  async check(eve, t) {
    const prompt = readFileSync(join(REPO_ROOT, INSTRUCTIONS), "utf8");

    if (
      !t.ok(eve.fileExists(FRAMEWORK_TOOLS_INDEX), `eve ${eve.version} still ships ${FRAMEWORK_TOOLS_INDEX}`, {
        expected: `${FRAMEWORK_TOOLS_INDEX} in the tarball`,
        actual: "not found — eve reorganised its framework tool registry; re-derive the default set before trusting this",
      })
    ) {
      return;
    }

    const index = eve.readFile(FRAMEWORK_TOOLS_INDEX);
    const known = new Set(index.match(DEFINITION_RE) ?? []);
    const defaults = new Set(DEFAULT_SET_RE.exec(index)?.[1].match(DEFINITION_RE) ?? []);

    // Anti-vacuity. A regex that matched nothing would make every assertion
    // below pass for the wrong reason — "no tool is missing from a set with
    // nothing in it" — so the parse is asserted before it is used.
    t.ok(
      defaults.size > 0,
      `eve's default tool set parsed to ${defaults.size} definitions from REGISTERED_FRAMEWORK_TOOLS`,
      {
        expected: "REGISTERED_FRAMEWORK_TOOLS=[…] matched in the minified index",
        actual: "no match — the literal was renamed or restructured; read the file before changing this regex",
      },
    );

    const promised = [...new Set([...prompt.matchAll(BACKTICKED_RE)].map((m) => m[1]))]
      .filter((name) => known.has(definitionFor(name)))
      .sort();

    // The other half of the anti-vacuity pair, and the one that catches an edit
    // to the prompt rather than to eve: a rewrite that stops naming tools in
    // backticks would silently reduce this contract to nothing.
    t.ok(
      promised.length > 0,
      `${INSTRUCTIONS} still names ${promised.length} eve framework tool(s): ${promised.join(", ") || "none"}`,
      {
        expected: "at least one backticked eve tool name in the prompt",
        actual: "none — either the prompt stopped naming its tools, or it names them in a form this scan cannot see",
      },
    );

    for (const tool of promised) {
      t.ok(
        defaults.has(definitionFor(tool)),
        `\`${tool}\` is still in eve ${eve.version}'s default tool set, so the prompt can promise it`,
        {
          expected: `${definitionFor(tool)} in REGISTERED_FRAMEWORK_TOOLS`,
          actual:
            "not a default on this release — the prompt promises a tool the scaffolded agent does not have. " +
            "Either stop naming it, or add the opt-in file under templates/default/agent/tools/ that brings it back",
        },
      );
    }

    // And the two eve actually moved. Asserted whether or not the prompt still
    // names them: this is the fact the prompt edit was based on, so it is the
    // fact that has to stay checked.
    for (const [tool, moved] of Object.entries(MOVED_TO_OPT_IN)) {
      const stillDefault = defaults.has(definitionFor(tool));
      const expected = compare(eve.version, moved.since) < 0;
      t.equal(
        stillDefault,
        expected,
        expected
          ? `\`${tool}\` is still a default on eve ${eve.version} — eve moves it to opt-in in ${moved.since} (${moved.changelog})`
          : `\`${tool}\` is opt-in on eve ${eve.version}, as of ${moved.since} (${moved.changelog}) — the prompt must not promise it`,
      );
    }
  },
};

export default promises;
