/**
 * Errors by hour by day, cost by model by week: a grid where colour is
 * magnitude.
 *
 * It is an HTML `<table>` with coloured cells rather than an SVG, which
 * settles the accessibility question by construction — the row and column
 * headers are real headers, every cell carries its value as text, and a screen
 * reader announces "Tuesday, 14:00, 12 errors" without any of it having been
 * retrofitted. An SVG heatmap would need all of that added back as ARIA.
 *
 * The one thing colour must not be allowed to say is "zero" when the truth is
 * "no cell". `heatIntensity` returns `null` for an absence and those cells are
 * drawn with a hatch and an em dash, not with the coolest colour on the ramp.
 * `heatmap.ts` explains the second half of the same idea: intensity is
 * measured from zero rather than from the minimum, so a quiet hour looks
 * quiet rather than looking like the floor.
 *
 * A server component. Nothing here needs a browser.
 *
 * The `w-auto`, `pl-0`, `border-b-0` and `normal-case` classes below undo
 * `app/globals.css`, which styles bare `table`, `th` and `td` inside
 * `@layer app` for the pages' record tables — including `width: 100%`, which
 * stretched this grid's square cells into rectangles until it was stated
 * otherwise. Utilities beat that layer only for the properties they set.
 */

import { ABSENT, formatValue, type Unit } from "./lib/format";
import {
  absentCellNote,
  buildHeatmap,
  heatIntensity,
  heatLegend,
  type HeatCell,
} from "./lib/heatmap";

export interface HeatmapProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly cells: readonly HeatCell[];
  readonly unit: Unit;
  /** Fixes row order, and includes rows the data never mentioned. */
  readonly rowKeys?: readonly string[];
  /** Fixes column order, and includes columns the data never mentioned. */
  readonly colKeys?: readonly string[];
  readonly rowLabel?: string;
  readonly colLabel?: string;
  /** Palette slot the ramp is built from. */
  readonly slot?: number;
}

/**
 * The ramp. `color-mix` keeps it a single CSS expression that follows the
 * light-mode media query, and the floor of 10% means a present-but-tiny value
 * is still visibly a value rather than indistinguishable from the surface.
 */
function rampColor(intensity: number, slot: number): string {
  const pct = Math.round((0.1 + 0.9 * intensity) * 100);
  return `color-mix(in oklab, var(--chart-${slot + 1}) ${pct}%, var(--bg))`;
}

const EMPTY_CELL =
  "repeating-linear-gradient(45deg, transparent, transparent 3px, var(--border) 3px, var(--border) 4px)";

export function Heatmap(props: HeatmapProps) {
  const slot = props.slot ?? 0;
  const grid = buildHeatmap(props.cells, {
    rowKeys: props.rowKeys,
    colKeys: props.colKeys,
  });
  const absent = absentCellNote(grid);
  const legend = heatLegend(grid);
  const rowLabel = props.rowLabel ?? "row";
  const colLabel = props.colLabel ?? "column";

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-bg-raised p-4">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-section font-medium text-text">{props.title}</h3>
        {props.subtitle === undefined ? null : (
          <p className="m-0 text-small text-text-dim">{props.subtitle}</p>
        )}
        {absent === null ? null : <p className="m-0 text-small text-warn">{absent}</p>}
      </div>

      {grid.rowKeys.length === 0 || grid.colKeys.length === 0 ? (
        <p className="flex min-h-24 items-center justify-center rounded-md border border-dashed border-border text-small text-text-dim">
          No data in this range.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-auto border-separate border-spacing-0.5 text-small">
            <caption className="sr-only">
              {props.title}: {rowLabel} by {colLabel}. Cells with no value are drawn empty and read
              as no value reported.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="sr-only">
                  {rowLabel}
                </th>
                {grid.colKeys.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    className="border-b-0 px-1 pt-0 pb-1 text-center text-micro font-normal tracking-normal text-text-faint normal-case"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rowKeys.map((r, ri) => (
                <tr key={r}>
                  <th
                    scope="row"
                    className="border-b-0 py-0 pr-2 pl-0 text-right text-micro font-normal tracking-normal whitespace-nowrap text-text-dim normal-case"
                  >
                    {r}
                  </th>
                  {grid.colKeys.map((c, ci) => {
                    const value = grid.grid[ri]?.[ci] ?? null;
                    const intensity = heatIntensity(value, grid);
                    const text = formatValue(value, props.unit);
                    return (
                      <td
                        key={c}
                        title={`${r}, ${c}: ${value === null ? "no value reported" : text}`}
                        className="h-5 w-5 rounded-sm border border-border p-0 align-middle"
                        style={
                          intensity === null
                            ? { background: EMPTY_CELL }
                            : { background: rampColor(intensity, slot) }
                        }
                      >
                        <span className="sr-only">
                          {value === null ? `${ABSENT} no value reported` : text}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {legend.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0 text-micro text-text-dim">
          <li>less</li>
          {legend.map((step) => (
            <li
              key={step.from}
              className="flex items-center gap-1"
              title={`${formatValue(step.from, props.unit)} to ${formatValue(step.to, props.unit)}`}
            >
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-sm border border-border"
                style={{ background: rampColor(step.intensity, slot) }}
              />
              <span className="sr-only">
                {formatValue(step.from, props.unit)} to {formatValue(step.to, props.unit)}
              </span>
            </li>
          ))}
          <li>more</li>
          <li className="ml-2 flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-sm border border-border"
              style={{ background: EMPTY_CELL }}
            />
            no value
          </li>
        </ul>
      )}
    </section>
  );
}
