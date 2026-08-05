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
 * The second is a coupling we found the hard way, on 2026-08-04 against eve
 * 0.30.6. eve's rich agent spans — `agent.session`, `agent.turn`, `agent.step`,
 * `agent.action`, `ai.toolCall`, `ai.streamText.doStream`, emitted under the
 * OTel scope `eve.agent` — come from `createAgentOtelInstrumentation()`. That
 * function has exactly one caller: `installLocalInstrumentationRuntime()`, the
 * zero-config runtime that spools traces to `.eve/traces/v1` for `eve traces`.
 * And `createDevelopmentApplicationNitro` installs that runtime *only* when the
 * app has no `agent/instrumentation.ts`:
 *
 *   compiledArtifacts.instrumentationPluginPath === void 0 &&
 *     plugins.unshift(… local-tracing-runtime-plugin.ts)
 *
 * So authoring instrumentation to export OTLP — the only way eve offers to get
 * traces off the box, and what eve's own docs recommend for Braintrust,
 * PostHog, Arize, Honeycomb, Datadog and Jaeger — silently opts you out of the
 * entire `agent.*` span family. Measured in our own Postgres: every span our
 * authored instrumentation has ever exported, thousands of them across scopes
 * `workflow`, `@vercel/otel/fetch`, `gen_ai` and `eve`, populates none of the
 * three generated columns. The only rows that do are 16 spans lifted by hand
 * out of `.eve/traces/v1`, stamped `scope_version = 0.29.5`.
 *
 * Not a 0.30.x regression, though we assumed it was at first: the gate is
 * byte-identical in every tarball from 0.29.5 to 0.30.6. The prompts are not
 * lost either — they arrive under the AI SDK's `gen_ai.*` conventions, with eve
 * ids as `ai.settings.context.eve.*`. What has no exported counterpart at all
 * is the root session id, which is why subagent lineage is unavailable to the
 * dashboard.
 *
 * The second contract below encodes that coupling so it cannot change without
 * us noticing. Read a failure there as good news, not a regression: it most
 * likely means eve has made the agent instrumentation reachable from authored
 * instrumentation, which is the fix we want. See docs/upgrading.mdx.
 *
 * HONESTY ABOUT WHAT THIS CAN AND CANNOT SEE. The suite is offline and static;
 * it reads eve's shipped files and never boots a runtime. So it cannot observe
 * which spans actually land in a collector. What it can observe — and does — is
 * the call graph that decides it: who calls the agent instrumentation, who
 * calls the only function that publishes a runtime to the harness, and the one
 * conditional that gates the whole chain. Those are the facts the live
 * behaviour follows from. Where an assertion is weaker than the claim it
 * defends, the assertion says so in its own text.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { REPO_ROOT, sourceFiles } from "../lib/repo.mjs";

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
 */
