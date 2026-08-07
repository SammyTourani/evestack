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
 * `#`, `?`, and timezones other than the host's — including the `CRON_TZ=` and
 * `TZ=` prefixes other implementations accept, which are refused by name rather
 * than counted as a sixth field. `parseCron` throws on anything it does not
 * understand rather than guessing, because a schedule that silently means
 * something other than what it says is worse than one that refuses to start.
 *
 * DAYLIGHT SAVING: the fields are wall-clock fields, so on the day a zone jumps
 * forward some of them name a reading that has no instant — 02:00 does not
 * happen in New York on the second Sunday in March. A schedule asking for an
 * erased reading fires once, on the instant the clock landed on, which is what
 * Vixie cron does with a forward jump. Falling back repeats an hour rather than
 * erasing one, and a wall-clock schedule inside it fires once, not twice.
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

/**
 * Refuse Quartz's extensions — per token, and only after names have had their
 * chance at it.
 *
 * This used to be one `/[LW#?]/` test over the whole expression, run before any
 * field was parsed. That is a trap the moment names are accepted
 * case-insensitively, because two of them carry the letters: `WED` has a W and
 * `JUL` has an L. So every uppercase spelling of a Wednesday or a July was
 * refused for syntax it does not use — and since `tracked()` parses at wrap time
 * to fail fast, `0 9 * * WED` took the whole agent down at import, with a
 * diagnosis about a seconds field the author never wrote.
 *
 * Splitting on `-` and `/` first is what makes the name check possible: the
 * letters only ever mean Quartz in a token that is not a name.
 */
