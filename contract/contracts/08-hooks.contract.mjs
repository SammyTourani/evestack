/**
 * Hooks are observe-only, and that is a load-bearing fact.
 *
 * eve's own guide states it plainly ("Handlers are observe-only. They cannot
 * inject model context."), and evestack's architecture is built on top of it:
 * a hook cannot block or park a turn, so any enforcement evestack wants has to
 * happen either at the approval gate or between steps via eve's HTTP routes.
 *
 * This contract pins the fact in both directions. If a handler's return type
 * ever becomes meaningful, eve has introduced real interception and evestack's
 * "enforcement is necessarily between steps" design note is obsolete — a good
 * thing to be told about, and not something a typecheck would ever mention,
 * because a handler returning `void` still satisfies a wider return type.
 */

export default {
  id: "hooks/observe-only-and-event-names",
  title: "hook handlers stay side-effect-only, and the events evestack watches still exist",
  assumption:
    "A hook handler returns `void | Promise<void>` — it cannot block, park or alter a turn — and eve still " +
    "surfaces the session/turn/step lifecycle events to authored hooks.",
  evestackUse:
    "evestack's observability and any hook-driven control loop depend on this being true. Because a hook " +
    "cannot park a turn, cancellation has to go through POST /eve/v1/session/:sessionId/cancel and lands " +
    "*between* steps — eve does not thread an abortSignal into model calls, so an in-flight generation keeps " +
    "streaming regardless (vercel/eve#483). docs/ and packages/dashboard both describe cancellation that " +
    "way. If eve makes handlers blocking, that design is stale and a much better enforcement point exists; " +
    "if these event names disappear, hooks stop firing with no error at all.",

  async check(eve, t) {
    const hooks = await eve.loadPublic("eve/hooks");
    t.equal(typeof hooks.defineHook, "function", "eve/hooks still exports defineHook()");

    const hookTypes = eve.readFile("dist/src/public/definitions/hook.d.ts");

    // The return type is the whole claim. Anything other than void here means
    // eve started listening to what a handler gives back.
    t.ok(
      /StreamEventHook<TEvent>\s*=\s*\(event:\s*TEvent,\s*ctx:\s*HookContext\)\s*=>\s*void \| Promise<void>/.test(
        hookTypes,
      ),
      "StreamEventHook still returns `void | Promise<void>` — handlers remain observe-only",
      {
        expected: "(event, ctx) => void | Promise<void>",
        actual: /StreamEventHook<TEvent>[^;]*/.exec(hookTypes)?.[0]?.replace(/\s+/g, " ") ?? "declaration not found",
      },
    );

    for (const event of [
      "session.started",
      "session.waiting",
      "turn.started",
      "turn.completed",
      "turn.cancelled",
      "step.started",
      "step.completed",
      "actions.requested",
      "input.requested",
    ]) {
      t.contains(hookTypes, `"${event}"`, `HookEventMap still exposes \`${event}\` to authored hooks`);
    }
  },
};
