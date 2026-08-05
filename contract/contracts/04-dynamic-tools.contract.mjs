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
    const shared = await eve.loadInternal("dist/src/shared/dynamic-tool-definition.js");
    t.equal(shared.DYNAMIC_SENTINEL_KIND, "eve:dynamic", "eve's DYNAMIC_SENTINEL_KIND constant is unchanged");
    t.ok(shared.isDynamicSentinel(sentinel), "eve's own isDynamicSentinel() accepts what defineDynamic() produced");
    t.ok(
      shared.isBrandedToolEntry(
        tools.defineTool({ description: "probe", inputSchema: {}, execute: () => "ok" }),
      ),
      "eve's isBrandedToolEntry() accepts an entry built by defineTool inside a resolver",
    );

    const allowed = shared.ALLOWED_DYNAMIC_TOOL_EVENTS;
    t.ok(allowed instanceof Set, "ALLOWED_DYNAMIC_TOOL_EVENTS is still a Set of event names");
    t.contains(allowed, "step.started", "`step.started` is still an allowed dynamic-tool event");

    // Not a dependency today, but the difference between step scope and
    // session scope is the whole reason composio.ts uses the former; if eve
    // collapsed them, the choice would need revisiting rather than inheriting.
    t.contains(allowed, "session.started", "`session.started` is still an allowed dynamic-tool event");
    t.contains(allowed, "turn.started", "`turn.started` is still an allowed dynamic-tool event");
  },
};
