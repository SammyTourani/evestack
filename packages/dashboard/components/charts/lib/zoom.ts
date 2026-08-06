/**
 * Drag a range across a chart, then press Zoom In. Vercel Observability's best
 * interaction, and the one that is nearly always shipped mouse-only.
 *
 * It is a reducer rather than a pile of `useState` because that is what makes
 * the keyboard path provable. Both input devices dispatch into the same state
 * machine, so "a keyboard user can do everything a mouse user can" stops being
 * a claim in a review and becomes an assertion: run the pointer sequence, run
 * the key sequence, compare the two states. A retrofitted keyboard path is a
 * second implementation that drifts; this one cannot, because there is only
 * one.
 *
 * The mapping, kept deliberately conventional:
 *
 *   pointer down + move + up      Arrow to a start, Shift+Arrow to extend
 *   release inside the plot       Enter, or the Zoom In button
 *   release outside / Esc         Escape
 *   the Zoom Out button           the Zoom Out button, reachable by Tab
 *
 * `xs` is the sorted list of x positions actually present in the data. The
 * keyboard steps between them rather than by a fixed amount, so one press is
 * always one bucket regardless of the bucket width, and a cursor can never
 * land somewhere the chart has no value for.
 */

/** A closed range of x positions. `from <= to` always. */
export interface Range {
  readonly from: number;
  readonly to: number;
}

export interface ZoomState {
  /** The visible window. `null` is the full extent of the data. */
  readonly view: Range | null;
  /** The range under the drag or the keyboard selection. */
  readonly selection: Range | null;
  /** Where the current drag or Shift+Arrow selection started. */
  readonly anchor: number | null;
  /** Index into `xs` for the keyboard caret. `null` before first use. */
  readonly cursor: number | null;
  /** Views popped by Zoom Out, innermost last. */
  readonly history: readonly Range[];
  /** True between pointer-down and pointer-up, so the mark can render live. */
  readonly dragging: boolean;
}

export const INITIAL_ZOOM: ZoomState = {
  view: null,
  selection: null,
  anchor: null,
  cursor: null,
  history: [],
  dragging: false,
};

export type ZoomAction =
  | { readonly type: "pointer-down"; readonly x: number }
  | { readonly type: "pointer-move"; readonly x: number }
  | { readonly type: "pointer-up"; readonly x: number }
  /** Escape, or a pointer released off the plot. */
  | { readonly type: "clear" }
  | { readonly type: "zoom-in" }
  | { readonly type: "zoom-out" }
  | {
      readonly type: "key";
      readonly key: "ArrowLeft" | "ArrowRight" | "Home" | "End";
      /** Shift extends the selection instead of moving the caret. */
      readonly extend: boolean;
    };

function order(a: number, b: number): Range {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** A one-position selection is a click, not a range; nothing to zoom into. */
export function canZoomIn(state: ZoomState): boolean {
  return state.selection !== null && state.selection.from < state.selection.to;
}

export function canZoomOut(state: ZoomState): boolean {
  return state.view !== null;
}

/** Index of the position at or nearest below `x`, clamped into range. */
function indexOf(xs: readonly number[], x: number): number {
  if (xs.length === 0) return 0;
  let best = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < xs.length; i++) {
    const gap = Math.abs((xs[i] as number) - x);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

/**
 * The reducer, closed over the x positions in the data. Rebuild it when the
 * data changes; it holds no state of its own.
 */
export function createZoomReducer(
  xs: readonly number[],
): (state: ZoomState, action: ZoomAction) => ZoomState {
  const last = xs.length - 1;

  return function zoomReducer(state, action) {
    switch (action.type) {
      case "pointer-down": {
        const i = indexOf(xs, action.x);
        const at = xs[i] ?? action.x;
        return { ...state, anchor: at, cursor: i, selection: { from: at, to: at }, dragging: true };
      }
      case "pointer-move": {
        if (!state.dragging || state.anchor === null) return state;
        const i = indexOf(xs, action.x);
        const at = xs[i] ?? action.x;
        return { ...state, cursor: i, selection: order(state.anchor, at) };
      }
      case "pointer-up": {
        if (!state.dragging || state.anchor === null) return state;
        const i = indexOf(xs, action.x);
        const at = xs[i] ?? action.x;
        const selection = order(state.anchor, at);
        // A click that never moved leaves nothing selected, so the Zoom In
        // affordance does not appear after an accidental tap.
        const settled = selection.from === selection.to ? null : selection;
        return {
          ...state,
          cursor: i,
          selection: settled,
          anchor: settled === null ? null : state.anchor,
          dragging: false,
        };
      }
      case "key": {
        if (xs.length === 0) return state;
        const from = state.cursor ?? 0;
        const next =
          action.key === "Home"
            ? 0
            : action.key === "End"
              ? last
              : action.key === "ArrowLeft"
                ? Math.max(0, from - 1)
                : Math.min(last, from + 1);
        const at = xs[next] as number;
        if (!action.extend) {
          // Moving the caret without Shift is the equivalent of moving the
          // pointer with no button held: it previews a position and drops any
          // range, exactly as starting a new drag would.
          return { ...state, cursor: next, anchor: at, selection: { from: at, to: at } };
        }
        const anchor = state.anchor ?? (xs[from] as number);
        return { ...state, cursor: next, anchor, selection: order(anchor, at) };
      }
      case "clear":
        return { ...state, selection: null, anchor: null, dragging: false };
      case "zoom-in": {
        if (!canZoomIn(state)) return state;
        const selection = state.selection as Range;
        return {
          ...state,
          view: selection,
          history: state.view === null ? state.history : [...state.history, state.view],
          selection: null,
          anchor: null,
          dragging: false,
        };
      }
      case "zoom-out": {
        if (state.view === null) return state;
        const history = [...state.history];
        const previous = history.pop() ?? null;
        return { ...state, view: previous, history, selection: null, anchor: null };
      }
    }
  };
}

/**
 * The rows inside the current view. Filtering rather than only narrowing the
 * axis domain is deliberate: it rescales the y-axis to what is on screen,
 * which is the whole reason for zooming into a latency spike.
 */
export function applyView<T extends { readonly x: number }>(
  rows: readonly T[],
  view: Range | null,
): T[] {
  if (view === null) return [...rows];
  return rows.filter((r) => r.x >= view.from && r.x <= view.to);
}

/** "3 of 30 buckets", for the live region that announces a zoom. */
export function describeView(
  view: Range | null,
  shown: number,
  total: number,
  formatX: (x: number) => string,
): string {
  if (view === null) return `showing all ${total} buckets`;
  return `zoomed to ${formatX(view.from)} through ${formatX(view.to)}, ${shown} of ${total} buckets`;
}
