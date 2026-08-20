/**
 * The OpenTelemetry surface the dashboard's trace views are built on.
 *
 * Two different things are pinned here, for two different reasons.
 *
 * The first is vocabulary. `packages/dashboard/sql/traces.sql` projects three
 * span attributes into generated Postgres columns, and `lib/traces.ts` filters
 * spans by name and reads attributes by string key. Both are string literals —
 * one of them inside a `GENERATED ALWAYS AS` clause, which `tsc` could not
 * check even in principle. A renamed attribute does not throw: the column
 * becomes NULL for every row, the trace tree loses its spine, and the session
 * detail page renders an empty timeline for a session that really did call a
 * model.
 *
 * The second is where the `agent.*` span family comes from, and who is allowed
 * to install it. We found that coupling the hard way, on 2026-08-04 against eve
 * 0.30.6. eve's rich agent spans — `agent.session`, `agent.turn`, `agent.step`,
 * `agent.action`, `ai.toolCall`, `ai.streamText.doStream`, emitted under the
 * OTel scope `eve.agent` — come from `createAgentOtelInstrumentation()`. On the
 * pinned release that function has exactly one caller, the zero-config runtime
 * that spools traces to `.eve/traces/v1` for `eve traces`. And
 * `createDevelopmentApplicationNitro` installs that runtime *only* when the app
 * has no `agent/instrumentation.ts`:
 *
 *   compiledArtifacts.instrumentationPluginPath === void 0 &&
 *     plugins.unshift(… local-tracing-runtime-plugin.ts)
 *
 * So on 0.30.x, authoring instrumentation to export OTLP — the only way eve
 * offered to get traces off the box, and what eve's own docs recommend for
 * Braintrust, PostHog, Arize, Honeycomb, Datadog and Jaeger — silently opts you
 * out of the entire `agent.*` span family. Measured in our own Postgres: every
 * span our authored instrumentation has ever exported, thousands of them across
 * scopes `workflow`, `@vercel/otel/fetch`, `gen_ai` and `eve`, populates none of
 * the three generated columns. The only rows that do are 16 spans lifted by hand
 * out of `.eve/traces/v1`, stamped `scope_version = 0.29.5`.
 *
 * Not a 0.30.x regression, though we assumed it was at first: the gate is
 * byte-identical in every tarball from 0.29.5 to 0.30.6. The prompts are not
 * lost either — they arrive under the AI SDK's `gen_ai.*` conventions, with eve
 * ids as `ai.settings.context.eve.*`. What has no exported counterpart at all
 * is the root session id, which is why subagent lineage is unavailable to the
 * dashboard.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED ON 2026-08-19, AND WHY BOTH CONTRACTS WERE REWRITTEN
 *
 * Both contracts below used to fail against eve 0.39.2 — and in both cases the
 * failure was an artifact of how they were written, not of anything evestack
 * depends on going away:
 *
 *   1. The vocabulary contract asserted that eve still ships
 *      `dist/src/harness/instrumentation-runtime-context.js`, because that file
 *      happened to be where `eve.session.id` was spelled. In 0.39.2 the same
 *      code lives at `dist/src/harness/instrumentation/runtime-context.js` — a
 *      directory split, nothing else. The contract failed on the PATH and then
 *      `return`ed early, so 44 of its 51 assertions never ran at all. A rename
 *      of any of the 40 names would have gone unreported behind that one red
 *      line, which is the exact failure mode this contract exists to prevent.
 *
 *      It now asserts each name against eve's whole shipped `dist/src` tree, by
 *      whatever path the name lives at. That is the real dependency: the
 *      dashboard reads span names and attribute keys, not filenames.
 *
 *   2. The coupling contract asserted `createAgentOtelInstrumentation()` is
 *      reachable only from `tracing/local-instrumentation-runtime.js`. In 0.39.2
 *      the installer is `tracing/install-instrumentation-runtime.js` — again a
 *      move — and, much more importantly, eve now ships a public
 *      `eve/instrumentation/otel` export. That is upstream FIXING the problem
 *      this contract was written to pin, so the contract's own premise is what
 *      became false. It is rewritten below to state what is now true and to say
 *      which world each release is in.
 *
 * The rewrite deliberately kept one thing the old vocabulary contract had and
 * traded away another. Kept: the derivation is still from evestack's source, so
 * a name nothing reads is never asserted and a newly-read name is asserted the
 * moment it lands. Traded: the old contract read four hand-named EMITTER files
 * so that a rename in the emitter could not be masked by a reader keeping the
 * old spelling — `tracing/local-trace-reader.js` and
 * `tracing/agent-trace-span-processor.js` both mention `agent.session.id` and
 * both only CONSUME it. A tree-wide scan is weaker there by exactly that much.
 * The three names where the weakness would actually cost us — the ones behind
 * `GENERATED ALWAYS` columns — get a second, stronger assertion that requires
 * them in a module which also calls `startSpan(`, which is emitter-side without
 * naming a single path. Verified against both releases: 0.30.8 satisfies all
 * three from `tracing/agent-otel-provider.js` alone, 0.39.2 from four or five
 * modules under `dist/src/tracing/` depending on the key.
 *
 * HONESTY ABOUT WHAT THIS CAN AND CANNOT SEE. The suite is offline and static;
 * it reads eve's shipped files and never boots a runtime. So it cannot observe
 * which spans actually land in a collector. What it can observe — and does — is
 * the vocabulary in the shipped code and the call graph that decides who
 * installs the tracer. Those are the facts the live behaviour follows from.
 * Where an assertion is weaker than the claim it defends, the assertion says so
 * in its own text.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, sourceFiles } from "../lib/repo.mjs";
import { compare } from "../lib/semver.mjs";

/* -------------------------------------------------------------------------- */
/* what the dashboard reads                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Quoted OTel span names and attribute keys, in the three namespaces eve and
 * the AI SDK own. Quoted deliberately: `lib/traces.ts` opens with a diagram of
 * the span tree in prose, and matching that comment would pin names nothing
 * queries. A string literal, by contrast, is always either a span-name filter
 * or an attribute lookup — the two things that fail silently.
 */
