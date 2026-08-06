"use client";

/**
 * The table W5 lives in.
 *
 * Built on TanStack Table v8 — v9 is beta — for sorting, filtering and the
 * faceted value counts, and on TanStack Virtual for long lists. Everything
 * visual comes from the tokens, so it matches the `table` rules that
 * `app/globals.css` has drawn since launch.
 *
 * ## The accessibility decisions, because they are the ones with consequences
 *
 * **It stays a real `<table>`.** The usual virtualized table is a stack of
 * absolutely positioned `<div>`s, which is faster to write and unnavigable: a
 * screen reader loses row and column position, "next column" stops working, and
 * the header no longer announces with the cell. Rows here are `<tr>`s inside
 * `<tbody>`, and virtualization is done with two spacer rows.
 *
 * **`aria-rowcount` and `aria-rowindex`.** With virtualization on, the DOM
 * holds thirty rows out of two thousand, so the count a screen reader would
 * infer is wrong by two orders of magnitude. These attributes state the real
 * total and each row's real position. The spacers are `aria-hidden`.
 *
 * **Sorting is a `<button>` inside a `<th aria-sort>`.** Not a click handler on
 * the `<th>`, which is unreachable by keyboard, and not an icon-only control,
 * which is unlabelled.
 *
 * **Row count is announced.** Filtering is instant and silent otherwise: a
 * sighted user sees the table shrink and a screen reader user gets nothing.
 *
 * ## Virtualization is off by default
 *
 * Every page in this app is `force-dynamic` and server-rendered, and a
 * virtualizer has no scroll element on the server, so it renders an empty body
 * until hydration. That is a real regression for the common case, and the
 * common case is small: W5 paginates. So the table renders every row until
 * there are more than `virtualizeAfter` of them, and only then trades
 * server-rendered rows for a body that can scroll two thousand.
 */
