import { parseCron, type CronFields } from "@evestack/schedules/cron";

/**
 * When a schedule fires next — as an instant, computed in the timezone the
 * AGENT reads its cron in, and never in the viewer's.
 *
 * ── THE BUG THIS REPLACES ────────────────────────────────────────────────────
 *
 * `app/schedules/schedules-client.tsx` is a `"use client"` component, and it
 * called `nextFire(schedule.cron)` inline during render, then printed the
 * result with `stamp()`, which formats in UTC. `nextFire`
 * (packages/evestack-schedules/src/cron.ts:318) walks the calendar with
 * `getHours()`/`getDate()`/`getDay()` — the HOST's zone, whichever host runs
 * it — so the same row produced a different number in every process that
 * rendered it. Measured against `packages/evestack-schedules/dist/cron.js` with
 * `after` pinned to 2026-08-09T06:00:00Z, cron `0 9 * * *`:
 *
 *     TZ=UTC              -> 2026-08-09T09:00:00Z  "Aug 9 09:00:00 UTC"
 *     TZ=America/New_York -> 2026-08-09T13:00:00Z  "Aug 9 13:00:00 UTC"
 *     TZ=Asia/Tokyo       -> 2026-08-10T00:00:00Z  "Aug 10 00:00:00 UTC"
 *
 * In a client component the two hosts are the container (during SSR) and the
 * reader's laptop (during hydration), which is the precise failure
 * `lib/time.ts` was written to keep off these pages: React 19 sees the two
 * strings disagree, throws the server HTML away, and keeps the browser's. So
 * the number a reader ends up looking at is the next fire computed in THEIR
 * zone — a fact about where they are sitting, not about the agent.
 *
 * ── WHY MOVING IT TO THE SERVER IS NOT THE FIX ───────────────────────────────
 *
 * The dashboard is not the scheduler. eve's in-process runner fires the cron
 * inside the AGENT, and packages/evestack-schedules/README.md:119 is explicit
 * that the fields are read in "the host's" timezone — that host. The shipped
 * layout in docker-compose.yml points the dashboard at
 * `host.docker.internal:2000`, so the ordinary self-hosted install is a UTC
 * container reading a database written by an agent running in its owner's own
 * zone. Computing in the dashboard's zone is a second wrong answer, not a right
 * one, and there is no header, env var or API that tells us the agent's zone.
 *
 * ── WHAT THIS DOES INSTEAD: ASK THE HISTORY ──────────────────────────────────
 *
 * `evestack.schedule_runs.fire_at` is a `timestamptz`
 * (packages/evestack-schedules/src/store.ts) holding the instant of a tick the
 * agent's own clock produced and the agent's own cron matched. Every recorded
 * fire is therefore one equation about where the agent is, and a handful of
 * them narrow it: a `0 9 * * *` whose last fires landed on 13:00Z can only
 * belong to an agent somewhere that read 09:00 at that instant. We solve for
 * the ZONE against the schedule's own runs, project the next fire in it, and
 * hand the page a plain instant — which renders to the same string in the
 * container and in the browser, so the hydration mismatch goes away as a side
 * effect of being correct.
 *
 * ── WHY ZONES AND NOT FIXED OFFSETS: THE DST BUG THIS ROUND FIXES ────────────
 *
 * The first version of this file solved for a fixed UTC OFFSET and then walked
 * the calendar at that offset forever. A fixed offset cannot spring forward, so
 * every projection that crossed a daylight-saving transition was wrong by the
 * jump — and, worse, was reported `pinned: true`, which is the flag that tells
 * `schedules-client.tsx:133` to suppress its hedge and draw a positive
 * "09:00 UTC-04:00" chip. Reproduced against that version, cron `0 9 * * *`,
 * history 2026-10-29/30/31T13:00:00Z (09:00 in New York, EDT), now
 * 2026-10-31T20:00:00Z:
 *
 *     returned  {at: 2026-11-01T13:00:00Z, offsetMinutes: -240, pinned: true}
 *     truth     2026-11-01T14:00:00Z  — 13:00Z reads 08:00 EST, an hour early
 *
 * and symmetrically across the spring transition it returned 2026-03-08T14:00Z
 * where the truth is 13:00Z. The answer was an hour out with no hedge at all.
 *
 * A real UTC offset is not a property of a deployment; a ZONE is, and a zone
 * carries the transition rules that make the arithmetic come out. So the
 * candidates here are IANA zones from `Intl.supportedValuesOf("timeZone")`, the
 * projection walks each zone segment-by-segment between its own transitions,
 * and `pinned` means what the word should mean: every zone that can explain
 * this schedule's recorded fires predicts this same instant. Where the history
 * is consistent with both a zone that observes DST and one that does not, and
 * the projection lands the far side of a transition, they disagree — and the
 * page hedges instead of picking one and calling it a fact.
 */

