/**
 * A grid of buckets, where the cell nobody reported is not the cell that
 * reported nothing.
 *
 * That distinction is the entire reason this module exists rather than a
 * nested array literal in the component. On a "errors by hour by day" heatmap
 * the coolest colour means zero errors, which is good news; a day the agent
 * was not running has no cell at all, which is no news. Painting the second as
 * the first turns an outage into a clean week. `null` survives all the way to
 * the renderer, which draws those cells hatched and empty.
 *
 * Intensity is measured from zero rather than from the minimum whenever the
 * data is non-negative. Scaling 3 to 100 as "0% of the range" would make a
 * quiet hour look identical to a dead one; scaling it as 3% of the maximum is
 * what a reader assumes a heatmap means.
 */

import type { Value } from "./format";

export interface HeatCell {
  readonly row: string;
  readonly col: string;
  readonly value: Value;
}

export interface HeatGrid {
  readonly rowKeys: string[];
  readonly colKeys: string[];
  /** `grid[rowIndex][colIndex]`; `null` is "no cell", not "zero". */
  readonly grid: Value[][];
  /** Lowest and highest present value; `null` when nothing is present. */
  readonly min: number | null;
  readonly max: number | null;
  /** Cells in the grid with no value, including ones no input mentioned. */
  readonly absent: number;
  /** Cells carrying a number. */
  readonly observed: number;
}

export interface HeatOptions {
  /** Row order. Derived from the data, sorted, when omitted. */
  readonly rowKeys?: readonly string[];
  /** Column order. Derived from the data, sorted, when omitted. */
  readonly colKeys?: readonly string[];
}

/**
 * Row and column keys are arbitrary strings, so they are joined on a unit
 * separator rather than on anything a label might itself contain. Joining on
 * a space would make `{"a b", "c"}` and `{"a", "b c"}` the same cell.
 */
const KEY_SEPARATOR = String.fromCharCode(31);

function key(row: string, col: string): string {
  return row + KEY_SEPARATOR + col;
}

export function buildHeatmap(
  cells: readonly HeatCell[],
  options: HeatOptions = {},
): HeatGrid {
  const rowKeys = options.rowKeys
    ? [...options.rowKeys]
    : [...new Set(cells.map((c) => c.row))].sort();
  const colKeys = options.colKeys
    ? [...options.colKeys]
    : [...new Set(cells.map((c) => c.col))].sort();

  const index = new Map<string, Value>();
  for (const c of cells) index.set(key(c.row, c.col), c.value);

  let min: number | null = null;
  let max: number | null = null;
  let absent = 0;
  let observed = 0;

  const grid: Value[][] = rowKeys.map((r) =>
    colKeys.map((c) => {
      const v = index.get(key(r, c));
      if (v === undefined || v === null || !Number.isFinite(v)) {
        absent++;
        return null;
      }
      observed++;
      if (min === null || v < min) min = v;
      if (max === null || v > max) max = v;
      return v;
    }),
  );

  return { rowKeys, colKeys, grid, min, max, absent, observed };
}

/**
 * Where a value sits on the 0–1 ramp, or `null` for an absent cell so the
 * renderer cannot accidentally paint one.
 */
export function heatIntensity(value: Value, grid: HeatGrid): number | null {
  if (value === null) return null;
  const max = grid.max;
  if (max === null) return null;
  const floor = grid.min !== null && grid.min < 0 ? grid.min : 0;
  if (max === floor) return 1;
  return Math.max(0, Math.min(1, (value - floor) / (max - floor)));
}

export interface HeatLegendStep {
  readonly from: number;
  readonly to: number;
  readonly intensity: number;
}

/**
 * The swatches under the grid. Without these the ramp is decorative: a reader
 * can see that one cell is darker without being able to say by how much.
 */
export function heatLegend(grid: HeatGrid, steps = 5): HeatLegendStep[] {
  const max = grid.max;
  if (max === null) return [];
  const floor = grid.min !== null && grid.min < 0 ? grid.min : 0;
  if (max === floor) return [{ from: floor, to: max, intensity: 1 }];
  const width = (max - floor) / steps;
  return Array.from({ length: steps }, (_, i) => ({
    from: floor + i * width,
    to: floor + (i + 1) * width,
    intensity: steps === 1 ? 1 : i / (steps - 1),
  }));
}

/** The visible sentence for cells with no value. `null` when the grid is full. */
export function absentCellNote(grid: HeatGrid): string | null {
  if (grid.absent === 0) return null;
  const total = grid.absent + grid.observed;
  return `${grid.absent} of ${total} cells have no value and are drawn empty, not as zero.`;
}