import {
  type Column,
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { Placeholder } from "./feedback";
import { EM_DASH } from "./format";
import { Popover } from "./popover";
import { type CellValue, columnIdOf, facetFilterFn, facetOptions } from "./table-filter";
import { BARE_BUTTON, CONTROL, FIELD, FOCUS_RING } from "./style";

/** A column definition. See `CellValue` for why the value type is open. */
export type TableColumn<T> = ColumnDef<T, CellValue>;

export interface DataTableProps<T> {
  readonly data: readonly T[];
  readonly columns: readonly TableColumn<T>[];
  /**
   * What the table is, for a screen reader. Rendered as a visually hidden
   * `<caption>` — the element that exists for exactly this and that a `<div>`
   * grid cannot have.
   */
  readonly caption: string;
  /** Anything thrown while loading. Replaces the table with an error state. */
  readonly error?: ReactNode;
  readonly emptyTitle?: string;
  readonly emptyDetail?: ReactNode;
  /** Column ids to offer as faceted filters, in toolbar order. */
  readonly facetColumns?: readonly string[];
  /** Enables the free-text filter across every column when set. */
  readonly searchPlaceholder?: string;
  readonly initialSorting?: SortingState;
  /** Stable ids, so selection survives a re-sort. */
  readonly getRowId?: (row: T, index: number) => string;
  /** Controls above the table, on the same line as the facet chips. */
  readonly toolbar?: ReactNode;
  /** Rows before the body starts scrolling and virtualizing. */
  readonly virtualizeAfter?: number;
  /** Height of the scroll container once virtualized, in pixels. */
  readonly maxBodyHeight?: number;
}

/** `td` padding 11px twice plus a 21px line box plus the 1px rule. */
const ROW_HEIGHT = 44;

/**
 * What a cell renders when its column says nothing else.
 *
 * TanStack's default is `getValue()`, which renders an empty cell for `null`
 * and `undefined` — and an empty cell is indistinguishable from a value that
 * happens to be blank. `fact_turn.environment` is NULL on 1,552 of 1,922 seeded
 * turns, so that is most of a column, silently.
 *
 * Putting it here rather than in each column definition is the point: "an
 * absent value is an em dash, never a zero" then holds for every table by
 * default, and a column opts out by declaring its own `cell`.
 */
const DEFAULT_COLUMN = {
  cell: ({ getValue }: { getValue: () => CellValue }) => {
    const value = getValue();
    if (value === null || value === undefined || value === "") return EM_DASH;
    // Deliberately not `false`: a boolean column's `false` is a measured value.
    return value as ReactNode;
  },
};

export function DataTable<T>({
  data,
  columns,
  caption,
  error,
  emptyTitle = "Nothing here",
  emptyDetail,
  facetColumns = [],
  searchPlaceholder,
  initialSorting = [],
  getRowId,
  toolbar,
  virtualizeAfter = 150,
  maxBodyHeight = 560,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Every faceted column gets the null-aware filter attached here rather than
  // at the call site. Leaving it to the caller means a column that forgets it
  // falls back to TanStack's `auto` filter, which given an array of selected
  // values matches nothing — a filter that empties the table and looks like bad
  // data.
  const resolved = useMemo(
    () =>
      columns.map((def) => {
        const id = columnIdOf(def);
        return id !== null && facetColumns.includes(id) ? { ...def, filterFn: facetFilterFn } : def;
      }),
    [columns, facetColumns],
  );

  const table = useReactTable({
    data: data as T[],
    columns: resolved,
    defaultColumn: DEFAULT_COLUMN,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  const rows = table.getRowModel().rows;
  const virtualize = rows.length > virtualizeAfter;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    enabled: virtualize,
  });

  const virtualRows = virtualize ? virtualizer.getVirtualItems() : [];
  const padTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const padBottom =
    virtualRows.length > 0
      ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0;
  const visible = virtualize ? virtualRows.map((v) => ({ row: rows[v.index], index: v.index })) : rows.map((row, index) => ({ row, index }));

  if (error !== undefined && error !== null) {
    return <Placeholder tone="error" title="Could not load this table" detail={error} />;
  }

  const headerGroups = table.getHeaderGroups();
  const columnCount = table.getAllLeafColumns().length;

  return (
    <div>
      {(searchPlaceholder || facetColumns.length > 0 || toolbar) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {searchPlaceholder ? (
            <input
              type="search"
              value={globalFilter}
              onChange={(event) => setGlobalFilter(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className={`w-56 ${FIELD}`}
            />
          ) : null}
          {facetColumns.map((id) => {
            const column = table.getColumn(id);
            return column ? <FacetChip key={id} column={column} /> : null;
          })}
          {toolbar}
        </div>
      )}

      {/* Announced on change, invisible always. Filtering is otherwise silent
          to anyone who cannot see the table get shorter. */}
      <p aria-live="polite" className="sr-only">
        {rows.length} of {data.length} rows shown
      </p>

      <div
        ref={scrollRef}
        className="overflow-x-auto rounded-md border border-border"
        style={virtualize ? { maxHeight: maxBodyHeight, overflowY: "auto" } : undefined}
      >
        <table
          className="w-full border-collapse bg-bg-raised"
          aria-rowcount={rows.length + 1}
        >
          <caption className="sr-only">{caption}</caption>
          <thead className={virtualize ? "sticky top-0 z-10 bg-bg-raised" : undefined}>
            {headerGroups.map((group) => (
              <tr key={group.id} aria-rowindex={1}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const label = flexRender(header.column.columnDef.header, header.getContext());
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        !header.column.getCanSort()
                          ? undefined
                          : sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : "none"
                      }
                      className="border-b border-border px-3.5 py-2.5 text-left text-micro font-medium tracking-[0.06em] whitespace-nowrap text-text-faint uppercase"
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={`${BARE_BUTTON} inline-flex items-center gap-1 rounded-sm text-micro tracking-[0.06em] uppercase hover:text-text`}
                        >
                          {label}
                          <span aria-hidden="true" className="text-text-faint">
                            {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}
                          </span>
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="p-0">
                  <Placeholder title={emptyTitle} detail={emptyDetail} />
                </td>
              </tr>
            ) : (
              <>
                {padTop > 0 ? (
                  <tr aria-hidden="true">
                    <td colSpan={columnCount} style={{ height: padTop }} />
                  </tr>
                ) : null}
                {visible.map(({ row, index }) => (
                  <tr
                    key={row.id}
                    // Measured rather than assumed. `ROW_HEIGHT` is only the
                    // first guess; a cell that wraps to two lines makes every
                    // row below it land in the wrong place if the estimate is
                    // treated as fact.
                    ref={virtualize ? virtualizer.measureElement : undefined}
                    data-index={index}
                    // Header is row 1, so the first body row is row 2.
                    aria-rowindex={index + 2}
                    className="border-b border-border last:border-b-0 hover:bg-bg-hover"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3.5 py-2.5 align-top text-body">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
                {padBottom > 0 ? (
                  <tr aria-hidden="true">
                    <td colSpan={columnCount} style={{ height: padBottom }} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * One faceted filter: a chip that opens a checkbox list of the values actually
 * present, with counts, plus a Clear that only appears once something is
 * selected.
 */
function FacetChip<T>({ column }: { column: Column<T, unknown> }) {
  const selected = (column.getFilterValue() as (string | null)[] | undefined) ?? [];
  const options = facetOptions(column.getFacetedUniqueValues());
  const name = String(
    typeof column.columnDef.header === "string" ? column.columnDef.header : column.id,
  );

  const toggle = (key: string | null) => {
    const next = selected.includes(key)
      ? selected.filter((k) => k !== key)
      : [...selected, key];
    // An empty array is "no filter" in matchesFacet, but leaving it set keeps a
    // pointless predicate on every row — clear it instead.
    column.setFilterValue(next.length > 0 ? next : undefined);
  };

  return (
    <Popover
      label={`Filter by ${name}`}
      trigger={
        <button type="button" className={CONTROL}>
          {name}
          {selected.length > 0 ? (
            <span className="rounded-full bg-bg-hover px-1.5 text-micro text-text">
              {selected.length}
            </span>
          ) : null}
          <span aria-hidden="true">▾</span>
        </button>
      }
    >
      {options.length === 0 ? (
        <p className="m-0 px-2 py-1.5 text-small text-text-faint">No values in this column.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {options.map((option) => (
            <li key={option.key ?? " null"}>
              <label
                className={`flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-body hover:bg-bg-hover`}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(option.key)}
                  onChange={() => toggle(option.key)}
                  className={FOCUS_RING}
                />
                <span className="grow">{option.label}</span>
                <span className="tabular-nums text-text-faint">{option.count}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {selected.length > 0 ? (
        <button
          type="button"
          onClick={() => column.setFilterValue(undefined)}
          className={`${BARE_BUTTON} mt-1 w-full rounded-sm px-2 py-1.5 text-small text-text-dim hover:bg-bg-hover hover:text-text`}
        >
          Clear
        </button>
      ) : null}
    </Popover>
  );
}