export interface NextFire {
  /** The next fire, as an absolute instant. Safe to render with `stamp()`. */
  readonly at: string;
  /**
   * The UTC offset, in minutes east of UTC, that the chosen zone is on AT `at`
   * — not the offset it is on now, which is the same number except across a
   * transition, where it is the whole point.
   */
  readonly offsetMinutes: number;
  /**
   * True when EVERY zone consistent with this schedule's own recorded fires
   * predicts this same instant. False means the page must hedge: either
   * nothing pinned the zone at all (`source: "assumed"`), or several zones fit
   * the history and disagree about the next fire (`source: "history"`).
   */
  readonly pinned: boolean;
  /**
   * Where `offsetMinutes` came from. "assumed" is the UTC fallback taken when
   * the schedule's history says nothing usable; "history" means the schedule's
   * own fires produced it, whether or not the zones that fit them agreed.
   * `pinned` implies "history" — the fallback is never pinned.
   */
  readonly source: "history" | "assumed";
}

/** One year of minutes — the same bound `nextFire` uses, for the same reason. */
const WALK_LIMIT = 366 * 24 * 60;

/**
 * How many recorded fires are read.
 *
 * Raised from the 24 the offset-based version used, and the reason is the DST
 * fix: under fixed offsets, old fires were a LIABILITY, because a fire from the
 * far side of a transition pinned a different offset and had to be discarded.
 * Under zones an old fire is the most valuable evidence there is — a history
 * that spans a transition is the only thing that can tell America/New_York
 * apart from America/Caracas, which sit on the same offset all summer and part
 * company on the first Sunday in November. `getSchedules` (lib/schedules.ts:147)
 * reads 100 rows across all schedules, so this ceiling is above anything the
 * page can actually hand over.
 *
 * Measured, and this is why the number is generous rather than merely bigger.
 * `30 2 * * *` in Europe/Berlin standing at 2026-03-28, its history walked back
 * by the package's own runner, projects 01:30Z at a cap of 128 and the runner's
 * own 01:00Z at 512. At 128 the window reaches back only to 2025-11-21 and 46
 * zones still fit it, among them the permanent UTC+01:00 ones that never spring
 * forward — Africa/Algiers, Africa/Lagos. At 512 it reaches 2024-11-14, past
 * two October transitions, and 33 are left: Europe/Berlin and the rest of the
 * EU family, which all agree. The real bound on the work is LABEL_BUDGET below,
 * not this.
 */
const OBSERVED_CAP = 512;

