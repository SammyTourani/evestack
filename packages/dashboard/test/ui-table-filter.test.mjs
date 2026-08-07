/**
 * components/ui/table-filter.ts — the faceted filter's handling of absence.
 *
 * On the seeded month `fact_turn.environment` is NULL on 1,552 of 1,922 rows,
 * so every one of these cases is the majority case, not an edge. The failures
 * they guard all look like data problems rather than filter problems: a facet
 * list missing most of the table, a checkbox with no label, and — the worst —
 * an empty table the moment someone unticks the last box.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { EM_DASH } from "../components/ui/format.ts";
import { columnIdOf, facetOptions, matchesFacet } from "../components/ui/table-filter.ts";

test("null, undefined and empty string are one bucket, and it is labelled", () => {
  const options = facetOptions(new Map([[null, 1], [undefined, 1], ["", 1]]));
  assert.deepEqual(options, [{ key: null, label: EM_DASH, count: 3 }]);
  // A real value is never absorbed into it, including the falsy ones a naive
  // `if (!value)` would swallow.
  const falsy = facetOptions(new Map([[0, 1], [false, 1], [null, 1]]));
  assert.deepEqual(
    falsy.map((o) => o.label).sort(),
    ["0", EM_DASH, "false"].sort(),
  );
});

test("an empty selection is no filter, not no matches", () => {
  assert.equal(matchesFacet("ok", []), true);
  assert.equal(matchesFacet(null, []), true);
});

test("the null bucket is selectable and selects only nulls", () => {
  assert.equal(matchesFacet(null, [null]), true);
  assert.equal(matchesFacet(undefined, [null]), true);
  assert.equal(matchesFacet("development", [null]), false);
  assert.equal(matchesFacet("development", ["development", null]), true);
});

test("options merge the absent forms into one row and order by count", () => {
  const options = facetOptions(
    new Map([
      ["development", 370],
      [null, 1000],
      [undefined, 552],
      ["", 0],
    ]),
  );
  assert.deepEqual(options, [
    { key: null, label: EM_DASH, count: 1552 },
    { key: "development", label: "development", count: 370 },
  ]);
});

test("options are stable when two values tie on count", () => {
  const options = facetOptions(new Map([["zulu", 5], ["alpha", 5]]));
  assert.deepEqual(
    options.map((o) => o.label),
    ["alpha", "zulu"],
  );
});

test("a column id comes from `id`, then `accessorKey`, then nowhere", () => {
  assert.equal(columnIdOf({ id: "outcome", accessorKey: "other" }), "outcome");
  assert.equal(columnIdOf({ accessorKey: "model" }), "model");
  // An accessor-function column with no id: DataTable must skip it rather than
  // invent a name and attach the facet filter to the wrong column.
  assert.equal(columnIdOf({ accessorFn: (row) => row.x }), null);
});
