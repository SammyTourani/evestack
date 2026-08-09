/**
 * The /memory page's cap, and the sentence that admits to it.
 *
 * `app/memory/page.tsx` reads 200 rows. Before this, the list simply ended
 * there — the count beside the search box showed the true total, so the page
 * never claimed the agent had 200 memories, but nothing on it said the LIST was
 * short. A reader who scrolled to the bottom looking for a belief the agent has
 * and did not find it had no way to tell "not remembered" from "past row 200".
 *
 * These assert the two things that make the footnote trustworthy: it names both
 * numbers, and it is silent when the list really is complete — a page that
 * apologises for truncation it did not do is its own kind of wrong.
 *
 * Not asserted here: the markup. `test/ui-render.mjs` cannot load
 * `app/memory/memory-client.tsx`, which imports through the `@/` alias and a
 * CSS module, neither of which its resolve hook handles; teaching it both is a
 * change to a shared test harness other work is editing right now. The sentence
 * is a pure function for exactly that reason, and the component does nothing to
 * it but render it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { MEMORY_PAGE_LIMIT, truncationNote } = await import(
  new URL("../app/memory/truncation.ts", import.meta.url).href
);

test("a truncated list names how many are shown and how many exist", () => {
  const note = truncationNote(MEMORY_PAGE_LIMIT, 3412, false);
  assert.equal(note, "Showing the most recent 200 of 3,412 memories.");
});

test("the page's own limit is the number the sentence quotes", async () => {
  // The drift this exists to stop: the query is raised and the footnote keeps
  // promising 200. Read as text rather than executed, because page.tsx is an
  // async server component that opens a database connection on import.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../app/memory/page.tsx", import.meta.url), "utf8");
  assert.match(source, /limit:\s*MEMORY_PAGE_LIMIT/);
  assert.doesNotMatch(source, /limit:\s*\d/, "the row cap must come from the shared constant");
});

test("a complete list says nothing at all", () => {
  assert.equal(truncationNote(12, 12, false), null);
  assert.equal(truncationNote(0, 0, false), null);
  // Deleting rows can only take the totals down together; it must never produce
  // an apology for a truncation that is no longer happening.
  assert.equal(truncationNote(200, 199, false), null);
});

test("a search says what the total is a total OF", () => {
  // "of 41 memories" under a filtered list would read as the whole table, which
  // is a different and much more alarming number than 41 matches.
  assert.equal(truncationNote(20, 41, true), "Showing the most recent 20 of 41 matching memories.");
});

test("the singular is not stranded", () => {
  assert.equal(truncationNote(0, 1, false), "Showing the most recent 0 of 1 memory.");
});

test("nonsense in, silence out", () => {
  assert.equal(truncationNote(Number.NaN, 100, false), null);
  assert.equal(truncationNote(10, Number.NaN, false), null);
  assert.equal(truncationNote(-1, 100, false), null);
});
