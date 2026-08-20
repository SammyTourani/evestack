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

const { MEMORY_DELETIONS_LIMIT, MEMORY_PAGE_LIMIT, deletionsNote, truncationNote } = await import(
  new URL("../app/memory/truncation.ts", import.meta.url).href
);

const { readFileSync } = await import("node:fs");
/**
 * page.tsx as text. It is an async server component that opens a database
 * connection on import, so every claim about it here is made by reading it —
 * the same technique the second test below already used, hoisted because the
 * audit-trail tests need it too.
 */
const PAGE = readFileSync(new URL("../app/memory/page.tsx", import.meta.url), "utf8");

test("a truncated list names how many are shown and how many exist", () => {
  const note = truncationNote(MEMORY_PAGE_LIMIT, 3412, false);
  assert.equal(note, "Showing the most recent 200 of 3,412 memories.");
});

test("the page's own limit is the number the sentence quotes", () => {
  // The drift this exists to stop: the query is raised and the footnote keeps
  // promising 200.
  assert.match(PAGE, /limit:\s*MEMORY_PAGE_LIMIT/);
  assert.doesNotMatch(PAGE, /limit:\s*\d/, "the row cap must come from the shared constant");
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

/*
 * ── The deletion audit trail ────────────────────────────────────────────────
 *
 * `evestack.memory_deletions` was write-only. `deleteMemory` wrote a row on
 * every permanent delete (lib/memories.ts:141) and `listMemoryDeletions` — the
 * only function that reads one — had no caller anywhere in the repo, so the
 * trail existed solely for someone holding a psql prompt. These pin the three
 * properties that make it real: something reads it, the reader admits to its
 * cap, and a failed read is never dressed up as an empty one.
 */

test("the page actually reads the deletion trail back", () => {
  // The regression this exists to stop is the whole defect returning: an audit
  // row written on every irreversible delete and nothing in the product that
  // can show it. A caller is the entire fix, so a caller is what is asserted.
  assert.match(PAGE, /listMemoryDeletions/, "nothing on /memory reads evestack.memory_deletions");
  assert.match(
    PAGE,
    /await\s+listMemoryDeletions\(MEMORY_DELETIONS_LIMIT\)/,
    "the trail must be read with the shared cap, not a literal",
  );
});

test("a failed audit read is reported, never rendered as an empty trail", () => {
  // "I could not look" and "nothing was deleted" are opposite answers to the
  // one question this table exists to answer, and they render identically if
  // the catch swallows. Same defect class as contract 22.
  assert.match(PAGE, /deletionsError/, "the audit read has no error state");
  assert.match(
    PAGE,
    /not evidence that nothing was\s*\n?\s*deleted/,
    "the failure state must say it is not an all-clear",
  );
});

test("a capped deletion list says so, and names the number it capped at", () => {
  assert.equal(
    deletionsNote(MEMORY_DELETIONS_LIMIT, MEMORY_DELETIONS_LIMIT),
    "Showing the 20 most recent deletions.",
  );
  // The drift: someone raises MEMORY_DELETIONS_LIMIT and the sentence keeps
  // promising the old number. It is derived, so it cannot.
  assert.equal(deletionsNote(5, 5), "Showing the 5 most recent deletions.");
});

test("a complete deletion trail apologises for nothing", () => {
  // A `LIMIT n` read that came back short is proof there is no n+1th row, so a
  // footnote here would be an apology for a truncation that did not happen.
  assert.equal(deletionsNote(0, MEMORY_DELETIONS_LIMIT), null);
  assert.equal(deletionsNote(19, MEMORY_DELETIONS_LIMIT), null);
  assert.equal(deletionsNote(Number.NaN, MEMORY_DELETIONS_LIMIT), null);
  assert.equal(deletionsNote(5, Number.NaN), null);
  assert.equal(deletionsNote(0, 0), null);
});
