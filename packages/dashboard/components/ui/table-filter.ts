/**
 * The faceted filter's two decisions, kept out of the component so they can be
 * asserted rather than clicked.
 *
 * Both are about absence, which is where every table filter this survey looked
 * at gets it wrong. `fact_turn.environment` is NULL on 1,552 of 1,922 seeded
 * turns and `error_code` is NULL on almost all of them, so "no value" is not an
 * edge case here, it is the majority of the column. A facet list that silently
 * drops the null bucket hides most of the table, and one that renders it as an
 * empty string gives you a checkbox with no label.
 */

import type { ColumnDef, FilterFn } from "@tanstack/react-table";

import { EM_DASH } from "./format";

/**
 * The cell value type TanStack's own options use, spelled once.
 *
 * It has to be `any`: `TableOptions.columns` is `ColumnDef<TData, any>[]`, and
 * narrowing it would force every column in one table to share a single cell
 * value type, which no real table does. Naming it makes the two places that
 * need it say the same thing, and makes the reason findable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CellValue = any;

/**
 * A cell value as a selection key. `null` and `undefined` are the same fact —
 * the column has no value on this row — so they collapse to one bucket, and
 * everything else is compared by its string form because that is what a
 * checkbox list can hold.
 */
function facetKey(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/** What the checkbox says. The null bucket gets the same em dash as a cell. */
function facetLabel(key: string | null): string {
  return key ?? EM_DASH;
}

/**
 * Does this row survive the selection?
 *
 * An empty selection means "no filter", not "nothing matches". Getting that
 * backwards empties the table the instant someone opens a facet popover and
 * unticks the last box, which reads as a bug in the data rather than in the
 * filter.
 */
export function matchesFacet(value: unknown, selected: readonly (string | null)[]): boolean {
  if (selected.length === 0) return true;
  return selected.includes(facetKey(value));
}

/**
 * Distinct values with counts, ordered by count and then by label so the list
 * is stable across renders. Built from TanStack's faceted map, which is already
 * computed over the rows that survive every *other* column's filter — the
 * behaviour that lets you see how many failures are left inside the model you
 * just picked.
 */
export function facetOptions(
  uniqueValues: ReadonlyMap<unknown, number>,
): readonly { key: string | null; label: string; count: number }[] {
  const counts = new Map<string | null, number>();
  for (const [value, count] of uniqueValues) {
    const key = facetKey(value);
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return [...counts]
    .map(([key, count]) => ({ key, label: facetLabel(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The TanStack filter a faceted column runs.
 *
 * Not registered by name. TanStack's `filterFn: "facet"` needs a module
 * augmentation of its `FilterFns` interface to typecheck, and a magic string
 * that resolves through a global declaration is exactly the kind of wiring that
 * breaks quietly — a typo falls back to the built-in `auto` filter, which for
 * an array filter value silently matches nothing.
 */
export const facetFilterFn: FilterFn<CellValue> = (row, columnId, value) =>
  matchesFacet(row.getValue(columnId), (value as (string | null)[] | undefined) ?? []);

/**
 * A column definition's id, the way TanStack derives it: an explicit `id`, else
 * the `accessorKey`. Needed because `DataTable` attaches `facetFilterFn` to the
 * columns named in `facetColumns` before the table is built, and at that point
 * the resolved `Column` objects do not exist yet.
 *
 * Returns null for an accessor-function column with no `id`, which TanStack
 * itself rejects at runtime — better to skip it here than to guess a name.
 */
export function columnIdOf<T>(def: ColumnDef<T, CellValue>): string | null {
  if (def.id !== undefined) return def.id;
  const key = (def as { accessorKey?: unknown }).accessorKey;
  return typeof key === "string" || typeof key === "number" ? String(key) : null;
}