function dashboardOtelNames() {
  const found = new Map();
  for (const file of sourceFiles()) {
    const rel = relative(REPO_ROOT, file);
    if (!rel.startsWith("packages/dashboard/")) continue;
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
 * The single module that creates every span the dashboard reads. All 23 names
 * derived above appear in this one file, so it — not the tracing subtree — is
 * what the assertions below read.
 *
 * That distinction has teeth. Three of the names are also mentioned by
 * `local-trace-reader.js` and `agent-trace-span-processor.js`, which consume
 * spans rather than emit them; a subtree-wide grep therefore stays green when
 * the emitter renames an attribute and only the readers keep the old spelling.
 * Verified: renaming `agent.session.id` in the provider alone leaves a
 * subtree-wide grep passing and this file's assertion failing.
 */
const EMITTER = "dist/src/tracing/agent-otel-provider.js";

/**
 * The SECOND emitter, and the one that matters off a developer's laptop.
 *
 * eve has two telemetry vocabularies from two different pieces of code:
 *
 *   agent-otel-provider.js       `agent.*`, `ai.prompt.*`   — eve's own tracer
 *   compiled/@ai-sdk/otel        `gen_ai.*`,
 *                                `ai.settings.context.eve.*` — the vendored AI SDK
 *
 * Only the second reaches an external collector, because the first is installed
 * exclusively by the local tracing runtime (see the second contract in this
 * file) and that runtime does not start once a project authors its own
 * instrumentation. The dashboard therefore reads both, and both have to be
 * asserted — checking only eve's own emitter would leave the exported half, the
 * half every self-hoster actually receives, completely unguarded.
 */
const SDK_EMITTER = "dist/src/compiled/@ai-sdk/otel/index.js";

/**
 * The THIRD file, and the one that owns the half of the exported key we care
 * about most.
 *
 * `ai.settings.context.eve.session.id` is not a literal anywhere: the AI SDK
 * contributes the `ai.settings.context.` prefix, and eve contributes the bare
 * `eve.session.id` from here, where it populates the SDK's telemetry context.
 * A rename on either side breaks the dashboard's session lookup, so both sides
 * are asserted in the file that actually owns them.
 */
const CONTEXT_SOURCE = "dist/src/harness/instrumentation-runtime-context.js";

/**
 * Both quote styles, because eve ships minified output and its bundler
 * rewrites some double-quoted literals as template strings — `"agent.session.id"`
 * and `` `agent.session.id` `` both occur inside this one file.
 *
 * Still weaker than the thing we care about: a literal in a file is not proof
 * the span carrying it reaches a collector. Proving that needs a live runtime,
 * a model call and a backend, none of which belong in an offline suite. What
 * this does prove is the necessary half — a name that has left the emitter is
 * certainly not being emitted.
 */
function emitterMentions(emitter, name) {
  return emitter.includes(`"${name}"`) || emitter.includes(`\`${name}\``);
}

const vocabulary = {
  id: "telemetry/dashboard-span-vocabulary",
  title: "every span name and attribute key the dashboard reads is still in eve's tracing code",
  assumption:
    "eve still emits spans named `agent.step` / `ai.streamText.doStream` / `ai.toolCall` carrying " +
    "`agent.session.id`, `agent.root.session.id`, `agent.turn.id`, `ai.prompt.*` and `gen_ai.tool.*`.",
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
    for (const column of ["agent.session.id", "agent.root.session.id", "agent.turn.id"]) {
      t.contains(
        names.map((n) => n.name),
        column,
        `the scan still finds \`${column}\` — the generated column in sql/traces.sql keys off it`,
      );
    }

    if (!t.ok(eve.fileExists(EMITTER), `eve still ships ${EMITTER}, the module that creates these spans`)) return;
    if (!t.ok(eve.fileExists(SDK_EMITTER), `eve still vendors ${SDK_EMITTER}, the exported vocabulary`)) return;
    if (!t.ok(eve.fileExists(CONTEXT_SOURCE), `eve still ships ${CONTEXT_SOURCE}, which names the exported ids`)) return;

    // A name is satisfied by EITHER emitter. Requiring both would fail on every
    // name by construction — the two vocabularies are disjoint, which is the
    // whole reason the dashboard reads both.
    const sources = [
      { path: EMITTER, text: eve.readFile(EMITTER) },
      { path: SDK_EMITTER, text: eve.readFile(SDK_EMITTER) },
      { path: CONTEXT_SOURCE, text: eve.readFile(CONTEXT_SOURCE) },
    ];

    // `ai.settings.context.*` keys exist as a literal nowhere, because they are
    // assembled at runtime: the AI SDK prefixes `ai.settings.context.` onto
    // whatever context keys eve hands it, and eve's side of that bargain is the
    // bare `eve.session.id`. Asserting the concatenation would fail forever and
    // teach us nothing, so each half is asserted where it actually lives.
    const CONTEXT_PREFIX = "ai.settings.context.";
    const sdk = sources[1].text;
    const prefixed = names.filter((n) => n.name.startsWith(CONTEXT_PREFIX));

    if (prefixed.length > 0) {
      t.ok(
        sdk.includes(CONTEXT_PREFIX),
        `the AI SDK still prefixes context keys with \`${CONTEXT_PREFIX}\``,
        { expected: `${CONTEXT_PREFIX} appears in ${SDK_EMITTER}`, actual: "not found" },
      );
    }

    for (const { name, origins } of names) {
      // For a composed key, assert the suffix eve controls; for everything else,
      // the literal itself.
      const needle = name.startsWith(CONTEXT_PREFIX) ? name.slice(CONTEXT_PREFIX.length) : name;
      const found = sources.find((source) => emitterMentions(source.text, needle));
      t.ok(Boolean(found), `an eve span emitter still names \`${needle}\` — read by ${origins[0]}`, {
        expected: `${needle} appears as a string literal in one of ${sources.map((s) => s.path).join(", ")}`,
        actual: "not found in either emitter",
      });
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

const PROVIDER = "tracing/agent-otel-provider.js";
const LOCAL_RUNTIME = "tracing/local-instrumentation-runtime.js";
const LOCAL_PLUGIN = "internal/nitro/host/local-tracing-runtime-plugin.js";
const NITRO_HOST = "dist/src/internal/nitro/host/create-application-nitro.js";

/**
 * The gate, tolerant of minification but not of meaning.
 *
 * Property names and string literals survive eve's minifier; local variable
 * names do not, which is why the pattern reaches for `instrumentationPluginPath`
 * and the plugin's own path and ignores everything between them. A red here
 * means the conditional was rewritten — possibly cosmetically, possibly
 * because the coupling is gone. Either way: open the file, do not guess.
 */
const GATE_RE = /instrumentationPluginPath\s*===\s*void 0\s*&&[^;]{0,240}local-tracing-runtime-plugin/;

const coupling = {
  id: "telemetry/agent-spans-reachable-only-from-local-runtime",
  title: "eve's agent OTel instrumentation is still installable only by the local trace-spool runtime",
  assumption:
    "`createAgentOtelInstrumentation()` is called only by `installLocalInstrumentationRuntime()`, which is " +
    "installed only when the app has no `agent/instrumentation.ts` — so authored instrumentation cannot emit " +
    "the `eve.agent` span family, and eve exposes no public way to install it.",
  evestackUse:
    "A FAILURE HERE IS PROBABLY GOOD NEWS. templates/default/agent/instrumentation.ts exports OTLP to the " +
    "dashboard, which by this coupling means the dashboard never receives agent.session / agent.turn / " +
    "agent.step / agent.action spans at all — only workflow plumbing, `ai.eve.turn`, and the AI SDK's " +
    "gen_ai.* spans, none of which carry agent.session.id. That is why sql/traces.sql's three generated " +
    "columns are NULL on every live-exported row, why root-session lineage for subagents is unavailable, and " +
    "why lib/traces.ts reattaches ids by walking parents instead of filtering on them. If eve makes the agent " +
    "instrumentation reachable from authored instrumentation, adopt it and delete that workaround. If eve " +
    "instead moves these files, re-derive the coupling before trusting anything the dashboard shows.",

  async check(eve, t) {
    // 1. The instrumentation itself still exists and is still the thing that
    //    makes the spans the dashboard was written against.
    t.ok(eve.fileExists(`dist/src/${PROVIDER}`), `eve still ships ${PROVIDER}`);
    t.contains(
      eve.readFile("dist/src/tracing/agent-otel-provider.d.ts"),
      "createAgentOtelInstrumentation",
      "eve still declares createAgentOtelInstrumentation()",
    );

    // 2. Its only caller. This is the assertion the whole contract turns on:
    //    two modules, the definition and one call site. A third entry means a
    //    second installation path exists — go read it, it may be the fix.
    t.equal(
      eveModulesMentioning(eve, "createAgentOtelInstrumentation").join(" + "),
      `${PROVIDER} + ${LOCAL_RUNTIME}`,
      "createAgentOtelInstrumentation() is still referenced only by its own module and the local runtime",
    );

    // 3. `eve.agent` is the OTel scope every agent span arrives under, and it
    //    is minted in the same place. Pinning the scope name and the coupling
    //    with one assertion is deliberate: they are the same fact seen from
    //    the collector's side and from eve's.
    t.equal(
      eveModulesMentioning(eve, "getTracer(`eve.agent`").join(" + "),
      LOCAL_RUNTIME,
      "the `eve.agent` tracer is still created only inside the local runtime",
    );

    // 4. registerInstrumentationRuntime() is the only door into the harness —
    //    every execution surface reads its runtime through
    //    getInstrumentationRuntime(). One caller means one way in.
    t.equal(
      eveModulesMentioning(eve, "registerInstrumentationRuntime(").join(" + "),
      `harness/instrumentation-runtime.js + ${LOCAL_RUNTIME}`,
      "the process instrumentation runtime is still published only by the local runtime",
    );

    // 5. And the local runtime is reached from exactly one Nitro plugin.
    t.equal(
      eveModulesMentioning(eve, "installLocalInstrumentationRuntime").join(" + "),
      `${LOCAL_PLUGIN} + ${LOCAL_RUNTIME}`,
      "installLocalInstrumentationRuntime() is still imported only by the local tracing Nitro plugin",
    );

    // 6. The conditional itself. Two assertions: a coarse one that survives
    //    minifier churn, and the exact gate. If the coarse one holds while the
    //    exact one fails, the wiring was rewritten and needs reading.
    const nitro = eve.readFile(NITRO_HOST);
    t.contains(nitro, "local-tracing-runtime-plugin", "the dev host still knows about the local tracing plugin");
    t.ok(GATE_RE.test(nitro.replace(/\s+/g, " ")), "the local runtime is still installed only when the app authors no instrumentation", {
      expected: "instrumentationPluginPath === void 0 && … local-tracing-runtime-plugin",
      actual: "the gate around local-tracing-runtime-plugin no longer matches — read create-application-nitro.js",
    });

    // 7. One occurrence, so there is no second, ungated installation. This is
    //    also what says the production build never installs it: eve builds
    //    dev and production Nitro instances from this one file, and only the
    //    dev path mentions the plugin at all.
    t.equal(
      nitro.split("local-tracing-runtime-plugin").length - 1,
      1,
      "the local tracing plugin is still installed from exactly one place (dev only, never a production build)",
    );

    // 8. The public authoring surface. `agent/instrumentation.ts` imports from
    //    eve/instrumentation; if eve ever ships an opt-in, this is where it
    //    lands and this assertion is how we find out.
    const authoring = await eve.loadPublic("eve/instrumentation");
    t.equal(
      Object.keys(authoring).sort().join(", "),
      "defineInstrumentation, isChannel",
      "eve/instrumentation still exports nothing that installs the agent instrumentation",
    );

    // 9. …and nothing under dist/src/tracing is reachable through the exports
    //    map, so an app cannot import the provider and install it by hand.
    const publicTracing = eve
      .declaredSubpaths()
      .map((spec) => [spec, eve.resolvePublic(spec)])
      .filter(([, file]) => file !== null && file.includes("/dist/src/tracing/"))
      .map(([spec]) => spec);
    t.equal(publicTracing.join(", "), "", "no public eve specifier resolves into dist/src/tracing");
  },
};

export default [vocabulary, coupling];