/**
 * How many zone readings the narrowing may spend, across all fires.
 *
 * The first fire costs one `Intl` call per candidate — 419 of them, measured at
 * ~2.06 us each — and every fire after that costs one per zone STILL STANDING,
 * which for any expression specific enough for the zone to matter has already
 * collapsed. Measured: `0 9 * * *` with a 13:00Z fire leaves 48 zones, so this
 * budget then buys ~407 more fires, four times what lib/schedules.ts:147 can
 * supply. A schedule loose enough that hundreds of zones keep fitting stops
 * early instead, and loses nothing by it.
 *
 * The number was chosen by measurement, not taste. Re-running the eighteen-case
 * runner-differential in test/schedules-next-fire.test.mjs with this constant
 * changed and nothing else: at 20,000, 17 of the 18 come out pinned and right
 * and none wrongly pinned. At 6,000 it is 11 pinned and right — still none
 * wrongly pinned, because a stopped narrowing hedges rather than lies, but six
 * schedules stop being answerable. 6,000 stops Europe/Berlin before the October
 * fire that separates it from Africa/Algiers. The extra readings are worth it.
 *
 * Stopping early only ever leaves MORE zones standing, which can make a result
 * less pinned but never wrongly pinned.
 */
const LABEL_BUDGET = 20_000;

// A ceiling on the total minute-steps one projection may spend walking.
//
// Line comments rather than a block, because the counterexample below contains
// a step expression and the slash-star in it would close a block comment three
// lines early, nowhere near where the compiler then complains.
//
// There is no cap on how many CANDIDATES get cross-checked — that cap is
// exactly what produced the second defect this round fixes. The first version
// of this file cross-checked only the 16 offsets nearest UTC and called the
// result `pinned`. `*/30 * * * 0-4` is an entirely ordinary schedule, and with
// a single recorded fire at 2026-08-04T00:00:00Z and now = 2026-08-06T19:00:00Z
// all 53 half-hour offsets survive it, the nearest 16 agree on 19:30Z, and
// TWENTY of the ones past the cap land on 2026-08-08 instead — two days later,
// reported to the reader as established fact.
//
// So every surviving candidate is checked now, and the walking is bounded by
// work instead. The bound almost never binds: an ordinary daily or hourly
// schedule spends well under 100k steps in total, and the loop stops at the
// first disagreement. When it DOES bind the projection is reported unpinned,
// because a cross-check that did not finish has established nothing. Measured
// warm on this machine, one full WALK_LIMIT walk (527,040 steps, the "0 0 30 2 *"
// case that never fires) takes 29.4 ms, so this ceiling is ~177 ms.
const WALK_BUDGET = 6 * WALK_LIMIT;

/**
 * How many zone transitions one projection will step over before giving up.
 *
 * The walk is bounded to a year, and measured against this ICU's tzdata by
 * bisecting every zone's offset hour by hour over 2015-2031, the most any zone
 * has in one year is four — Africa/Casablanca in 2015, its Ramadan pair on top
 * of its summer pair. Double that.
 */
const MAX_TRANSITION_HOPS = 8;

/**
 * How far apart the probes are when hunting for a zone's next transition.
 *
 * A pair of transitions closer together than this would be stepped over as if
 * neither had happened, which is a wrong projection rather than a crash, and is
 * the one approximation in this file. Measured over the same 2015-2031 sweep,
 * the closest consecutive pair anywhere is 28.0 days — Pacific/Fiji, 2020-12-19
 * to 2021-01-16 — so a week leaves a factor of four in hand.
 */
const TRANSITION_PROBE_MS = 7 * 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;

/**
 * Every IANA zone, plus "UTC" first.
 *
 * "UTC" is not in `Intl.supportedValuesOf("timeZone")` (checked: the list is
 * 418 canonical names and contains no `Etc/*` entry), and it has to be here —
 * an unconfigured Docker container is on it, which is the single most likely
 * deployment there is. It goes first so that when a permissive expression is
 * explained by everything, the offset reported is 0 and the page prints the
 * plain UTC instant the rest of the dashboard prints, rather than an arbitrary
 * member of a set that all agree anyway.
 *
 * Built lazily. This module is imported by `schedules-client.tsx`, so it is in
 * the browser bundle as well; `projectNextFire` is only ever called from the
 * server component, and a reader's browser should not pay to enumerate 419 zone
 * names it will never look at.
 */
