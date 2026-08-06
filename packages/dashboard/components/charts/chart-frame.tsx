/**
 * Everything around the plot: the title, the caveats, the legend, the two
 * kinds of empty, and the table of numbers.
 *
 * It exists as one component because those parts are where a chart lies. The
 * plot itself is honest almost by construction — Recharts will not draw a
 * point it has no value for — and every failure this wave has to avoid lives
 * out here: the coverage note that ended up in a tooltip, the seventh series
 * that vanished, the empty window that looked like a flat line at zero, the
 * `<svg>` with no text in it.
 *
 * So the primitives do not each assemble their own chrome. They compute a
 * `PreparedChart` and hand it here, and this file decides what has to be said.
 * A primitive cannot forget to mention partial coverage, because it never had
 * the choice.
 *
 * Recharts renders nothing at all without a DOM — `renderToStaticMarkup` of a
 * `<LineChart>` is an empty `<div>` — so the chrome is deliberately plain
 * React. It is what a server-rendered page, a text browser, and a test
 * without a DOM all see.
 */

import { useId, type ReactNode } from "react";

import type { DataTable } from "./lib/a11y";
import type { SlotStyle } from "./lib/palette";
import type { ChartState } from "./lib/series";
import { useHatch } from "./hatch";
import { Symbols } from "recharts";

/** A caveat is something the reader must weigh; a note is context. */
export type NoteTone = "caveat" | "info";

export interface FrameNote {
  readonly text: string;
  readonly tone: NoteTone;
}

/** Drop the `null`s a note builder returns when it has nothing to say. */
export function notes(...entries: readonly (readonly [string | null, NoteTone])[]): FrameNote[] {
  const out: FrameNote[] = [];
  for (const [text, tone] of entries) if (text !== null) out.push({ text, tone });
  return out;
}

export interface LegendItem {
  readonly id: string;
  readonly label: string;
  readonly style: SlotStyle;
  /** How the series is drawn, so the swatch matches the mark. */
  readonly mark: "line" | "fill";
}

/**
 * The swatch. It draws the dash pattern and the marker shape for a line, and
 * the hatch texture for a fill, so the legend is usable by someone who cannot
 * separate two of the six hues.
 */
function Swatch({ item, slot }: { item: LegendItem; slot: number }) {
  const hatch = useHatch();
  if (item.mark === "fill") {
    return (
      <svg width="22" height="12" aria-hidden="true" className="shrink-0">
        {hatch.defs}
        <rect
          x="0"
          y="1"
          width="22"
          height="10"
          fill={hatch.fill(slot)}
          stroke={item.style.color}
        />
      </svg>
    );
  }
  return (
    <svg width="22" height="12" aria-hidden="true" className="shrink-0">
      <line
        x1="0"
        y1="6"
        x2="22"
        y2="6"
        stroke={item.style.color}
        strokeWidth="2"
        strokeDasharray={item.style.dash ?? undefined}
      />
      <Symbols
        cx={11}
        cy={6}
        type={item.style.shape}
        size={28}
        fill={item.style.color}
        stroke="var(--bg-raised)"
      />
    </svg>
  );
}

export interface ChartFrameProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly notes?: readonly FrameNote[];
  readonly legend?: readonly LegendItem[];
  /** The sentence assistive technology gets before the numbers. */
  readonly summary: string;
  readonly table: DataTable;
  readonly state: ChartState;
  /** Buckets in range, used only to word the all-absent empty state. */
  readonly bucketCount?: number;
  /** Zoom controls, filters — anything that acts on the chart. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

/**
 * The two empties say different things because they are different facts. No
 * rows means nothing happened in the window. Rows with no values means things
 * happened and were not measured — the shape that a chart of zeros would
 * report as a healthy, quiet week.
 */
function Empty({ state, buckets }: { state: ChartState; buckets: number }) {
  const message =
    state === "no-rows"
      ? "No data in this range."
      : `${buckets.toLocaleString("en-US")} ${buckets === 1 ? "bucket" : "buckets"} in range, and not one reported a value. This is missing data, not zero.`;
  return (
    <p className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border px-4 text-center text-small text-text-dim">
      {message}
    </p>
  );
}

/**
 * A caveat is warm-coloured; a note is quiet. Kept out of the JSX attribute
 * so that the `className` values in this directory are class names and
 * nothing else — `test/charts-render.test.mjs` compiles every one of them
 * against the real stylesheet, and it cannot tell a comparison operand from a
 * utility it has never heard of.
 */
function noteClass(tone: NoteTone): string {
  return tone === "caveat" ? "text-small text-warn" : "text-small text-text-dim";
}

export function ChartFrame(props: ChartFrameProps) {
  const id = useId();
  const summaryId = `${id}-summary`;
  const frameNotes = props.notes ?? [];

  return (
    <figure
      className="m-0 flex flex-col gap-3 rounded-md border border-border bg-bg-raised p-4"
      aria-describedby={summaryId}
    >
      <figcaption className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-section font-medium text-text">{props.title}</span>
          {props.subtitle === undefined ? null : (
            <span className="text-small text-text-dim">{props.subtitle}</span>
          )}
          {frameNotes.map((note) => (
            <span key={note.text} className={noteClass(note.tone)}>
              {note.text}
            </span>
          ))}
        </div>
        {props.actions === undefined ? null : (
          <div className="flex items-center gap-2">{props.actions}</div>
        )}
      </figcaption>

      {/* Read before the plot, so a caveat is heard before a number. */}
      <p id={summaryId} className="sr-only">
        {props.summary}
      </p>

      {props.state === "ok" ? (
        props.children
      ) : (
        <Empty state={props.state} buckets={props.bucketCount ?? 0} />
      )}

      {props.legend === undefined || props.legend.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-small text-text-dim">
          {props.legend.map((item, slot) => (
            <li key={item.id} className="flex items-center gap-2">
              <Swatch item={item} slot={slot} />
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      )}

      <DataTableDisclosure table={props.table} />
    </figure>
  );
}

/**
 * `<details>` rather than a visually hidden table: assistive technology
 * reaches it either way, and a sighted reader gets numbers they can select and
 * paste instead of a picture they have to squint at. It costs no JavaScript.
 */
export function DataTableDisclosure({ table }: { table: DataTable }) {
  return (
    <details className="text-small text-text-dim">
      <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {table.rows.length === 0
          ? "Data table (empty)"
          : `Data table (${table.rows.length.toLocaleString("en-US")} ${table.rows.length === 1 ? "row" : "rows"})`}
      </summary>
      {/*
        The `pl-0`, `border-b-0`, `normal-case`, `tracking-normal` and explicit
        text size on every cell are not decoration. `app/globals.css` styles
        bare `th` and `td` inside `@layer app` — uppercase, letter-spaced, 11px,
        14px of side padding, a bottom border — for the dense record tables the
        pages already draw. Utilities outrank that layer, but only for the
        properties they set, so anything left unstated leaks in. Deleting one of
        these classes does not tidy the markup, it reinstates a rule written for
        a different table.
      */}
      <div className="mt-2 max-h-80 overflow-auto">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{table.caption}</caption>
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="sticky top-0 border-b-0 bg-bg-raised py-1 pr-3 pl-0 text-small font-medium tracking-normal text-text-dim normal-case"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, i) => (
                  <td
                    key={`${table.columns[i] ?? i}`}
                    className={
                      i === 0
                        ? "border-b-0 py-1 pr-3 pl-0 align-baseline whitespace-nowrap text-text-dim"
                        : "border-b-0 py-1 pr-3 pl-0 align-baseline font-mono whitespace-nowrap text-text"
                    }
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
