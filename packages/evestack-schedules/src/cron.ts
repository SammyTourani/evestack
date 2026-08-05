/**
 * A five-field cron evaluator, in about a hundred lines and no dependencies.
 *
 * We need two things eve's runtime does not expose: when a schedule will fire
 * NEXT (so the dashboard can say something more useful than the raw
 * expression), and which fires were MISSED while the process was down (so a
 * restart can catch up instead of silently skipping a morning). Both need the
 * schedule interpreted rather than merely stored.
 *
 * Pulling in a cron library for this would mean a dependency in the one package
 * a self-hoster runs closest to their agent, to parse a grammar that fits on a
 * page. The grammar is frozen — it has not changed since Vixie cron — so the
 * usual argument for depending on someone else's parser (it will keep up with
 * the spec) does not apply.
 *
 * SUPPORTED: `*`, `N`, `A-B`, `A-B/S`, `*\/S`, and comma lists of those, over
 * the standard five fields (minute hour day-of-month month day-of-week), plus
 * the common aliases (@hourly, @daily, @weekly, @monthly, @yearly). Day names
 * and month names are accepted case-insensitively. Sunday is 0 or 7.
 *
 * NOT SUPPORTED, deliberately and loudly: seconds (a sixth field), `L`, `W`,
 * `#`, `?`, and timezones other than the host's. `parseCron` throws on anything
 * it does not understand rather than guessing, because a schedule that silently
 * means something other than what it says is worse than one that refuses to
 * start.
 *
 * DAY-OF-MONTH AND DAY-OF-WEEK ARE OR-ED, not AND-ed, when both are restricted.
 * That is Vixie cron's genuinely surprising rule — `0 0 13 * 5` fires on the
 * 13th AND on every Friday — and matching it matters more than being tidy,
 * because the same expression is also being handed to eve's own runner.
 */

export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** True when both day fields are restricted, which triggers the OR rule. */
  readonly bothDaysRestricted: boolean;
}

export class CronParseError extends Error {}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function named(token: string, names: readonly string[], offset: number): string {
  const index = names.indexOf(token.toLowerCase());
  return index === -1 ? token : String(index + offset);
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: { list: readonly string[]; offset: number },
): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;

  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") throw new CronParseError(`empty element in "${raw}"`);

    const [rangePart, stepPart] = token.split("/");
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      throw new CronParseError(`step must be a positive integer in "${token}"`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (step === 0) throw new CronParseError(`step of 0 in "${token}"`);

    let lo: number;
    let hi: number;
    const range = (rangePart ?? "").trim();

    if (range === "*") {
      lo = min;
      hi = max;
      if (step !== 1) restricted = true;
    } else {
      restricted = true;
      const bounds = range.split("-");
      if (bounds.length > 2) throw new CronParseError(`malformed range "${range}"`);
      const first = names ? named(bounds[0]!, names.list, names.offset) : bounds[0]!;
      const second =
        bounds[1] === undefined ? undefined : names ? named(bounds[1], names.list, names.offset) : bounds[1];

      if (!/^\d+$/.test(first)) throw new CronParseError(`"${bounds[0]}" is not a number or known name`);
      lo = Number(first);
      if (second === undefined) {
        // A bare number with a step means "from here to the end", matching
        // Vixie cron: `5/10` in minutes is 5,15,25,35,45,55.
        hi = stepPart === undefined ? lo : max;
      } else {
        if (!/^\d+$/.test(second)) throw new CronParseError(`"${bounds[1]}" is not a number or known name`);
        hi = Number(second);
      }
    }

    if (lo < min || hi > max || lo > hi) {
      throw new CronParseError(`"${token}" is outside ${min}-${max}`);
    }
    for (let value = lo; value <= hi; value += step) values.add(value);
  }

  return { values, restricted };
}