let zoneList: readonly string[] | null = null;
let zoneListComplete = false;

function candidateZones(): readonly string[] {
  if (zoneList) return zoneList;
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  // If the runtime cannot enumerate zones we can still project, but we have not
  // checked anything, so nothing may be reported as pinned. Honest degradation
  // rather than a confident answer from a candidate set of one.
  zoneListComplete = supported.length > 0;
  zoneList = ["UTC", ...supported.filter((zone) => zone !== "UTC")];
  return zoneList;
}

/**
 * Wall-clock readings are read out of `Intl`, and building a formatter is the
 * expensive half of that: measured, 418 formatters cost ~41 ms to construct and
 * ~1.1 ms to run once each. Module-level so a process pays the construction
 * once, not once per schedule on the page.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      // h23 rather than `hour12: false`: the latter still yields "24" for
      // midnight under some ICU builds, and a 24 in the hour field would fail
      // every `fields.hours` lookup.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    FORMATTERS.set(zone, formatter);
  }
  return formatter;
}

/**
 * What a clock in `zone` reads at `instantMs`, carried as a UTC-epoch LABEL.
 *
 * A label, not a time: it is the reading with no zone underneath it, so
 * `getUTC*` on it gives the five numbers cron matches against, and subtracting
 * the instant from it gives the offset. Minute resolution, because that is all
 * a cron field can express and all a zone offset has ever needed.
 */
function labelOf(zone: string, instantMs: number): number {
  const parts = formatterFor(zone).formatToParts(new Date(instantMs));
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      default:
        break;
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute);
}

/** Minutes east of UTC that `zone` is on at `instantMs`. */
function offsetOf(zone: string, instantMs: number): number {
  const onTheMinute = Math.floor(instantMs / MINUTE_MS) * MINUTE_MS;
  return (labelOf(zone, onTheMinute) - onTheMinute) / MINUTE_MS;
}

/**
 * Does a wall-clock reading match?
 *
 * A transcription of `matchesParts` (packages/evestack-schedules/src/cron.ts:215)
 * onto the `getUTC*` accessors, including the OR rule for the two day fields,
 * which is Vixie cron's genuinely surprising behaviour and the one part of this
 * that cannot be guessed. The `Date` handed in is a LABEL — a reading, not an
 * instant — so reading it with anything but `getUTC*` would put the dashboard
 * host's zone straight back into the answer.
 */
function matchesLabel(fields: CronFields, label: Date): boolean {
  if (!fields.minutes.has(label.getUTCMinutes())) return false;
  if (!fields.hours.has(label.getUTCHours())) return false;
  if (!fields.months.has(label.getUTCMonth() + 1)) return false;
  const dayOfMonth = fields.daysOfMonth.has(label.getUTCDate());
  const dayOfWeek = fields.daysOfWeek.has(label.getUTCDay());
  return fields.bothDaysRestricted ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek;
}

/**
 * One projection's working state.
 *
 * `memo` is keyed on (start instant, offset) and is what keeps the cost of
 * checking hundreds of zones down to the number of DISTINCT offsets among them
 * — about 37 at any instant — because the fixed-offset walk is the only
 * expensive step and two zones on the same offset share its answer exactly.
 */
interface Walk {
  readonly fields: CronFields;
  readonly memo: Map<string, number | null>;
  /** Minute-steps still affordable; see WALK_BUDGET. */
  left: number;
  /** Set when a walk was cut short by the budget. Nothing after this is pinned. */
  starved: boolean;
}

/**
 * The next fire strictly after `fromMs`, reading the cron at a FIXED offset.
 *
 * Correct only while the zone stays on that offset, which is why nothing calls
 * this directly — `nextInZone` calls it once per constant-offset segment and
 * checks the segment actually reached the answer.
 */
