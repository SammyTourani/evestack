import { budgetHook } from "@evestack/budget";

/**
 * A spend cap that is on before you ask for one.
 *
 * $2 per session and $10 per user per day, out of the box, on the Postgres this
 * project already runs. Both are one environment variable away from being
 * anything else, and `EVESTACK_BUDGET_DISABLED=1` turns the whole thing off.
 *
 * The second number is the one eve cannot have. Every limit eve ships is scoped
 * to a single durable session — including the 40,000,000-input-token default,
 * which is somewhere between $120 and $600 depending on the model, with output
 * uncapped. A caller who wants more starts a new session (vercel/eve#551). A
 * cap that means anything has to outlive the conversation, and that needs a
 * store. This distribution has one.
 *
 * eve's own `limits.maxInputTokensPerSession` is still worth setting in
 * `agent.ts` if a token ceiling on one session is what you want — it is a
 * supported path with a proper Approve/Stop continuation prompt, and this hook
 * does not replace it. It just cannot be denominated in dollars, and it cannot
 * outlive the session.
 *
 * What this does NOT do: kill a generation that is already running. eve threads
 * no `abortSignal` into model calls, so enforcement happens between steps. It
 * pauses at the cap, plus at most one step that was already in flight. The
 * package README says the same thing in the same words, on purpose.
 */
export default budgetHook();