function rejectUnsupported(token: string, names?: { list: readonly string[]; offset: number }): void {
  for (const atom of token.split(/[-/]/)) {
    const word = atom.trim();
    if (word === "" || (names && names.list.includes(word.toLowerCase()))) continue;
    // Case-insensitive: `0 0 l * *` is the same mistake as `0 0 L * *` and
    // deserves the same answer rather than "not a number or known name".
    if (/[lw#?]/i.test(word)) {
      throw new CronParseError(`"${token}" uses L, W, # or ? — not supported`);
    }
  }
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
    rejectUnsupported(token, names);

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

  // `CRON_TZ=Europe/Paris 0 9 * * *` and a leading `TZ=` are how other
  // implementations carry a timezone. We evaluate in the host's zone and only
  // the host's, so this has to be refused — but it was being refused as a sixth
  // SECONDS field, which told the author to delete something they never wrote.
  // Name the actual problem, and check before counting fields, because the
  // prefix is what makes the count six.
  if (/^(CRON_TZ|TZ)\s*=/i.test(normalized)) {
    throw new CronParseError(
      `"${trimmed}" carries a timezone. Only the host's timezone is supported — set TZ for the ` +
        `whole process instead, and write the five fields alone.`,
    );
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

/**
 * Does a wall-clock reading match?
 *
 * Takes the five numbers rather than a Date because some of the readings we have
 * to test are ones no Date can hold: on the morning a zone springs forward the
 * readings inside the erased hour have no instant at all. Passing numbers keeps
 * one matcher for both cases instead of two that can drift.
 */
function matchesParts(
  fields: CronFields,
  minute: number,
  hour: number,
  dayOfMonth: number,
  month: number,
  dayOfWeek: number,
): boolean {
  if (!fields.minutes.has(minute)) return false;
  if (!fields.hours.has(hour)) return false;
  if (!fields.months.has(month)) return false;

  const domMatch = fields.daysOfMonth.has(dayOfMonth);
  const dowMatch = fields.daysOfWeek.has(dayOfWeek);

  // The OR rule. When only one day field is restricted the other is `*` and
  // matches everything, so plain AND gives the right answer there anyway.
  return fields.bothDaysRestricted ? domMatch || dowMatch : domMatch && dowMatch;
}

function matches(fields: CronFields, date: Date): boolean {
  return matchesParts(
    fields,
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  );
}

/**
 * An instant's local reading, carried as UTC epoch ms.
 *
 * A label, not a time: arithmetic on it moves the wall clock a minute at a time
 * with no zone underneath to interfere, which is the only way to enumerate
 * readings that were erased. Subtracting two of them gives the distance the
 * wall clock travelled, which is how a jump is detected at all.
 */
function wallClock(at: Date): number {
  return Date.UTC(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes());
}

/**
 * Advance the cursor one wall-clock minute, and say whether that single step
 * jumped over a reading this schedule asked for.
 *
 * Both walkers below stepped with `setMinutes(+1)` and tested only readings that
 * exist, so a fire inside a spring-forward gap was invisible twice over: never
 * returned as the next fire, and never reported as missed, which meant catch-up
 * could not replay it either. Verified before the fix, under
 * TZ=America/New_York: `nextFire("0 2 * * *", 2027-03-13 12:00)` answered Mar 15,
 * skipping Mar 14 in silence.
 *
 * Vixie cron runs a job whose slot a forward jump ate, once, at the moment the
 * clock lands — so that is where the fire goes.
 */
function stepMinute(fields: CronFields, cursor: Date): boolean {
  const from = cursor.getTime();
  const offsetBefore = cursor.getTimezoneOffset();
  cursor.setMinutes(cursor.getMinutes() + 1);

  // The fast path, which is every minute of every ordinary day: the zone did not
  // move, so the wall clock advanced by exactly the minute we asked for. Only a
  // move east can erase a reading, and it costs two offset reads to rule out.
  if (cursor.getTimezoneOffset() >= offsetBefore) return false;

  const lastReal = wallClock(new Date(from));
  const erased = (wallClock(cursor) - lastReal) / 60_000 - 1;
  // If the reading we landed on matches on its own, the caller's own test will
  // see it a moment from now; answering yes here as well would report one fire
  // twice. This is what keeps `* * * * *` at one fire per existing minute.
  if (erased <= 0 || matches(fields, cursor)) return false;

  const label = new Date(lastReal);
  for (let i = 0; i < erased; i += 1) {
    label.setUTCMinutes(label.getUTCMinutes() + 1);
    if (
      matchesParts(
        fields,
        label.getUTCMinutes(),
        label.getUTCHours(),
        label.getUTCDate(),
        label.getUTCMonth() + 1,
        label.getUTCDay(),
      )
    ) {
      // One fire, however many erased readings matched: an hour of `*/15` that
      // never happened is still one hour the schedule owes, not four.
      return true;
    }
  }
  return false;
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
    // Stepping can be a fire in itself, when the step is over a spring-forward
    // gap that swallowed the reading this schedule wanted.
    if (stepMinute(fields, cursor)) return new Date(cursor.getTime());
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
    // A fire the clock jumped over is still a fire that was missed — reporting
    // it here is what lets catch-up replay it instead of losing the morning.
    if (stepMinute(fields, cursor) && cursor.getTime() <= until.getTime()) {
      if (fires.length >= cap) return { fires, truncated: true };
      fires.push(new Date(cursor.getTime()));
    }
  }
  return { fires, truncated: false };
}

/**
 * Whether the two day fields, taken together, leave every date matching.
 *
 * Not the same as "both are `*`", because of the OR rule: when both are
 * restricted, one of them matching everything makes the pair match everything.
 * `0 0 1 * 0-6` fires daily, not on the 1st.
 */
function everyDate(fields: CronFields): boolean {
  const anyDayOfWeek = fields.daysOfWeek.size === 7;
  const anyDayOfMonth = fields.daysOfMonth.size === 31;
  return fields.bothDaysRestricted ? anyDayOfWeek || anyDayOfMonth : anyDayOfWeek && anyDayOfMonth;
}

/**
 * Whether the date fields restrict when this runs at all.
 *
 * Load-bearing, because every summary below states a RATE, and a rate that reads
 * higher than the truth is the one kind of wrong this function must never be. A
 * schedule of `* * 1 * *` was described as "every minute" when it runs every
 * minute *on the first of the month* — 1440 fires a month reported as 44,640 —
 * and `0 * * * 1` was "hourly at :00" when it only fires on Mondays. Both read
 * as far more often than the truth, on the page a user checks to find out how
 * often something runs.
 */
function everyDay(fields: CronFields): boolean {
  return everyDate(fields) && fields.months.size === 12;
}

/** "on mon, tue", "on day 1", "on fri or day 13", "in month 1" — whichever fields are narrowed. */
function dayQualifier(fields: CronFields): string {
  const parts: string[] = [];
  if (!everyDate(fields)) {
    const days: string[] = [];
    if (fields.daysOfWeek.size < 7) {
      days.push([...fields.daysOfWeek].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(", "));
    }
    if (fields.daysOfMonth.size < 31) {
      days.push(`day ${[...fields.daysOfMonth].sort((a, b) => a - b).join(", ")}`);
    }
    // "or", and both halves named: with both day fields restricted cron fires on
    // EITHER, so `0 9 13 * 5` is every Friday as well as every 13th. The label
    // used to print one of the two and drop the other, which is a different
    // schedule — and a rarer-sounding one than the truth.
    parts.push(`on ${days.join(fields.bothDaysRestricted ? " or " : " ")}`);
  }
  if (fields.months.size < 12) {
    parts.push(`in month ${[...fields.months].sort((a, b) => a - b).join(", ")}`);
  }
  return parts.join(" ");
}

/** Human-readable summary for the dashboard, falling back to the raw expression. */
export function describeCron(expression: string): string {
  try {
    const fields = parseCron(expression);
    // Every branch below states a rate, so every branch has to ask the same
    // question first: do the date fields narrow it? Two of them used to, and the
    // other two — the daily time and the `*/N` rate — did not, which is how
    // `*/15 * * * 1` read as seven times more often than it fires.
    if (fields.minutes.size === 60 && fields.hours.size === 24) {
      return everyDay(fields) ? "every minute" : `every minute ${dayQualifier(fields)}`;
    }
    if (fields.minutes.size === 1 && fields.hours.size === 24) {
      const hourly = `hourly at :${String([...fields.minutes][0]).padStart(2, "0")}`;
      return everyDay(fields) ? hourly : `${hourly} ${dayQualifier(fields)}`;
    }
    if (fields.minutes.size === 1 && fields.hours.size === 1) {
      const time = `${String([...fields.hours][0]).padStart(2, "0")}:${String([...fields.minutes][0]).padStart(2, "0")}`;
      // "daily" was decided by the two day fields alone, so `0 9 * 1 *` — 31
      // fires a year — was "daily at 09:00", which is 365. And when both day
      // fields were narrowed only one of them was printed. One qualifier that
      // reads all three fields answers both.
      return everyDay(fields) ? `daily at ${time}` : `${time} ${dayQualifier(fields)}`;
    }
    if (fields.hours.size === 24 && fields.minutes.size > 1) {
      const sorted = [...fields.minutes].sort((a, b) => a - b);
      const gap = sorted[1]! - sorted[0]!;
      const even = sorted.every((m, i) => i === 0 || m - sorted[i - 1]! === gap);
      // Even spacing inside the hour is not a rate. The spacing has to carry on
      // across the top of the hour, and for n evenly spaced values with gap g
      // that is exactly n * g === 60 — so `0-10/5` (three fires an hour, once
      // described as twelve) and `0,1` (two, once described as sixty, and
      // "every 1 minutes" at that) fall through to the raw expression instead.
      // `5/10` still qualifies: 5,15,25,35,45,55 really is every ten minutes.
      if (even && gap > 0 && sorted.length * gap === 60) {
        // And the day fields still apply. `*/15 * * * 1` is Mondays: 96 fires a
        // week, not 672.
        return everyDay(fields) ? `every ${gap} minutes` : `every ${gap} minutes ${dayQualifier(fields)}`;
      }
    }
    return expression;
  } catch {
    return expression;
  }
}