function nextAtOffset(walk: Walk, fromMs: number, offsetMinutes: number): number | null {
  const key = `${fromMs}|${offsetMinutes}`;
  const memoized = walk.memo.get(key);
  // `null` is a real, cacheable answer ("nothing within a year"); only
  // `undefined` means the walk has not been run.
  if (memoized !== undefined) return memoized;

  const shift = offsetMinutes * MINUTE_MS;
  const label = new Date(fromMs + shift);
  label.setUTCSeconds(0, 0);
  label.setUTCMinutes(label.getUTCMinutes() + 1);

  for (let step = 0; step < WALK_LIMIT; step += 1) {
    if (walk.left <= 0) {
      // Deliberately NOT memoized: this is "we stopped", not "there is none",
      // and caching it would turn a budget exhaustion into a permanent wrong
      // answer for every later caller on the same offset.
      walk.starved = true;
      return null;
    }
    walk.left -= 1;
    if (matchesLabel(walk.fields, label)) {
      const at = label.getTime() - shift;
      walk.memo.set(key, at);
      return at;
    }
    label.setUTCMinutes(label.getUTCMinutes() + 1);
  }
  walk.memo.set(key, null);
  return null;
}

/**
 * The first instant in (`fromMs`, `toMs`] where `zone` is not on `offset`, to
 * the minute, or null if it holds that offset throughout.
 *
 * Coarse forward probes then a binary search, rather than a minute-by-minute
 * scan: the interval is usually under a day (the next fire of a daily cron), so
 * this is normally one `Intl` call and no search at all.
 */
function firstOffsetChange(
  zone: string,
  fromMs: number,
  toMs: number,
  offset: number,
): number | null {
  let low = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS;
  const end = Math.floor(toMs / MINUTE_MS) * MINUTE_MS;
  while (low < end) {
    const high = Math.min(low + TRANSITION_PROBE_MS, end);
    if (offsetOf(zone, high) !== offset) {
      let before = low;
      let after = high;
      while (after - before > MINUTE_MS) {
        const midpoint = before + Math.floor((after - before) / 2 / MINUTE_MS) * MINUTE_MS;
        if (midpoint <= before) break;
        if (offsetOf(zone, midpoint) === offset) before = midpoint;
        else after = midpoint;
      }
      return after;
    }
    low = high;
  }
  return null;
}

/**
 * Did the forward jump at `changeMs` erase a reading this schedule asked for?
 *
 * The counterpart of `stepMinute` (packages/evestack-schedules/src/cron.ts:265),
 * which exists in the package for the same reason: on the morning a zone springs
 * forward, the readings inside the erased hour have no instant at all, and Vixie
 * cron runs a job whose slot the jump ate once, at the moment the clock lands.
 * Keeping the two in agreement is the whole point — a projection that disagreed
 * with the runner about a spring-forward morning would be wrong on exactly the
 * day a reader most needs it.
 */
function erasedReadingMatches(
  fields: CronFields,
  changeMs: number,
  before: number,
  after: number,
): boolean {
  const lastReal = changeMs - MINUTE_MS + before * MINUTE_MS;
  const landing = changeMs + after * MINUTE_MS;
  const erased = (landing - lastReal) / MINUTE_MS - 1;
  if (erased <= 0) return false;
  const label = new Date(lastReal);
  for (let i = 0; i < erased; i += 1) {
    label.setUTCMinutes(label.getUTCMinutes() + 1);
    // One fire, however many erased readings matched: an hour of quarter-hourly
    // ticks that never happened is still one hour the schedule owes, not four.
    if (matchesLabel(fields, label)) return true;
  }
  return false;
}

/**
 * The next fire strictly after `afterMs` for an agent living in `zone`.
 *
 * Segment by segment between the zone's own transitions. Within one segment the
 * offset is constant and the fixed-offset walk is exact; if the walk's answer
 * lies past a transition then it was computed in the wrong frame and is thrown
 * away, the transition itself is examined for a fire the jump erased, and the
 * walk resumes on the far side at the new offset. This is what makes the
 * projection right across a daylight-saving change instead of an hour out.
 */
