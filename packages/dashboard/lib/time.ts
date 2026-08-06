/**
 * The dashboard's one time strategy: absolute instants are printed in UTC, and
 * every one of them says "UTC" on screen.
 *
 * Why UTC rather than the viewer's zone. These pages render on the server and
 * then hydrate. The server cannot know the browser's zone — there is no header
 * for it — so any formatter that reads `Intl.DateTimeFormat().resolvedOptions()`
 * or the local `getHours()` produces one string during SSR and a different one
 * during hydration, which React 19 reports as a hydration mismatch and repairs
 * by throwing the server HTML away. UTC is the same string in both places, so
 * server and client agree by construction; there is nothing to suppress, no
 * effect to defer to, and the page still renders correctly with JavaScript off.
 * The trade is that a viewer in PDT does arithmetic in their head, which is why
 * the zone is never left implicit: a bare "21:40" that is secretly UTC is worse
 * than an honest one.
 *
 * What this replaces. Four pages had four strategies. `/approvals`,
 * `/schedules`, `/skills` and `/memory` asked `toLocaleString` for UTC (right,
 * but unlabelled); `/monitors` had its own `clock()`; the trace pages formatted
 * in host-local time; and `app/sessions/[id]` and `app/evals` read
 * `getMonth()/getDate()/getHours()`, which is a *second* UTC correction applied
 * to a value lib/db.ts has already corrected — it installs a UTC parser for
 * `timestamp without time zone`, so lib/queries.ts hands back correct instants.
 * That double shift is invisible in the container, whose TZ is UTC, and wrong
 * by the offset on any developer laptop. Everything below reads the instant
 * with the `getUTC*` accessors, so the host's zone cannot enter the output at
 * all — which is what the unit tests in test/time.test.mjs pin down by
 * formatting the same instant under two process timezones.
 *
 * Relative time ("3h ago") is zone-free, so it is safe in both places, but it
 * does depend on *when* it runs; `now` is a parameter so tests can pin it.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * How much of the instant to print. Every value here has a caller that needs
 * exactly it: spans in one step routinely start in the same second (`millisecond`),
 * turns are seconds apart (`second`), list views are minutes apart (`minute`),
 * and a skill scan is a date (`day`).
 */
export type Precision = "day" | "minute" | "second" | "millisecond";

const EM_DASH = "—";

function timeOfDay(d: Date, precision: Precision): string {
  const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (precision === "minute") return hhmm;
  const hhmmss = `${hhmm}:${pad(d.getUTCSeconds())}`;
  return precision === "second" ? hhmmss : `${hhmmss}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/**
 * An absolute instant with its date, e.g. "Aug 5 21:40 UTC".
 *
 * The year is omitted by default because most of these surfaces are rolling
 * operational views of the last hours or days, where it is four characters of
 * noise on every row. `day` precision keeps it — a date with no time has no
 * other anchor — and so does any caller passing `{ year: true }`.
 *
 * Pass it on a permanent record. `/approvals` is an audit log and `/schedules`
 * keeps run history: both are ordered by time but not bounded by it, so a
 * decision from last August and one from this August render as the same string
 * and the reader cannot tell the rows apart. A rolling view never hits that; a
 * record hits it the first time a row is a year old, which is exactly when
 * nobody is looking.
 */
export function stamp(
  iso: string | null,
  precision: Precision = "minute",
  { year = false }: { year?: boolean } = {},
): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const date = year || precision === "day" ? `${day}, ${d.getUTCFullYear()}` : day;
  if (precision === "day") return `${date} UTC`;
  return `${date} ${timeOfDay(d, precision)} UTC`;
}

/**
 * Time of day only, with no zone marker — for a chart axis or a dense column
 * where one nearby "UTC" label covers every value. Anywhere the value stands
 * on its own, use `stamp`.
 *
 * `day` is excluded from the signature rather than handled: a date-only axis
 * tick is a blank axis, so the compiler refuses the call instead of a runtime
 * fallback quietly printing something the caller did not ask for.
 */
export function clock(
  iso: string | null,
  precision: Exclude<Precision, "day"> = "minute",
): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return timeOfDay(d, precision);
}

/**
 * Elapsed time since an instant. Zone-free, but clock-dependent: a value
 * rendered on the server is a second or two stale by the time it hydrates, so
 * pair it with a `title` holding the exact instant where that matters.
 */
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return EM_DASH;
  const seconds = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return EM_DASH;
  // A future instant is clock skew between the database host and this one, not
  // a negative age.
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * A span of time, not a point in it — so no zone is involved.
 *
 * Three significant figures the whole way up: whole milliseconds below a
 * second, hundredths below ten seconds, tenths above. The middle step is the
 * one worth naming, because losing it is invisible in a tooltip and fatal in a
 * percentile panel — `/monitors` reads a p50 of 4946ms and a p75 of 9598ms, and
 * at one decimal those are "4.9s" and "9.6s", which is the resolution the page
 * exists to show thrown away in the formatter.
 */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${pad(seconds)}s`;
}
