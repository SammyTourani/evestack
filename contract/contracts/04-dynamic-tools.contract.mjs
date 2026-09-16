/**
 * The dynamic-tool sentinel: how a resolver announces itself to eve's compiler.
 *
 * `defineDynamic` does no validation at call time — it stamps an object and
 * returns it, and eve's compiler decides later whether the shape is one it
 * recognises. That is exactly the kind of assumption a typecheck cannot
 * defend: the sentinel's `kind` string and the set of events eve will actually
 * dispatch are runtime values, not types.
 */

export default {
  id: "tools/dynamic-sentinel-and-events",
  title: "defineDynamic still produces the `eve:dynamic` sentinel and still dispatches `step.started`",
  assumption:
    'defineDynamic returns `{ kind: "eve:dynamic", events }`, and `step.started` is a tool event eve will dispatch.',
  evestackUse:
    "@evestack/composio (packages/evestack-composio, published to npm) resolves a user's connected Composio " +
    "apps into tools on `step.started` — step scope, because a tool the user connects mid-session has to " +
    "appear without restarting the session, and because only step-scoped entries keep a live `execute` " +
    "closure across replay. If the sentinel kind changes, eve stops recognising the export and silently " +
    "loads zero tools: no error, no tools, an agent that has quietly lost every integration. If " +
    "`step.started` drops out of the dispatch set, the same silence.",

  async check(eve, t) {
    const tools = await eve.loadPublic("eve/tools");
    t.equal(typeof tools.defineDynamic, "function", "eve/tools exports `defineDynamic()`");

    const handler = () => null;
    const sentinel = tools.defineDynamic({ events: { "step.started": handler } });

    t.equal(sentinel.kind, "eve:dynamic", "the sentinel's discriminator is still the string `eve:dynamic`");
    t.equal(
      sentinel.events?.["step.started"],
      handler,
      "the sentinel carries the handler under the literal key `step.started`",
    );

    // eve's own predicate, not a re-implementation of it. If eve changes how it
    // recognises a dynamic export, this is what stops agreeing.
    //
    // dist/src/shared/dynamic-tool-definition.js does not exist in 0.54.3 —
    // there is no dist/src/shared/dynamic-tool-definition.* at all — and what
    // it used to bundle together has been split across two files rather than
    // relocated as one. Found by grepping the whole dist tree (minus
    // dist/src/compiled, which is vendored) for each of the four runtime names
    // this check touches:
    //
    //   DYNAMIC_SENTINEL_KIND, isDynamicSentinel, ALLOWED_DYNAMIC_TOOL_EVENTS
    //     → dist/src/dynamic/definition.js — this is also where the public
    //       `defineDynamic()` used above is implemented (it's `#dynamic/
    //       definition.js` behind eve's package.json `imports` map), so the
    //       sentinel a resolver author gets from the public API and the
    //       predicate that recognises it now live in literally the same module.
    //   isBrandedToolEntry
    //     → dist/src/tools/dynamic.js, next to the `TOOL_BRAND` symbol it
    //       reads (`Symbol.for("eve:tool-brand")`, unchanged) — grouped with
    //       ordinary tool branding rather than with the dynamic-resolver
    //       sentinel, because a branded tool entry is not itself a dynamic
    //       export; a resolver returns a map of these keyed by tool name.
    //
    // Read the source of both before trusting this split: dynamic/definition.js
    // defines ALLOWED_DYNAMIC_TOOL_EVENTS as `new Set(["session.started",
    // "turn.started", "step.started"])` — same three events, same literal
    // strings — and DYNAMIC_SENTINEL_KIND as the literal `"eve:dynamic"`. Two
    // loads instead of one, because there no longer is one file that has both.
    const dynamicDef = await eve.loadInternal("dist/src/dynamic/definition.js");
    const toolDynamic = await eve.loadInternal("dist/src/tools/dynamic.js");
    t.equal(dynamicDef.DYNAMIC_SENTINEL_KIND, "eve:dynamic", "eve's DYNAMIC_SENTINEL_KIND constant is unchanged");
    t.ok(dynamicDef.isDynamicSentinel(sentinel), "eve's own isDynamicSentinel() accepts what defineDynamic() produced");
    t.ok(
      toolDynamic.isBrandedToolEntry(
        tools.defineTool({ description: "probe", inputSchema: {}, execute: () => "ok" }),
      ),
      "eve's isBrandedToolEntry() accepts an entry built by defineTool inside a resolver",
    );

    const allowed = dynamicDef.ALLOWED_DYNAMIC_TOOL_EVENTS;
    t.ok(allowed instanceof Set, "ALLOWED_DYNAMIC_TOOL_EVENTS is still a Set of event names");
    t.contains(allowed, "step.started", "`step.started` is still an allowed dynamic-tool event");

    // Not a dependency today, but the difference between step scope and
    // session scope is the whole reason composio.ts uses the former; if eve
    // collapsed them, the choice would need revisiting rather than inheriting.
    t.contains(allowed, "session.started", "`session.started` is still an allowed dynamic-tool event");
    t.contains(allowed, "turn.started", "`turn.started` is still an allowed dynamic-tool event");
  },
};