function nextInZone(walk: Walk, afterMs: number, zone: string, limitMs: number): number | null {
  let cursor = afterMs;
  for (let hop = 0; hop < MAX_TRANSITION_HOPS; hop += 1) {
    const before = offsetOf(zone, cursor);
    const at = nextAtOffset(walk, cursor, before);
    if (at === null || at > limitMs) return null;

    const changeMs = firstOffsetChange(zone, cursor, at, before);
    if (changeMs === null) return at;

    const after = offsetOf(zone, changeMs);
    if (after > before) {
      // Springing forward. The reading the clock LANDS on has never occurred
      // before and the resumed walk starts strictly after `changeMs`, so it
      // would be skipped; check it here. Then check the readings the jump
      // erased, which have no instant of their own and fire at the landing.
      if (matchesLabel(walk.fields, new Date(changeMs + after * MINUTE_MS))) return changeMs;
      if (erasedReadingMatches(walk.fields, changeMs, before, after)) return changeMs;
      // Springing forward erases readings, so there is no repeated interval to
      // step over: resume exactly at the transition.
      cursor = changeMs;
      continue;
    }
    // Falling back. Readings repeat rather than vanish, and Vixie does not
    // re-run the repeat — but resuming the walk AT `changeMs` hands the second
    // occurrence straight back, because the walk restarts at the new offset and
    // the repeated hour is, in that frame, still ahead of it.
    //
    //   `30 1 * * *`, America/New_York, now = 2026-11-01T05:30:00Z (01:30 EDT)
    //     projected  2026-11-01T06:30:00Z   the 01:30 EST repeat
    //     runner     2026-11-02T06:30:00Z   the next day
    //
    // Twenty-four hours early, and `pinned: true` because a history spanning a
    // transition pins the zone — so schedules-client.tsx:144 drew it as a firm
    // answer with no hedge. Skipping the repeated interval is the whole fix:
    // past it, the walk is in the new offset's frame and exact again.
    cursor = changeMs + (before - after) * MINUTE_MS;
  }
  return null;
}

/**
 * Which zones explain the fires this schedule actually recorded.
 *
 * Intersected over every fire, newest first — and note what that is NOT doing
 * any more. The offset-based version had to STOP at the first fire its
 * surviving set could not explain, because fires from either side of a
 * daylight-saving change pin different offsets and intersecting them left
 * nothing. A zone explains both, so the intersection is now the honest
 * operation it looks like, and history that spans a transition NARROWS the
 * answer instead of destroying it.
 *
 * It still stops on a fire that no surviving zone explains, which now means
 * something much narrower: the agent moved, or its clock is skewed, or it runs
 * a POSIX `TZ` string that is not an IANA zone. The recent fires are the ones a
 * projection into the future depends on, so those are the ones kept.
 *
 * `explained` is the count consumed. Zero means the newest recorded fire is not
 * a fire this expression could produce anywhere on earth, and the caller must
 * not then read anything into which zones are still standing.
 */
function zonesExplaining(
  fields: CronFields,
  observedMs: readonly number[],
): { zones: readonly string[]; explained: number } {
  let surviving: readonly string[] = candidateZones();
  let explained = 0;
  let budget = LABEL_BUDGET;
  for (const instantMs of observedMs) {
    // Explained by everybody, so it survives everybody: count it and move on
    // without asking 419 zones one at a time what they read.
    if (fireRulesOutNobody(fields, instantMs)) {
      explained += 1;
      continue;
    }
    if (budget < surviving.length) break;
    budget -= surviving.length;
    const narrowed = surviving.filter((zone) =>
      matchesLabel(fields, new Date(labelOf(zone, instantMs))),
    );
    if (narrowed.length === 0) break;
    surviving = narrowed;
    explained += 1;
    if (surviving.length === 1) break;
  }
  return { zones: surviving, explained };
}

