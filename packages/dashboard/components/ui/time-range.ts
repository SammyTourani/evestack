/**
 * The window every chart and table on a page shares.
 *
 * All logic, no React: "which two instants does *Last 24 hours* mean right now"
 * is a function, and `time-range-picker.tsx` only renders what it decides.
 *
 * The two representations are not interchangeable and both are needed. A preset
 * is *relative* — "last 24 hours" means something different tomorrow, which is
 * what you want on an overview that stays open. An absolute pair is what
 * drag-to-zoom produces and what belongs in a link pasted into an incident
 * channel, where "last 24 hours" would point at the wrong day by morning.
 *
 * The emitted strings are what `compileMetricQuery` accepts: ISO with a UTC
 * offset. It rejects anything without one, on the grounds that a bare local
 * timestamp resolves in whatever zone the server happens to run in — the same
 * class of bug W1 spent a workstream removing.
 *
 * There is deliberately no query-string codec here. Persisting the window in
 * the URL is right — `/monitors` already does it with `?hours=` — but which
 * parameters a page uses is that page's routing decision, and a codec written
 * before any page has one is a guess with tests around it. Two rules are worth
 * carrying into whichever page adds it: reject `from >= to`, because an
 * inverted window renders as a quiet period rather than as a broken link, and
 * reject a timestamp with no UTC offset, because `2026-08-01T00:00` means a
 * different instant per server.
 */
import { stamp } from "../../lib/time";

export interface Preset {
  readonly id: string;
  readonly label: string;
  readonly ms: number;
}

const HOUR = 3_600_000;

/**
 * The five windows `lib/monitors.ts` already offers, plus 30 days.
 *
 * The first five are not a coincidence and should not drift: the monitors page
 * has shipped a 1h/6h/12h/24h/7d selector since `cfbff14`, and a picker that
 * offered a different set would make the same question look like two questions
 * on two pages. 30d is added because a month is the range over which spend and
 * failure trends are legible, and it is the span the seeded database covers.
 */
export const PRESETS: readonly Preset[] = [
  { id: "1h", label: "Last hour", ms: HOUR },
  { id: "6h", label: "Last 6 hours", ms: 6 * HOUR },
  { id: "12h", label: "Last 12 hours", ms: 12 * HOUR },
  { id: "24h", label: "Last 24 hours", ms: 24 * HOUR },
  { id: "7d", label: "Last 7 days", ms: 7 * 24 * HOUR },
  { id: "30d", label: "Last 30 days", ms: 30 * 24 * HOUR },
];

export type TimeRange =
  | { readonly kind: "preset"; readonly id: string }
  | { readonly kind: "absolute"; readonly fromMs: number; readonly toMs: number };

/** The same 24 hours `lib/metrics.ts` defaults to when a query omits the window. */
const DEFAULT_PRESET = PRESETS.find((p) => p.id === "24h")!;
export const DEFAULT_RANGE: TimeRange = { kind: "preset", id: DEFAULT_PRESET.id };

export interface ResolvedRange {
  readonly fromMs: number;
  /** Exclusive, matching the `[from, to)` the query API documents. */
  readonly toMs: number;
  /** ISO with offset, ready for `timeDimension.from`. */
  readonly from: string;
  readonly to: string;
  /** What the trigger button reads. */
  readonly label: string;
}

/**
 * A range to two instants. `now` is a parameter so a server render and the test
 * suite can both pin it; a preset resolved twice a second apart otherwise
 * produces two different windows and two different cache keys.
 *
 * An unknown preset id falls back to the default rather than throwing. Ids come
 * out of URLs, and a stale bookmark to `?range=90d` should show the last day,
 * not an error page.
 */
export function resolveRange(range: TimeRange, now: number = Date.now()): ResolvedRange {
  if (range.kind === "absolute") {
    return {
      fromMs: range.fromMs,
      toMs: range.toMs,
      from: new Date(range.fromMs).toISOString(),
      to: new Date(range.toMs).toISOString(),
      label: `${stamp(new Date(range.fromMs).toISOString())} → ${stamp(new Date(range.toMs).toISOString())}`,
    };
  }
  const preset = PRESETS.find((p) => p.id === range.id) ?? DEFAULT_PRESET;
  return {
    fromMs: now - preset.ms,
    toMs: now,
    from: new Date(now - preset.ms).toISOString(),
    to: new Date(now).toISOString(),
    label: preset.label,
  };
}