export function parseCron(expression: string): CronFields {
  const trimmed = expression.trim();
  const normalized = ALIASES[trimmed.toLowerCase()] ?? trimmed;

  if (normalized.startsWith("@")) {
    throw new CronParseError(`unknown cron alias "${trimmed}"`);
  }

  const fields = normalized.split(/\s+/);
  if (fields.length === 6) {
    throw new CronParseError(
      `"${trimmed}" has 6 fields. Seconds are not supported — use 5 fields (minute hour day month weekday).`,
    );
  }
  if (fields.length !== 5) {
    throw new CronParseError(`"${trimmed}" has ${fields.length} fields, expected 5`);
  }
  if (/[LW#?]/.test(normalized)) {
    throw new CronParseError(`"${trimmed}" uses L, W, # or ? — not supported`);
  }

  const minutes = parseField(fields[0]!, 0, 59);
  const hours = parseField(fields[1]!, 0, 23);
  const daysOfMonth = parseField(fields[2]!, 1, 31);
  const months = parseField(fields[3]!, 1, 12, { list: MONTH_NAMES, offset: 1 });
  const weekRaw = parseField(fields[4]!, 0, 7, { list: DAY_NAMES, offset: 0 });

  // Cron accepts both 0 and 7 for Sunday; normalize so matching is a single
  // lookup rather than a special case at every call site.
  const daysOfWeek = new Set([...weekRaw.values].map((day) => (day === 7 ? 0 : day)));

  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek,
    bothDaysRestricted: daysOfMonth.restricted && weekRaw.restricted,
  };
}

function matches(fields: CronFields, date: Date): boolean {
  if (!fields.minutes.has(date.getMinutes())) return false;
  if (!fields.hours.has(date.getHours())) return false;
  if (!fields.months.has(date.getMonth() + 1)) return false;

  const domMatch = fields.daysOfMonth.has(date.getDate());
  const dowMatch = fields.daysOfWeek.has(date.getDay());

  // The OR rule. When only one day field is restricted the other is `*` and
  // matches everything, so plain AND gives the right answer there anyway.
  return fields.bothDaysRestricted ? domMatch || dowMatch : domMatch && dowMatch;
}

/**
 * The next firing strictly after `after`.
 *
 * Minute-by-minute rather than clever: a year of minutes is ~525k iterations
 * worst case, and the loop exits on the first match, which for any realistic
 * schedule is within a day. The bound is what makes it safe — an expression
 * that can never fire (30 February) returns null instead of spinning.
 */
export function nextFire(expression: string, after: Date = new Date()): Date | null {
  const fields = parseCron(expression);
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = 366 * 24 * 60;
  for (let step = 0; step < limit; step += 1) {
    if (matches(fields, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/**
 * Every firing in `(after, until]` — the fires a restart missed.
 *
 * Capped, because the honest failure mode for "the box was off for three
 * weeks" is not to replay a thousand heartbeats at once. The caller decides
 * what to do with the overflow; this just refuses to hand back an unbounded
 * list.
 */
export function missedFires(
  expression: string,
  after: Date,
  until: Date = new Date(),
  cap = 100,
): { fires: Date[]; truncated: boolean } {
  const fields = parseCron(expression);
  const fires: Date[] = [];
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  while (cursor.getTime() <= until.getTime()) {
    if (matches(fields, cursor)) {
      if (fires.length >= cap) return { fires, truncated: true };
      fires.push(new Date(cursor.getTime()));
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return { fires, truncated: false };
}

/** Human-readable summary for the dashboard, falling back to the raw expression. */
export function describeCron(expression: string): string {
  try {
    const fields = parseCron(expression);
    if (fields.minutes.size === 60) return "every minute";
    if (fields.minutes.size === 1 && fields.hours.size === 24) {
      return `hourly at :${String([...fields.minutes][0]).padStart(2, "0")}`;
    }
    if (fields.minutes.size === 1 && fields.hours.size === 1) {
      const time = `${String([...fields.hours][0]).padStart(2, "0")}:${String([...fields.minutes][0]).padStart(2, "0")}`;
      if (fields.daysOfWeek.size === 7 && fields.daysOfMonth.size === 31) return `daily at ${time}`;
      if (fields.daysOfWeek.size < 7) {
        const days = [...fields.daysOfWeek].sort().map((d) => DAY_NAMES[d]).join(", ");
        return `${time} on ${days}`;
      }
      return `${time} on day ${[...fields.daysOfMonth].sort((a, b) => a - b).join(", ")}`;
    }
    if (fields.hours.size === 24 && fields.minutes.size > 1) {
      const sorted = [...fields.minutes].sort((a, b) => a - b);
      const gap = sorted.length > 1 ? sorted[1]! - sorted[0]! : 0;
      const even = sorted.every((m, i) => i === 0 || m - sorted[i - 1]! === gap);
      if (even && gap > 0) return `every ${gap} minutes`;
    }
    return expression;
  } catch {
    return expression;
  }
}