/**
 * Can this fire rule ANY zone out?
 *
 * A zone survives a fire if its reading of that instant matches the expression,
 * and its reading is the instant shifted by whatever offset it is on. So if
 * every offset in the whole inhabited range matches, no zone can fail, and the
 * 419 `Intl` calls that would have proved it one at a time are pure waste —
 * which is the entire cost of a `* * * * *` schedule, the one that learns least
 * from its history.
 *
 * Whole minutes rather than quarter-hours, so that nothing here depends on the
 * claim that every zone offset is a multiple of 15 — true of tzdata today, but
 * not a thing this file should be betting a wrong answer on.
 *
 * It reads 28 clock readings, not 1561, and the first draft of it read 1561:
 * that made `* * * * *` with 512 recorded fires cost 98 ms, turning an
 * optimisation into the worst case it was written to remove. Two observations
 * collapse it. A restricted minute field can always rule something out, because
 * consecutive minute offsets sweep every minute of the hour — so the size check
 * returns immediately for very nearly every real expression. And once the
 * minute field is unrestricted, every reading inside one hour matches or fails
 * together, so only the hour boundaries need looking at.
 */
function fireRulesOutNobody(fields: CronFields, instantMs: number): boolean {
  if (fields.minutes.size < 60) return false;
  const label = new Date(instantMs);
  label.setUTCSeconds(0, 0);
  label.setUTCMinutes(label.getUTCMinutes() - 12 * 60);
  const last = label.getTime() + 26 * 60 * MINUTE_MS;
  for (;;) {
    if (!matchesLabel(fields, label)) return false;
    const at = label.getTime();
    if (at >= last) return true;
    label.setTime(Math.min(at + (60 - label.getUTCMinutes()) * MINUTE_MS, last));
  }
}

/** Recorded fires as epoch ms: parsed, de-duplicated, newest first, capped. */
function observedInstants(observed: readonly string[]): number[] {
  const seen = new Set<number>();
  for (const iso of observed) {
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms)) seen.add(ms);
  }
  return [...seen].sort((a, b) => b - a).slice(0, OBSERVED_CAP);
}

/**
 * Project the next fire of `expression`, using `observed` — this schedule's own
 * recorded `fire_at` instants — to work out where the agent is.
 *
 * Returns null when the expression cannot be parsed or cannot fire within a
 * year. `describeCron` already falls back to the raw expression for the first
 * of those; `nextFire` did not, and it was being called during the render of a
 * client component, so a single row in `schedule_runs` carrying an expression
 * this parser refuses would have thrown the whole page away. Saying nothing is
 * the same answer the label beside it gives.
 */