const OTEL_NAME_RE = /["'](agent\.[a-z_.]+|ai\.[A-Za-z_.]+|gen_ai\.[a-z_.]+)["']/g;

/**
 * Derived rather than listed, for the same reason contract 06 derives the
 * `$eve.*` attributes: a hand-maintained list goes stale the first time
 * someone reads a new attribute and forgets to add it here.
 *
 * Scoped to packages/dashboard on purpose. It is the only consumer that turns
 * these names into SQL and into filters — where a rename produces NULLs and
 * empty timelines instead of an error. packages/website names some of the same
 * spans in marketing copy; wrong copy is a documentation bug with a visible
 * fix, not a silent one, and pinning prose here would also drag in
 * `ai.streamText`, which is not eve's literal at all (eve derives that span
 * name from the AI SDK's `operationId` at runtime).
 *
 * `scripts/` is excluded for the same reason the website is, and the word that
 * decides it is CONSUMER. Everything this contract protects is the read path:
 * a name that eve stops emitting turns a SQL projection into NULLs and a span
 * filter into an empty timeline, with no error anywhere. A script under
 * `scripts/` does the opposite — `seed.mjs` WRITES synthetic spans so the
 * charts have something to draw — and a producer naming a span eve no longer
 * emits produces obviously-wrong seed data, not a silent NULL.
 *
 * Without this exclusion the suite went red the moment that seed script landed,
 * on six names it fabricates and eve has never emitted (`ai.eve.step`,
 * `ai.eve.turn`, `gen_ai.client`, `gen_ai.execute_tool`, `gen_ai.invoke_agent`,
 * `gen_ai.client.operation.execute_tool.duration`) — a real contract reporting
 * a failure that is not one, which is how a suite earns being ignored.
 */
const NON_CONSUMER_PREFIXES = ["packages/dashboard/scripts/"];
function dashboardOtelNames() {
  const found = new Map();
  for (const file of sourceFiles()) {
    const rel = relative(REPO_ROOT, file);
    if (!rel.startsWith("packages/dashboard/")) continue;
    if (NON_CONSUMER_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
    for (const match of readFileSync(file, "utf8").matchAll(OTEL_NAME_RE)) {
      const origins = found.get(match[1]) ?? new Set();
      origins.add(rel);
      found.set(match[1], origins);
    }
  }
  return [...found.entries()]
    .map(([name, origins]) => ({ name, origins: [...origins].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everything eve ships as executable code, walked ONCE.
 *
 * `contract/lib/eve.mjs`'s `grep()` re-walks and re-reads the whole subtree per
 * needle. That is fine for the four or five needles the coupling contract uses;
 * it is not fine here, where there are two needles per name and forty names.
 * Measured on eve 0.39.2: 1701 `.js` files, ~37 MB of `dist/src`, one pass in
 * about 0.06s. Forty names at two quote styles each is eighty needles, so
 * re-walking per needle would spend roughly five seconds re-reading the same
 * bytes.
 *
 * `dist/src` rather than `dist/src` minus `compiled/`, because half the
 * vocabulary the dashboard reads is not eve's at all — `gen_ai.*` and the
 * `execute_tool <tool>` span name come from the AI SDK that eve vendors under
 * `dist/src/compiled/@ai-sdk/otel/`. On 0.39.2 `ai.streamText.doStream` moved
 * there too: eve stopped writing it as a literal and now derives the span name
 * from the SDK's `operationId`. Restricting the scan to eve's own modules would
 * have reported that as a lost name, which it is not — it is the same name,
 * shipped in the same tarball, one module over.
 */
function scanShippedCode(eve, needles) {
  const hits = new Map(needles.map((needle) => [needle, []]));
  const stack = [join(eve.root, "dist/src")];
  let files = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      files += 1;
      const text = readFileSync(full, "utf8");
      const rel = full.slice(eve.root.length + 1);
      for (const needle of needles) {
        if (text.includes(needle)) hits.get(needle).push(rel);
      }
    }
  }
  return { files, hits };
}

/**
 * Both quote styles, because eve ships minified output and its bundler
 * rewrites some double-quoted literals as template strings — `"agent.session.id"`
 * and `` `agent.session.id` `` both occur inside one file.
 *
 * Still weaker than the thing we care about: a literal in a file is not proof
 * the span carrying it reaches a collector. Proving that needs a live runtime,
 * a model call and a backend, none of which belong in an offline suite. What
 * this does prove is the necessary half — a name that has left eve's tarball is
 * certainly not being emitted by it.
 */
const quotedForms = (name) => [`"${name}"`, `\`${name}\``];

/** Any module that opens a span. See the header note on emitter-vs-reader. */
const SPAN_CREATOR = "startSpan(";

/**
 * The three attributes behind `GENERATED ALWAYS AS` columns in
 * packages/dashboard/sql/traces.sql. Losing one of these is the silent failure
 * the whole contract is built around, so they get the emitter-side assertion as
 * well as the tree-wide one.
 */
const GENERATED_COLUMN_KEYS = ["agent.session.id", "agent.root.session.id", "agent.turn.id"];

/**
 * `ai.settings.context.*` keys exist as a literal nowhere, because they are
 * assembled at runtime: the AI SDK prefixes `ai.settings.context.` onto
 * whatever context keys eve hands it, and eve's side of that bargain is the
 * bare `eve.session.id`. Asserting the concatenation would fail forever and
 * teach us nothing, so each half is asserted where it actually lives.
 */
const CONTEXT_PREFIX = "ai.settings.context.";

/**
 * The one span name the derivation above structurally cannot see.
 *
 * `getSessionTree` counts a turn's tool calls with `s.name LIKE 'execute\_tool
 * %'`. That is not a quoted OTel identifier, it is a SQL LIKE pattern with the
 * `_` backslash-escaped and a `%` on the end, so no widening of OTEL_NAME_RE
 * would ever match it — and the name is not in the `agent.` / `ai.` / `gen_ai.`
 * namespaces the regex covers either. The dependency was therefore pinned by
 * nothing at all.
 *
 * The name is built by the vendored AI SDK, not by eve:
 *
 *   s = `execute_tool ${a.toolName}`, this.tracer.startSpan(s, …)
 *
 * A rename there raises nowhere. `tool_calls` counts zero matching rows, every
 * traced turn reports `0` tool calls, and `0` is the exact value the whole
 * null-versus-zero design exists to avoid claiming without evidence: it reads
 * as "the model called no tools" rather than "we stopped being able to tell".
 *
 * Asserted from both ends on purpose. Either half alone goes vacuous — delete
 * the LIKE from queries.ts and an emitter-only assertion keeps passing for a
 * dependency that no longer exists, which is the failure mode contract/lib/floor.mjs
 * exists to describe.
 */
const TOOL_SPAN_READER = "packages/dashboard/lib/queries.ts";
/** The SQL literal as it appears in that file — inside a JS template, so the
 *  LIKE escape is written `\\_` and reaches Postgres as `\_`. */
const TOOL_SPAN_PATTERN = String.raw`'execute\\_tool %'`;
/** The span-name template in the SDK, minus the variable the minifier renames. */
const TOOL_SPAN_TEMPLATE = "`execute_tool ${";

/**
 * Names eve has deliberately WITHDRAWN, with the release that did it.
 *
 * This exists because "assert every name the dashboard reads is still in eve's
 * shipped code" is the right rule and `agent.turn.terminal` is a real, upstream,
 * documented exception to it — found while rewriting this contract, not
 * suspected before. eve 0.32.0 (`63a76f0`) says it plainly:
 *
 *   "Local traces now record `agent.turn` with the turn's real duration instead
 *    of a zero-duration marker, and the separate `agent.turn.terminal` marker
 *    span is gone — terminal and transition events land on the turn span
 *    itself."
 *
 * Verified: the literal is present in eve 0.30.8 (dist/src/tracing/agent-otel-provider.js,
 * as a `startSpan(\`agent.turn.terminal\`, …)` call) and absent from every file
 * eve 0.39.2 ships except its own CHANGELOG.
 *
 * A withdrawal entry is NOT a mute button. It flips the assertion rather than
 * dropping it — the name must be present below `since` and absent at or above
 * it — so eve resurrecting the span is just as loud as eve withdrawing a name
 * we have not accounted for. And it carries `consumers`, asserted separately,
 * so that the moment a new file in the dashboard starts reading a name eve no
 * longer emits, someone has to come back here and re-decide whether the loss is
 * still harmless.
 *
 * It is harmless today, and that is the only reason this is an entry rather
 * than a red line: `agent.turn.terminal` reaches exactly one consumer,
 * `spanKind()` in packages/dashboard/app/traces/format.ts:134, which maps it to
 * the label "turn end". With the span gone that branch is simply never taken —
 * no NULL column, no empty timeline, no wrong number. Compare a loss in
 * GENERATED_COLUMN_KEYS, which would be none of those things and must never be
 * listed here.
 */
const WITHDRAWN = {
  "agent.turn.terminal": {
    since: "0.32.0",
    changelog: "63a76f0",
    consumers: "packages/dashboard/app/traces/format.ts",
    replacement: "terminal and transition events now land on the `agent.turn` span itself",
  },
};

const vocabulary = {
  id: "telemetry/dashboard-span-vocabulary",
  title: "every span name and attribute key the dashboard reads is still in eve's shipped code",
  assumption:
    "eve still ships spans named `agent.step` / `ai.streamText.doStream` / `ai.toolCall` carrying " +
    "`agent.session.id`, `agent.root.session.id`, `agent.turn.id`, `ai.prompt.*` and `gen_ai.tool.*` — " +
    "somewhere in its tarball, at whatever path the current release keeps them.",
  evestackUse:
    "packages/dashboard/sql/traces.sql projects agent.session.id, agent.root.session.id and agent.turn.id into " +
    "GENERATED ALWAYS columns — SQL string literals no compiler can check — and every index and session lookup " +
    "hangs off them. packages/dashboard/lib/traces.ts filters spans by name to build the trace tree and reads " +
    "prompts, tool arguments and tool results by attribute key. A rename does not raise: the generated column " +
    "goes NULL for every row, `listSpansBySession` returns nothing, and the session page shows a completed " +
    "session with no model calls and no tool calls. lib/promote-eval.ts then has no prompt to promote.",

  async check(eve, t) {
    const names = dashboardOtelNames();

    // A derivation that finds nothing would pass this contract vacuously, so
    // the derivation itself is asserted before anything is derived from it.
    t.ok(names.length > 0, `found ${names.length} OTel names in packages/dashboard's source`);
    for (const column of GENERATED_COLUMN_KEYS) {
      t.contains(
        names.map((n) => n.name),
        column,
        `the scan still finds \`${column}\` — the generated column in sql/traces.sql keys off it`,
      );
    }

    const needles = [
      ...names.flatMap(({ name }) => quotedForms(name.startsWith(CONTEXT_PREFIX) ? name.slice(CONTEXT_PREFIX.length) : name)),
      CONTEXT_PREFIX,
      TOOL_SPAN_TEMPLATE,
      SPAN_CREATOR,
    ];
    const { files, hits } = scanShippedCode(eve, needles);

    // The other half of the anti-vacuity pair. If the walk found no files —
    // a moved dist, a bad EVESTACK_CONTRACT_EVE_DIR, a packaging change — every
    // assertion below would fail for one reason, and this is the assertion that
    // says which reason.
    t.ok(files > 0, `eve ${eve.version} ships ${files} .js files under dist/src for the scan to read`);

    /** Modules naming a span name or attribute key, either quote style. */
    const modulesNaming = (name) => [...new Set(quotedForms(name).flatMap((form) => hits.get(form) ?? []))].sort();
    const spanCreators = new Set(hits.get(SPAN_CREATOR) ?? []);

    const prefixed = names.filter((n) => n.name.startsWith(CONTEXT_PREFIX));
    if (prefixed.length > 0) {
      const prefixSources = hits.get(CONTEXT_PREFIX) ?? [];
      t.ok(
        prefixSources.length > 0,
        `the AI SDK still prefixes context keys with \`${CONTEXT_PREFIX}\` — in ${prefixSources[0] ?? "no shipped module"}`,
        { expected: `${CONTEXT_PREFIX} appears somewhere under dist/src`, actual: "not found" },
      );
    }

    // The tool-call span name, asserted from both ends — see TOOL_SPAN_READER.
    const reader = readFileSync(join(REPO_ROOT, TOOL_SPAN_READER), "utf8");
    t.ok(
      reader.includes(TOOL_SPAN_PATTERN),
      `${TOOL_SPAN_READER} still counts tool calls by matching ${TOOL_SPAN_PATTERN}`,
      {
        expected: `${TOOL_SPAN_PATTERN} in ${TOOL_SPAN_READER}`,
        actual: "not found — the reader moved or changed spelling, so the assertion below now guards nothing",
      },
    );
    const toolSpanSources = hits.get(TOOL_SPAN_TEMPLATE) ?? [];
    t.ok(
      toolSpanSources.length > 0,
      `the AI SDK still names tool spans \`execute_tool <tool>\` — in ${toolSpanSources[0] ?? "no shipped module"}`,
      {
        expected: `${TOOL_SPAN_TEMPLATE}…} somewhere under dist/src`,
        actual:
          "not found — every traced turn would silently report 0 tool calls, which reads as 'called none' rather than 'cannot tell'",
      },
    );

    for (const { name, origins } of names) {
      // For a composed key, look for the suffix eve controls; for everything
      // else, the literal itself.
      const needle = name.startsWith(CONTEXT_PREFIX) ? name.slice(CONTEXT_PREFIX.length) : name;
      const found = modulesNaming(needle);
      const withdrawn = WITHDRAWN[name];

      if (withdrawn === undefined) {
        t.ok(found.length > 0, `eve still names \`${needle}\` in ${found[0] ?? "no shipped module"} — read by ${origins[0]}`, {
          expected: `${needle} appears as a string literal somewhere under ${eve.version}'s dist/src`,
          actual: "not found anywhere in eve's shipped code",
        });
        continue;
      }

      // A withdrawn name: the expectation flips at the release that withdrew
      // it, so both directions are still failures. See WITHDRAWN.
      const gone = compare(eve.version, withdrawn.since) >= 0;
      if (gone) {
        t.ok(
          found.length === 0,
          `eve ${eve.version} no longer ships \`${name}\`, withdrawn in ${withdrawn.since} (${withdrawn.changelog}) — ${withdrawn.replacement}`,
          {
            expected: `no module under dist/src names ${name}`,
            actual: `still named by ${found.join(", ")} — eve brought the span back; adopt it and drop the WITHDRAWN entry`,
          },
        );
      } else {
        t.ok(
          found.length > 0,
          `eve ${eve.version} still ships \`${name}\` in ${found[0] ?? "no shipped module"} — withdrawn upstream in ${withdrawn.since} (${withdrawn.changelog})`,
          {
            expected: `${name} appears as a string literal somewhere under ${eve.version}'s dist/src`,
            actual: "not found — withdrawn earlier than the WITHDRAWN entry claims; correct the version",
          },
        );
      }
      t.equal(
        origins.join(", "),
        withdrawn.consumers,
        `\`${name}\` still reaches only ${withdrawn.consumers}, where losing it costs a label and nothing else`,
      );
    }

    // The emitter-side half, for the three names whose loss is a silent NULL.
    // Deliberately not path-named: what makes a module an emitter is that it
    // opens spans, not where it sits. 0.30.8 satisfies this from one module,
    // 0.39.2 from five, and neither number is asserted.
    for (const column of GENERATED_COLUMN_KEYS) {
      const emitters = modulesNaming(column).filter((file) => spanCreators.has(file));
      t.ok(
        emitters.length > 0,
        `\`${column}\` is still named by a module that opens spans — ${emitters[0] ?? "none"}`,
        {
          expected: `${column} appears in a module that also calls ${SPAN_CREATOR}`,
          actual:
            `named only by ${modulesNaming(column).join(", ") || "nothing"} — readers can keep an old spelling ` +
            "long after the emitter has changed it, which is why this assertion exists separately",
        },
      );
    }
  },
};

/* -------------------------------------------------------------------------- */
/* who is allowed to install the agent instrumentation                         */
/* -------------------------------------------------------------------------- */

/** eve's own compiled modules, minus type declarations and vendored deps. */
function eveModulesMentioning(eve, needle) {
  return eve
    .grep(needle, "dist/src")
    .filter((file) => file.endsWith(".js") && !file.includes("/compiled/"))
    .map((file) => file.slice("dist/src/".length));
}

const NITRO_HOST = "dist/src/internal/nitro/host/create-application-nitro.js";
/** The dev-only Nitro plugin the gate below installs. A path fragment, not a
 *  full path, because the plugin is referenced by source path inside a string
 *  literal and matched the same way in every release we have read. */
const LOCAL_PLUGIN = "local-tracing-runtime-plugin";

/**
 * The gate, tolerant of minification but not of meaning.
 *
 * Property names and string literals survive eve's minifier; local variable
 * names do not, which is why the pattern reaches for `instrumentationPluginPath`
 * and the plugin's own path and ignores everything between them. A red here
 * means the conditional was rewritten — possibly cosmetically, possibly
 * because the coupling is gone. Either way: open the file, do not guess.
 *
 * Measured byte-identical in every tarball from 0.29.5 to 0.30.6 when the
 * coupling was first traced, and still matching in 0.30.8 and 0.39.2 on
 * 2026-08-19.
 */
const GATE_RE = /instrumentationPluginPath\s*===\s*void 0\s*&&[^;]{0,240}local-tracing-runtime-plugin/;

/**
 * The escape hatch, and the release that opened it.
 *
 * eve 0.34.0 (`c90a459`) added "the experimental `agent/instrumentation/`
 * provider layout … OpenTelemetry singleton settings and destinations are
 * exposed through `eve/instrumentation/otel`". That is the fix the old version
 * of this contract was watching for, and it means the sentence this contract
 * used to assert — that agent spans are reachable ONLY from the gated local
 * trace-spool runtime — is false from 0.34.0 onward.
 *
 * Pinned to a version rather than sniffed, on purpose. If the contract simply
 * branched on "does `eve/instrumentation/otel` resolve", it would follow eve
 * silently in both directions: an upgrade that opened the door would look
 * identical to one that never had it, and a release that REMOVED the door again
 * would quietly re-assert the old coupling as though nothing happened. Naming
 * the version makes both transitions a failure someone has to read.
 *
 * `experimental` is not a footnote. The layout is reachable only with
 * `experimental.instrumentationProviders` on, and it is a directory
 * (`agent/instrumentation/`), not the single `agent/instrumentation.ts` file
 * evestack's template authors today. So the hatch existing is not the same as
 * evestack being able to use it — see evestackUse below.
 */
const AUTHORED_OTEL = {
  spec: "eve/instrumentation/otel",
  since: "0.34.0",
  changelog: "c90a459",
  /** The four names evestack would import if it adopted the layout. */
  expectedExports: ["agentRuns", "localTraces", "otel", "otelIntegration"],
};

const coupling = {
  id: "telemetry/agent-spans-reachable-only-from-local-runtime",
  title: "who can install eve's agent OTel instrumentation, and whether authored instrumentation can",
  assumption:
    "`createAgentOtelInstrumentation()` has exactly one installer, which also mints the `eve.agent` tracer and " +
    "publishes the process instrumentation runtime; that installer is reached from one dev-only Nitro plugin, " +
    "gated on the app authoring no instrumentation. Before eve 0.34.0 that was the only route, so authored " +
    "instrumentation could not emit the `eve.agent` span family at all. From 0.34.0 eve also ships " +
    "`eve/instrumentation/otel`, an authored route to the same destinations.",
  evestackUse:
    "THE COUPLING THIS CONTRACT WAS WRITTEN FOR HAS BEEN FIXED UPSTREAM, AND EVESTACK HAS NOT ADOPTED THE FIX " +
    "YET. templates/default/agent/instrumentation.ts exports OTLP to the dashboard; on the pinned eve that " +
    "means the dashboard never receives agent.session / agent.turn / agent.step / agent.action spans at all — " +
    "only workflow plumbing, `ai.eve.turn`, and the AI SDK's gen_ai.* spans, none of which carry " +
    "agent.session.id. That is why sql/traces.sql's three generated columns are NULL on every live-exported " +
    "row, why root-session lineage for subagents is unavailable, and why lib/traces.ts reattaches ids by " +
    "walking parents instead of filtering on them. From eve 0.34.0 there is a way out: the experimental " +
    "`agent/instrumentation/` layout plus `eve/instrumentation/otel`, which exposes the local spool and the " +
    "hosted destination as integrations an authored setup can keep alongside its own exporter. Adopting it " +
    "means turning on `experimental.instrumentationProviders`, converting agent/instrumentation.ts into a " +
    "directory, and only then deleting the parent-walking workaround — in that order, because the workaround " +
    "is what keeps the session page populated until the spans actually arrive.",

  async check(eve, t) {
    // 1. The instrumentation itself still exists. Located by what declares it,
    //    not by where it sits: 0.39.2 moved its only caller and would have
    //    failed a path assertion for no behavioural reason.
    const declarers = eve.grep("createAgentOtelInstrumentation", "dist/src").filter((file) => file.endsWith(".d.ts"));
    t.equal(
      declarers.length,
      1,
      `exactly one eve module still declares createAgentOtelInstrumentation() — ${declarers.join(", ") || "none does"}`,
    );

    // 2. Its installer. This is the assertion the whole contract turns on: two
    //    modules, the definition and one call site. A third entry means a
    //    second installation path exists — go read it, it may be another fix.
    const references = eveModulesMentioning(eve, "createAgentOtelInstrumentation");
    t.equal(
      references.length,
      2,
      `createAgentOtelInstrumentation() is still referenced by exactly two of eve's own modules — ${references.join(" + ")}`,
    );
    const provider = declarers[0]?.slice("dist/src/".length).replace(/\.d\.ts$/, ".js");
    const installer = references.find((file) => file !== provider);

    // 3. `eve.agent` is the OTel scope every agent span arrives under, and it
    //    is minted in the same place the instrumentation is installed. Pinning
    //    the scope name and the coupling with one assertion is deliberate: they
    //    are the same fact seen from the collector's side and from eve's.
    t.equal(
      eveModulesMentioning(eve, "getTracer(`eve.agent`").join(" + "),
      installer,
      "the `eve.agent` tracer is still minted only inside the module that installs the agent instrumentation",
    );

    // 4. registerInstrumentationRuntime() is the door into the harness — every
    //    execution surface reads its runtime through getInstrumentationRuntime().
    //    The number of modules that call it is NOT asserted: 0.30.8 has two and
    //    0.39.2 has three, because 0.39 split the harness side into
    //    harness/instrumentation/{config,runtime}.js. What matters, and what is
    //    asserted, is that the installer is one of them — the agent tracer and
    //    the process runtime are still published together.
    t.contains(
      eveModulesMentioning(eve, "registerInstrumentationRuntime("),
      installer,
      "the module that installs the agent instrumentation still publishes the process instrumentation runtime",
    );

    // 5. And that installer is reached from exactly one Nitro plugin, the
    //    dev-only trace spool.
    const spool = eveModulesMentioning(eve, "installLocalInstrumentationRuntime");
    t.equal(spool.length, 2, `installLocalInstrumentationRuntime() is still a two-module chain — ${spool.join(" + ")}`);
    t.equal(
      spool.filter((file) => file.includes(LOCAL_PLUGIN)).length,
      1,
      `one end of that chain is still the ${LOCAL_PLUGIN} Nitro plugin`,
    );

    // 5b. THE JOIN. Without this, 5 and 2-4 are two unrelated facts.
    //
    // `spool` is found by a different symbol than `installer`, and on 0.30.8
    // they happen to be the same module — `tracing/local-instrumentation-
    // runtime.js` both defines the spool entry point and holds the only
    // non-provider reference to createAgentOtelInstrumentation. That coincidence
    // is what hid the gap: the contract read as "the installer is reached from
    // exactly one plugin" while only ever checking that SOME two-module chain
    // ending at that plugin existed.
    //
    // 0.39 separates them. `installer` becomes
    // `tracing/install-instrumentation-runtime.js`, the spool chain stays on
    // `local-instrumentation-runtime.js`, and every assertion above still
    // passed — while the stated assumption, that the agent instrumentation is
    // reachable only from the dev-only spool, went unverified.
    //
    // So this asserts the edge itself: the installer is IN the chain, or a
    // module in the chain imports it. Measured — 0.30.8 takes the first branch
    // (one module, both roles), 0.39.2 the second (local-instrumentation-
    // runtime.js imports install-instrumentation-runtime.js). Either way the
    // plugin reaches the installer, which is the thing the assumption claims.
    // Matched on the BASENAME, because the edge is written as a relative
    // specifier — `./install-instrumentation-runtime.js` — so the module's own
    // `tracing/` prefix never appears in the importer.
    const installerModule = installer.slice(installer.lastIndexOf("/") + 1).replace(/\.js$/, "");
    const reaches =
      spool.includes(installer) ||
      spool.some((file) => eveModulesMentioning(eve, installerModule).includes(file));
    t.ok(
      reaches,
      `the trace-spool chain still reaches the installer (${installer}) — directly or by importing it`,
      reaches
        ? {}
        : {
            expected: `${installer} in, or imported by, ${spool.join(" + ")}`,
            actual:
              "no edge between them — the agent instrumentation may now be installable from somewhere other than the dev-only spool, which is the whole subject of this contract",
          },
    );

    // 6. The conditional itself. Two assertions: a coarse one that survives
    //    minifier churn, and the exact gate. If the coarse one holds while the
    //    exact one fails, the wiring was rewritten and needs reading.
    const nitro = eve.readFile(NITRO_HOST);
    t.contains(nitro, LOCAL_PLUGIN, "the dev host still knows about the local tracing plugin");
    t.ok(GATE_RE.test(nitro.replace(/\s+/g, " ")), "the local runtime is still installed only when the app authors no instrumentation", {
      expected: "instrumentationPluginPath === void 0 && … local-tracing-runtime-plugin",
      actual: "the gate around local-tracing-runtime-plugin no longer matches — read create-application-nitro.js",
    });

    // 7. One occurrence, so there is no second, ungated installation. This is
    //    also what says the production build never installs it: eve builds
    //    dev and production Nitro instances from this one file, and only the
    //    dev path mentions the plugin at all.
    t.equal(
      nitro.split(LOCAL_PLUGIN).length - 1,
      1,
      "the local tracing plugin is still installed from exactly one place (dev only, never a production build)",
    );

    // 8. The authoring surface evestack's template actually imports from. Both
    //    names are asserted individually rather than as an exact export list:
    //    0.39 added five more (`DISABLED`, `PROVIDER`, `disableInstrumentation`,
    //    `isInstrumentationDisabled`, `isInstrumentationProvider`) and an
    //    equality assertion would have called that growth a break.
    const authoring = Object.keys(await eve.loadPublic("eve/instrumentation")).sort();
    t.contains(authoring, "defineInstrumentation", "eve/instrumentation still exports defineInstrumentation()");
    t.contains(authoring, "isChannel", "eve/instrumentation still exports isChannel()");

    // 9. And the question this contract now exists to answer: is there an
    //    authored route to the agent span family, or is the trace spool still
    //    the only one? The two branches assert different things because the two
    //    worlds ARE different — see AUTHORED_OTEL for why the version, not the
    //    filesystem, decides which branch runs. Counts: four assertions on a
    //    release before 0.34.0, five from 0.34.0 on.
    const resolved = eve.resolvePublic(AUTHORED_OTEL.spec);
    if (compare(eve.version, AUTHORED_OTEL.since) < 0) {
      t.equal(
        resolved,
        null,
        `eve ${eve.version} predates ${AUTHORED_OTEL.since}: ${AUTHORED_OTEL.spec} does not resolve, so the trace spool is the only installer`,
      );
      // Nothing under dist/src/tracing is reachable through the exports map
      // either, so an app cannot import the provider and install it by hand.
      // Asserted only in this branch: from 0.34.0 the door is a public/ module
      // that re-exports #tracing/*, so the same assertion stays green while
      // meaning the opposite of what it says.
      const publicTracing = eve
        .declaredSubpaths()
        .map((spec) => [spec, eve.resolvePublic(spec)])
        .filter(([, file]) => file !== null && file.includes("/dist/src/tracing/"))
        .map(([spec]) => spec);
      t.equal(publicTracing.join(", "), "", "no public eve specifier resolves into dist/src/tracing");
      t.equal(
        eve.declaredSubpaths().filter((spec) => eve.resolvePublic(spec)?.includes(`/${installer}`)).length,
        0,
        "no public eve specifier resolves to the installer, so an app cannot call it directly",
      );
      // The complete list, not a `contains`. On a pre-0.34.0 release the claim
      // being defended is that NOTHING here installs the agent instrumentation,
      // and only an exact list can say "nothing else". From 0.34.0 the same
      // assertion would fail on five names eve added that have nothing to do
      // with tracing, which is why it lives in this branch and assertion 8 above
      // does not.
      t.equal(
        authoring.join(", "),
        "defineInstrumentation, isChannel",
        "eve/instrumentation exports nothing else, so nothing there installs the agent instrumentation",
      );
    } else {
      t.ok(resolved !== null, `eve ${eve.version} ships ${AUTHORED_OTEL.spec} — the authored-instrumentation escape hatch exists`, {
        expected: `${AUTHORED_OTEL.spec} resolves through eve's exports map (added in ${AUTHORED_OTEL.since}, ${AUTHORED_OTEL.changelog})`,
        actual: "does not resolve — eve withdrew the hatch again; the coupling is back and lib/traces.ts must keep its workaround",
      });
      const otelExports = resolved === null ? [] : Object.keys(await eve.loadPublic(AUTHORED_OTEL.spec)).sort();
      for (const name of AUTHORED_OTEL.expectedExports) {
        t.contains(otelExports, name, `${AUTHORED_OTEL.spec} still exports ${name}()`);
      }
    }
  },
};

export default [vocabulary, coupling];
