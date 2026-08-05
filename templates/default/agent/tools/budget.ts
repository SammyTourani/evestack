import { budgetGuard } from "@evestack/budget";

/**
 * Closes the gap between "the cap tripped" and "the turn actually stopped".
 *
 * Cancellation is cooperative, so a step can start between the two. Measured
 * here before this file existed: a follow-up message into an already-over-budget
 * session ran one more `remember` call and wrote a row. With the guard on, the
 * same follow-up produced no tool call at all — the model read the shadowed
 * tool's description and told the user the tool was unavailable.
 *
 * It shadows by name, which is why the list is written out rather than
 * discovered. Three rules for editing it:
 *
 *  - add each authored tool in this directory as you add it;
 *  - never add `agent` — overriding a runtime-visible subagent tool throws and
 *    takes the turn with it;
 *  - never add a name another `step.started` resolver produces. `composio.ts`
 *    resolves on `step.started` too, and two dynamic resolvers emitting one
 *    name is an ambiguity eve throws on.
 *
 * The caps are not configured here. This reads the decision the hook already
 * made — one evaluator, one answer. Configuring them in both places is exactly
 * the bug this file used to have: a cap passed to `budgetHook()` and not to
 * `budgetGuard()` left the guard comparing against the default and silently
 * leaving every tool enabled.
 */
export default budgetGuard({
  guardTools: ["remember", "recall", "forget", "bash", "write_file", "web_fetch"],
});