export function projectNextFire(
  expression: string,
  observed: readonly string[],
  now: Date = new Date(),
): NextFire | null {
  let fields: CronFields;
  try {
    fields = parseCron(expression);
  } catch {
    return null;
  }

  const nowMs = now.getTime();
  const limitMs = nowMs + WALK_LIMIT * MINUTE_MS;
  const walk: Walk = { fields, memo: new Map(), left: WALK_BUDGET, starved: false };
  const fires = observedInstants(observed);

  // No history at all should be impossible here — every schedule on the page is
  // built from a row in schedule_runs — but a caller that passes none gets an
  // honest "assumed UTC" rather than a projection dressed up as pinned.
  if (fires.length === 0) return assume(walk, nowMs);

  const { zones, explained } = zonesExplaining(fields, fires);
  if (explained === 0 || zones.length === 0) return assume(walk, nowMs);

  // Closest to UTC first, and "UTC" itself ahead of the zones that merely sit on
  // +00:00 today, so a permissive expression that every zone explains is
  // reported in the frame the rest of the dashboard prints in. `sort` is stable
  // in V8, which is what keeps the candidateZones() ordering as the tiebreak
  // and therefore keeps this function deterministic.
  const ordered = [...zones].sort((a, b) => {
    const left = offsetOf(a, nowMs);
    const right = offsetOf(b, nowMs);
    return Math.abs(left) - Math.abs(right) || left - right;
  });

  const chosen = ordered[0]!;
  const at = nextInZone(walk, nowMs, chosen, limitMs);
  if (at === null) return null;

  // Every surviving candidate, not a capped prefix of them — see WALK_BUDGET
  // for the `*/30 * * * 0-4` counterexample that a cap of 16 got wrong. The
  // loop stops at the first disagreement because one is enough to un-pin it.
  let pinned = zoneListComplete;
  for (const zone of ordered) {
    if (!pinned) break;
    if (zone === chosen) continue;
    if (nextInZone(walk, nowMs, zone, limitMs) !== at) pinned = false;
  }
  // A cross-check that ran out of budget has established nothing.
  if (walk.starved) pinned = false;

  return {
    at: new Date(at).toISOString(),
    // The offset AT THE FIRE, not at `now`: across a transition those differ,
    // and the one the reader needs in order to recognise "09:00" is this one.
    offsetMinutes: offsetOf(chosen, at),
    pinned,
    source: "history",
  };
}

function assume(walk: Walk, nowMs: number): NextFire | null {
  const at = nextAtOffset(walk, nowMs, 0);
  return at === null
    ? null
    : { at: new Date(at).toISOString(), offsetMinutes: 0, pinned: false, source: "assumed" };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "UTC", "UTC-04:00", "UTC+05:45" — the zone marker shown beside the instant. */
export function formatOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The wall-clock reading the cron expression was written as — "09:00" for
 * `0 9 * * *` on an agent at UTC-04:00, whose next fire is 13:00 UTC.
 *
 * Shown next to the instant rather than instead of it: the whole point of the
 * marker is that the reader can see both halves and stop wondering which one
 * the page means.
 */
export function agentClock(next: NextFire): string {
  const label = new Date(new Date(next.at).getTime() + next.offsetMinutes * MINUTE_MS);
  return `${pad(label.getUTCHours())}:${pad(label.getUTCMinutes())}`;
}

/**
 * The tooltip. Says which zone the fields were read in and where that came
 * from, because "next Aug 9 13:00:00 UTC" is unambiguous about the instant and
 * silent about the only thing a reader can still get wrong.
 */
export function describeNextFire(next: NextFire): string {
  const head = "Cron fields are wall-clock readings in the agent's timezone, not yours.";
  if (next.source === "assumed") {
    return (
      `${head} This schedule's recorded fires do not identify one — the expression may have been ` +
      "edited, or the agent's clock may be skewed — so this projection assumes UTC and is wrong " +
      "by that offset if the agent is not on it."
    );
  }
  if (!next.pinned) {
    // The daylight-saving case, and the honest thing to say about it: the
    // history is consistent with several zones, they part company somewhere
    // between now and this fire, and we are showing one of them. No bound is
    // quoted on how wrong it can be — measured against this ICU's tzdata over
    // 2015-2031, offset changes run to three hours, not the one hour a reader
    // would assume from "daylight saving".
    return (
      `${head} Several timezones fit this schedule's recorded fires and they disagree about this ` +
      `fire — at least one of them changes offset before then. Shown as ` +
      `${formatOffset(next.offsetMinutes)}, where it reads ${agentClock(next)}, but the agent may ` +
      "be in one of the others."
    );
  }
  if (next.offsetMinutes === 0) {
    return `${head} Its own recorded fires are consistent with UTC, which is what this reads them in.`;
  }
  return (
    `${head} Its own recorded fires pin the agent to ${formatOffset(next.offsetMinutes)}, ` +
    `where this fire is ${agentClock(next)}.`
  );
}
