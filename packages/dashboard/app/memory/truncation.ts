/**
 * The one number the /memory page was not saying out loud.
 *
 * `app/memory/page.tsx` asks `listMemories` for 200 rows and renders exactly
 * what comes back. The count beside the search box has always shown the real
 * total — `SELECT count(*)` over the same WHERE clause, lib/memories.ts:73 — so
 * the page was not claiming the agent has 200 memories. What it did not say is
 * that the LIST stops there: on an agent with three thousand memories the
 * reader sees "3,000 memories" above a list that ends, with nothing to explain
 * why, and no reason to believe the row they are looking for is not simply
 * absent. That is worse than a wrong number, because the page still looks
 * complete.
 *
 * The limit and the sentence come from the same constant on purpose. The
 * failure this prevents is the one where somebody raises the query to 500 and
 * the page goes on promising 200 — a footnote that is confidently, specifically
 * wrong is the thing an honest one is supposed to rule out.
 *
 * Paging is deliberately not here. `listMemories` takes an `offset`, so the
 * read side is ready, but this list is a hand-rolled `<ul>` in
 * ./memory-client.tsx rather than `components/ui/table.tsx`, so pager controls
 * would be new UI rather than a prop — and search already answers the question
 * a reader with three thousand memories is actually asking. Wired to the table
 * component, or to a cursor, it is a small change; guessed at now, it is a
 * second list widget nobody asked for.
 */

/**
 * How many memories the page reads. Also the number the footnote quotes, which
 * is why it is exported rather than written twice.
 */
export const MEMORY_PAGE_LIMIT = 200;

/**
 * "Showing the most recent 200 of 3,412 memories." — or null when the list on
 * screen really is everything, in which case the page says nothing, matching
 * `app/integrations/page.tsx:238` and `app/traces/[id]/page.tsx:282`, the two
 * places this dashboard already admits to a cap.
 *
 * `shown` is what is on screen after client-side deletions, and `total` is the
 * matching row count with those same deletions taken off it, so the two numbers
 * move together as rows are forgotten instead of the footnote drifting out of
 * step with the list above it.
 */
export function truncationNote(shown: number, total: number, searching: boolean): string | null {
  if (!Number.isFinite(shown) || !Number.isFinite(total)) return null;
  if (shown >= total || shown < 0) return null;
  const count = (value: number): string => Math.trunc(value).toLocaleString("en-US");
  return (
    `Showing the most recent ${count(shown)} of ${count(total)} ` +
    `${searching ? "matching " : ""}${total === 1 ? "memory" : "memories"}.`
  );
}
