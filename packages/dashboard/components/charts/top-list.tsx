"use client";

/**
 * The ranked list that sits under a chart, re-sortable by error rate or
 * duration. Vercel Observability puts one below every graph and it is the step
 * that turns "something got slower" into "this tool got slower".
 *
 * It is a table, not a chart. That is the accessibility decision and the
 * usability one at the same time: the bars are `<div>`s sized in percent
 * behind real table cells, so the numbers are selectable, the sort is a
 * `<button>` in a `<th aria-sort>`, and nothing about the ranking depends on
 * being able to compare two bar lengths by eye.
 *
 * A column appears only if at least one row carries that field. A sort control
 * for a column of em dashes is a control that does nothing, and offering it
 * implies the data exists.
 *
 * `pl-0`, `border-b-0`, `normal-case`, `tracking-normal` and an explicit text
 * size appear on every cell below and none of them are decoration.
 * `app/globals.css` styles bare `th` and `td` inside `@layer app` for the dense
 * record tables the pages already draw: uppercase, letter-spaced, 11px, 14px of
 * side padding, a bottom border. Utilities outrank that layer, but only for
 * properties they set, so whatever is left unstated leaks through — which is
 * how `read_file` first rendered here as `READ_FILE`, silently renaming a tool.
 */

import { useMemo, useState } from "react";

import { ABSENT, formatValue, type Unit } from "./lib/format";
import {
  barFraction,
  errorRate,
  rankKeyLabel,
  rankMax,
  rankRows,
  type RankDirection,
  type RankKey,
  type RankRow,
} from "./lib/rank";

export interface TopListProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly rows: readonly RankRow[];
  /** The unit of `value`. */
  readonly unit: Unit;
  /** Column heading for `value`: "calls", "spend". */
  readonly valueLabel: string;
  /** Column heading for `durationMs`, which is usually a percentile. */
  readonly durationLabel?: string;
  /** How many rows to draw. The rest are counted in a note. */
  readonly limit?: number;
  readonly defaultSort?: RankKey;
}

export function TopList(props: TopListProps) {
  const durationLabel = props.durationLabel ?? "duration";
  const hasErrorRate = props.rows.some((r) => r.total !== undefined || r.errors !== undefined);
  const hasDuration = props.rows.some((r) => r.durationMs !== undefined);

  const [sort, setSort] = useState<{ key: RankKey; direction: RankDirection }>({
    key: props.defaultSort ?? "value",
    direction: "desc",
  });

  const ordered = useMemo(
    () => rankRows(props.rows, sort.key, sort.direction),
    [props.rows, sort.key, sort.direction],
  );
  const limit = props.limit ?? ordered.length;
  const shown = ordered.slice(0, limit);
  const max = useMemo(() => rankMax(props.rows, sort.key), [props.rows, sort.key]);

  function toggle(key: RankKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-bg-raised p-4">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-section font-medium text-text">{props.title}</h3>
        {props.subtitle === undefined ? null : (
          <p className="m-0 text-small text-text-dim">{props.subtitle}</p>
        )}
        {ordered.length > shown.length ? (
          <p className="m-0 text-small text-text-dim">
            Showing {shown.length} of {ordered.length}.
          </p>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <p className="flex min-h-24 items-center justify-center rounded-md border border-dashed border-border text-small text-text-dim">
          Nothing to rank in this range.
        </p>
      ) : (
        <table className="w-full border-collapse text-small">
          <caption className="sr-only">
            {props.title}, sorted by {rankKeyLabel(sort.key, props.valueLabel, durationLabel)},{" "}
            {sort.direction === "desc" ? "highest first" : "lowest first"}. Column headings sort
            the table.
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="border-b-0 py-1 pr-3 pl-0 text-left text-small font-medium tracking-normal text-text-dim normal-case"
              >
                name
              </th>
              <SortHeader
                label={props.valueLabel}
                active={sort.key === "value"}
                direction={sort.direction}
                onSort={() => toggle("value")}
              />
              {hasErrorRate ? (
                <SortHeader
                  label="error rate"
                  active={sort.key === "errorRate"}
                  direction={sort.direction}
                  onSort={() => toggle("errorRate")}
                />
              ) : null}
              {hasDuration ? (
                <SortHeader
                  label={durationLabel}
                  active={sort.key === "duration"}
                  direction={sort.direction}
                  onSort={() => toggle("duration")}
                />
              ) : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => {
              const fraction = barFraction(row, sort.key, max);
              const rate = errorRate(row);
              return (
                <tr key={row.id} className="border-t border-border">
                  <th scope="row" className="relative border-b-0 py-1 pr-3 pl-0 text-left text-small font-normal tracking-normal whitespace-normal text-text normal-case">
                    {/* The bar is behind the label rather than in its own
                        column, so a long list stays scannable and the label is
                        never pushed off the row by the chart. */}
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0.5 left-0 rounded-sm bg-bg-hover"
                      style={{ width: fraction === null ? 0 : `${fraction * 100}%` }}
                    />
                    <span className="relative">
                      {index + 1}. {row.href === undefined ? (
                        row.label
                      ) : (
                        <a
                          href={row.href}
                          className="underline decoration-border underline-offset-2 hover:decoration-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        >
                          {row.label}
                        </a>
                      )}
                    </span>
                  </th>
                  <Cell text={formatValue(row.value, props.unit)} />
                  {hasErrorRate ? (
                    <Cell
                      text={formatValue(rate, "ratio")}
                      tone={rate !== null && rate > 0 ? "err" : undefined}
                    />
                  ) : null}
                  {hasDuration ? (
                    <Cell text={formatValue(row.durationMs ?? null, "ms")} />
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Cell({ text, tone }: { text: string; tone?: "err" }) {
  const absent = text === ABSENT;
  const colour = absent ? "text-text-faint" : tone === "err" ? "text-err" : "text-text";
  return (
    <td className={`border-b-0 py-1 pr-3 pl-0 text-right align-middle font-mono whitespace-nowrap ${colour}`}>
      {text}
      {absent ? <span className="sr-only">no value reported</span> : null}
    </td>
  );
}

function SortHeader(props: {
  readonly label: string;
  readonly active: boolean;
  readonly direction: RankDirection;
  readonly onSort: () => void;
}) {
  return (
    <th
      scope="col"
      aria-sort={props.active ? (props.direction === "desc" ? "descending" : "ascending") : "none"}
      className="border-b-0 py-1 pr-3 pl-0 text-right text-small font-medium tracking-normal text-text-dim normal-case"
    >
      <button
        type="button"
        onClick={props.onSort}
        className="rounded-sm px-1 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {props.label}
        <span aria-hidden="true" className="ml-1">
          {props.active ? (props.direction === "desc" ? "▼" : "▲") : "↕"}
        </span>
      </button>
    </th>
  );
}
