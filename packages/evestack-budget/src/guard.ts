import { defineDynamic, defineTool } from "eve/tools";
import {
  dayKey,
  isUncapped,
  resolveConfig,
  type BudgetOptions,
} from "./config.js";
import { readStop } from "./store.js";
import { runtimeBudgetConfig } from "./runtime-settings.js";

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

/**
 * True once the "this guard guards nothing" line has been printed.
 *
 * At construction rather than per step, and once per process rather than once
 * per call, for the same reason the warned-set above `dayKey` exists: a line
 * repeated on every model call is a line nobody reads.
 */
let warnedEmptyGuardTools = false;

export function budgetGuard(options: BudgetOptions = {}) {
  const config = resolveConfig(options);

  /**
   * The configuration in which this file is an elaborate no-op, said out loud.
   *
   * `guardTools` defaults to an EMPTY list — `EVESTACK_BUDGET_GUARD_TOOLS` is
   * unset in every `.env.example` this repo ships — and the resolver's first
   * line returns null when the list is empty. So `budgetGuard()` written with no
   * arguments installs a `step.started` resolver that has never shadowed a tool
   * and never will, while reading in the agent's source exactly like protection.
   * Nothing said so: there was no error, no log line, and the dashboard shows the
   * hook's stop rows whether or not anything honours them. The scaffolded
   * `agent/tools/budget.ts` passes a real list, so this is specifically the
   * hand-written call that is being caught.
   *
   * Only when a cap is actually being enforced. Someone who has set
   * `EVESTACK_BUDGET_DISABLED=1`, turned both axes off, or chosen `observe` to
   * measure before enforcing has no stop for a guard to honour, and telling them
   * their guard guards nothing is noise about a decision they already made.
   */
  const guardsNothing =
    config.guardTools.length === 0 &&
    !isUncapped(config) &&
    config.mode !== "observe";
  if (guardsNothing && !warnedEmptyGuardTools) {
    warnedEmptyGuardTools = true;
    console.warn(
      "[evestack:budget] budgetGuard() has no tools to shadow, so it will do nothing when the " +
        'budget runs out. It shadows tools BY NAME: pass guardTools: ["remember", "bash", ...] ' +
        "or set EVESTACK_BUDGET_GUARD_TOOLS to a comma-separated list of the authored tools in " +
        "agent/tools/. If you do not want a guard, delete the file that calls budgetGuard() — the " +
        "hook still enforces the cap without it.",
    );
  }

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
          const current = await runtimeBudgetConfig(config);
          stop = await readStop(current, {
            sessionId: ctx.session.id,
            principalId,
            day: dayKey(current),
          });
        } catch (error) {
          // eve catches and skips a resolver that throws, which would restore
          // every tool without saying so. Returning null does the same thing,
          // out loud.
          console.error(
            `[evestack:budget] guard could not read stop state, tools ${config.dashboardControls ? "blocked" : "left enabled"}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (!config.dashboardControls) return null;
          stop = {
            reason:
              "Budget settings or stop state could not be read. These tools remain unavailable until the next successful check.",
          };
        }

        if (!stop) return null;

        const reason = `${stop.reason} Review budget state before the next step.`;

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
