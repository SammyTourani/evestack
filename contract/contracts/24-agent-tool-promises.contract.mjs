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
 * eve's own registry of framework-provided tool SOURCES, keyed by the same
 * logical path a user's own `agent/tools/*.ts` file would occupy if it chose
 * to override one.
 *
 * Nothing here is a flat array of `*_TOOL_DEFINITION` constants any more.
 * That whole naming convention is gone from the package — confirmed by
 * grepping the entire dist tree (minus dist/src/compiled, which is vendored)
 * for `REGISTERED_FRAMEWORK_TOOLS`, `OPT_IN_FRAMEWORK_TOOLS`, and every
 * `*_TOOL_DEFINITION` identifier this contract used to look for: zero hits,
 * on all of them. In 0.54.3 the compiler instead composes each agent out of
 * "programmatic sources" — named bundles of `{ logicalPath, loadNamespace }`
 * entries — and dist/src/framework/sources/registry.js is where eve defines
 * the two sources wired into every scaffolded agent unconditionally:
 * `localDefaults` (id `eve:defaults`, applied to every local node) and
 * `rootDefaults` (id `eve:root-defaults`, applied only to the root node,
 * which is why the `agent` self-dispatch tool lives there and not in
 * `localDefaults` — a subagent can be dispatched only from the session root).
 * A third source in the same file, id `eve:memory-wrapper`, is registered
 * only as a template (`createAgentSourceRegistry(sources, { templates: [...]
 * })`) rather than composed the way the other two are — read
 * `frameworkAgentSourceRegistry`'s own construction call to see the
 * distinction made in eve's own code, not asserted by us. It is deliberately
 * excluded below: a template is not wired into every agent, so a tool it
 * carries is not a default just because its `logicalPath` starts with
 * `tools/` the same way a real default's does (`tools/memory-wrapper.ts` is
 * exactly this trap — present in the file, absent from what actually composes
 * by default).
 *
 * Read statically rather than by importing the module, for the reason the
 * previous version of this contract gave and that reason has not changed: an
 * unpacked eve tarball has no node_modules, so importing anything that reaches
 * into dist/src/runtime/ fails on the peer dependency `ai`. EVESTACK_CONTRACT_EVE_DIR
 * exists to interrogate exactly that kind of candidate — unpacked, not yet
 * installed — so an assertion that only works once eve is installed would not
 * run in the one situation it exists for.
 */
const FRAMEWORK_SOURCES_REGISTRY = "dist/src/framework/sources/registry.js";

/**
 * Slices `text` between two literal anchors (exclusive of both), or null if
 * either is missing.
 *
 * Used to scope the logical-path regex below to one `defineProgrammaticAgentSource`
 * call at a time rather than the whole file. `modules:[` alone is not a unique
 * enough anchor — all three sources have one — and the memory-wrapper source's
 * `tools/memory-wrapper.ts` entry starts with `tools/` exactly like a real
 * default's does, so an unscoped scan over-counts it. Anchoring on each
 * source's `id:` literal instead, and taking the text up to the NEXT source's
 * `id:` literal, isolates one source's `modules` array without having to
 * balance the nested `{`/`[` this minified text does not make it easy to
 * balance by hand.
 */
function between(text, startAnchor, endAnchor) {
  const start = text.indexOf(startAnchor);
  if (start === -1) return null;
  const end = text.indexOf(endAnchor, start + startAnchor.length);
  return end === -1 ? null : text.slice(start + startAnchor.length, end);
}

// Every module entry in the registry uses backtick-quoted string literals —
// `` `tools/bash.ts` ``, never `"tools/bash.ts"` or `'tools/bash.ts'` — which
// is the bundler's own output convention here, not a choice made by this
// file, and the regex has to match the delimiter that is actually on disk.
const TOOL_LOGICAL_PATH_RE = /logicalPath:`tools\/([a-z_]+)\.ts`/g;

/**
 * Every tool name eve KNOWS how to provide — default or opt-in — derived from
 * eve's own package.json `exports` map rather than from any one dist file.
 * That map is the one place both categories are guaranteed to be listed
 * together: a tool a user must opt into by re-exporting it (`glob`, `grep`)
 * still needs a public subpath to opt in FROM, so it is exported precisely
 * when it exists at all, regardless of whether it defaults on. This replaces
 * the old `known` set, which used to come from every `*_TOOL_DEFINITION`
 * identifier anywhere in the (now nonexistent) framework-tools index file.
 *
 * Three tool-shaped-looking subpaths are excluded on purpose: bare `eve/tools`
 * is the authoring-helper barrel (`defineTool`, `defineDynamic`, `disableTool`,
 * …), and `eve/tools/approval` / `eve/tools/workflow` are helper namespaces
 * (`always()`/`never()`/`once()`, and the experimental workflow-tool authoring
 * helpers) rather than one specific tool the model calls by that name.
 * Confirmed by reading both .d.ts files directly: neither has a `default`
 * export, and every real tool subpath (`eve/tools/glob`, `eve/tools/bash`, …)
 * does.
 */
