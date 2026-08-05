import { defineDynamic, defineTool } from "eve/tools";
import { dayKey, resolveConfig, type BudgetOptions } from "./config.js";
import { readStop } from "./store.js";

/**
 * The half of enforcement that closes the race.
 *
 * Cancellation is cooperative — eve threads no `abortSignal` into model calls
 * (vercel/eve#483) — so between the hook asking for a cancel and the runtime
 * settling the turn, another step can start and call a tool. That step's tokens
 * are already lost, but its *side effects* need not be. Measured on this repo:
 * a follow-up message to an over-budget session ran one more `remember` call
 * and wrote a row before the second cancel landed. This is what stops that.
 *
 * A `step.started` resolver runs before every model call, and a dynamic tool
 * overrides an authored tool of the same name — so naming a tool here replaces
 * it, for that call, with something that refuses and says why. The refusal
 * lands on the stream as an `action.result`, which is the closest an authored
 * extension gets to telling the user what happened.
 *
 * It reads the hook's decision rather than making its own. An earlier version
 * evaluated the caps itself and silently did nothing whenever the two halves
 * were configured differently — a cap passed as an option to `budgetHook()`
 * but not to `budgetGuard()` left this comparing against the default $2.
 *
 * Two limits worth stating plainly:
 *
 * 1. It shadows by name. It cannot remove a tool it is not told to name, and
 *    it must not name a tool that another resolver on `step.started` produces
 *    — two dynamic resolvers emitting one name is an ambiguity eve throws on.
 *    In this template `composio.ts` also resolves on `step.started`, so keep
 *    this list to the authored tools in `agent/tools/`.
 * 2. It does not stop the model call. Only the tools it can reach.
 */

const REFUSAL_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true,
} as const;

export function budgetGuard(options: BudgetOptions = {}) {
  const config = resolveConfig(options);

  return defineDynamic({
    events: {
      "step.started": async (_event, ctx) => {
        if (config.guardTools.length === 0) return null;

        const principalId =
          ctx.session.auth.current?.principalId ??
          ctx.session.auth.initiator?.principalId ??
          "anonymous";

        let stop;
        try {
          stop = await readStop(config, {
            sessionId: ctx.session.id,
            principalId,
            day: dayKey(config),
          });
        } catch (error) {
          // eve catches and skips a resolver that throws, which would restore
          // every tool without saying so. Returning null does the same thing,
          // out loud.
          console.error(
            `[evestack:budget] guard could not read stop state, tools left enabled: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }

        if (!stop) return null;

        const reason = `${stop.reason} Tools are disabled until the budget is raised or the window rolls over.`;

        return Object.fromEntries(
          config.guardTools.map((name) => [
            name,
            defineTool({
              description: `Unavailable — over budget. ${reason}`,
              inputSchema: REFUSAL_INPUT_SCHEMA,
              // Inline on purpose. eve's bundler reconstructs a dynamic tool's
              // executor from stored closure variables on replay and only
              // detects the inline form; `execute: someFn` works on the first
              // step and vanishes on the second.
              execute: () => ({ ok: false, budgetExceeded: true, reason }),
            }),
          ]),
        );
      },
    },
  });
}
