/**
 * Which sessions are worth turning into a test, and in what order.
 *
 * A `.ts` module rather than a function inside `page.tsx` for the reason
 * `app/sessions/rollup.ts` and `app/overview.ts` are: the test loader does not
 * handle `.tsx`, so logic that lives in a page cannot be unit-tested — and this
 * is the editorial judgement of the whole page, not a rendering detail.
 *
 * That mattered here. The `failed` grade was unreachable for the life of this
 * page: it read `session.status === "failed"`, and eve never fails a SESSION
 * run. A turn killed by a provider error is handled by the workflow, so the turn
 * carries the error_code and the session row stays `completed` —
 * `lib/monitors.ts` writes this down, and it is the same trap that made the old
 * failure rate undercount. Measured on the seeded month: ZERO sessions carry
 * their own error_code while NINETY-NINE contain a failed turn. The most
 * valuable category on the page was permanently empty and the page looked fine.
 *
 * `evestack.fact_turn.outcome` is what makes the honest version a single cheap
 * query, and it did not exist when this page was written.
 */

export type Grade = "denial" | "failed" | "plain" | "empty";

/** Lower sorts first: a denial is the most valuable thing to pin. */
export const RANK: Record<Grade, number> = { denial: 0, failed: 1, plain: 2, empty: 3 };

export function gradeOf(
  session: { readonly turnCount: number },
  deniedTools: readonly string[],
  failedTurns: number,
): Grade {
  if (session.turnCount === 0) return "empty";
  // A human said no to something. That path is the one that used to break the
  // durable session outright (vercel/eve#1658), so it outranks a plain failure.
  if (deniedTools.length > 0) return "denial";
  if (failedTurns > 0) return "failed";
  return "plain";
}