const NON_TOOL_SUBPATHS = new Set(["eve/tools", "eve/tools/approval", "eve/tools/workflow"]);

/**
 * Tool name → the binding eve names its definition after.
 *
 * The convention is mechanical (`read_file` → `READ_FILE_TOOL_DEFINITION`) with
 * one exception, and the exception is why this map exists rather than a bare
 * `toUpperCase()`: the `load_skill` tool's definition is `SKILL_TOOL_DEFINITION`.
 * Deriving blindly would have looked for `LOAD_SKILL_TOOL_DEFINITION`, found
 * nothing, and reported a default tool as missing — a false failure on a name
 * eve ships perfectly well.
 *
 * UPDATE, 0.54.3: this whole alias table is dead weight now, kept only as a
 * flag for the next person who wonders where it went. The `_TOOL_DEFINITION`
 * naming convention it worked around no longer exists (see the comment on
 * FRAMEWORK_SOURCES_REGISTRY above) — both `known` and `defaults` are now
 * plain tool-name strings (`"load_skill"`, not `"SKILL_TOOL_DEFINITION"`),
 * because both the exports-map subpath and the registry's `logicalPath` name
 * a tool `tools/load_skill` / `eve/tools/load_skill` consistently. There is
 * no exception left to alias.
 */

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
      !t.ok(
        eve.fileExists(FRAMEWORK_SOURCES_REGISTRY),
        `eve ${eve.version} still ships ${FRAMEWORK_SOURCES_REGISTRY}`,
        {
          expected: `${FRAMEWORK_SOURCES_REGISTRY} in the tarball`,
          actual:
            "not found — eve reorganised its framework tool registry again; re-derive the default set before trusting this",
        },
      )
    ) {
      return;
    }

    const known = new Set(
      eve
        .declaredSubpaths()
        .filter((subpath) => subpath.startsWith("eve/tools/") && !NON_TOOL_SUBPATHS.has(subpath))
        .map((subpath) => subpath.slice("eve/tools/".length)),
    );

    // Anti-vacuity for the `known` derivation specifically, kept separate from
    // the `promised.length > 0` check below so a break in declaredSubpaths()
    // itself — eve's exports map stops naming tools under `./tools/*` — fails
    // with its own message instead of being inferred two steps removed from
    // the actual cause.
    t.ok(known.size > 0, `eve's package.json exports map still lists ${known.size} tool subpath(s) under ./tools/*`, {
      expected: "at least one ./tools/<name> entry in eve's exports map, besides the excluded helper namespaces",
      actual: "none — eve's exports map stopped naming tools this way; read package.json before changing this filter",
    });

    const registrySource = eve.readFile(FRAMEWORK_SOURCES_REGISTRY);
    const localDefaultsChunk = between(registrySource, "id:`eve:defaults`", "id:`eve:root-defaults`") ?? "";
    const rootDefaultsChunk = between(registrySource, "id:`eve:root-defaults`", "id:`eve:memory-wrapper`") ?? "";
    const defaults = new Set([
      ...[...localDefaultsChunk.matchAll(TOOL_LOGICAL_PATH_RE)].map((m) => m[1]),
      ...[...rootDefaultsChunk.matchAll(TOOL_LOGICAL_PATH_RE)].map((m) => m[1]),
    ]);

    // Anti-vacuity. A regex that matched nothing would make every assertion
    // below pass for the wrong reason — "no tool is missing from a set with
    // nothing in it" — so the parse is asserted before it is used. Either
    // anchor pair failing to resolve (an `id:` literal renamed) lands here
    // too, since `between()` returning null degrades to the empty string.
    t.ok(
      defaults.size > 0,
      `eve's default tool set parsed to ${defaults.size} tool(s) from ${FRAMEWORK_SOURCES_REGISTRY}`,
      {
        expected: "at least one `logicalPath:`tools/<name>.ts`` entry under the eve:defaults or eve:root-defaults source",
        actual: "no match — an `id:` literal was renamed, or the module shape changed; read the file before changing this parse",
      },
    );

    const promised = [...new Set([...prompt.matchAll(BACKTICKED_RE)].map((m) => m[1]))]
      .filter((name) => known.has(name))
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
        defaults.has(tool),
        `\`${tool}\` is still in eve ${eve.version}'s default tool set, so the prompt can promise it`,
        {
          expected: `\`tools/${tool}.ts\` under the eve:defaults or eve:root-defaults programmatic source`,
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
      const stillDefault = defaults.has(tool);
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
