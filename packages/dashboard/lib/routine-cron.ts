import { parseCron, type CronFields } from "@evestack/schedules/cron";

const MINUTE = 60000;
const DAY = 86400000;

export function validateRoutineSchedule(cron: string, timeZone: string) {
  if (cron.length > 120 || timeZone.length > 100)
    throw new Error("Schedule is too long.");
  parseCron(cron);
  new Intl.DateTimeFormat("en", { timeZone }).format(0);
}

/** The same calendar evaluator powers preview and dispatch. It never changes process.env.TZ. */
export function nextRoutineFires(
  cron: string,
  timeZone: string,
  after: Date,
  count = 3,
): Date[] {
  return routineFires(cron, timeZone, after, count, 1);
}

export function previousRoutineFire(
  cron: string,
  timeZone: string,
  before: Date,
): Date | null {
  return routineFires(cron, timeZone, before, 1, -1)[0] ?? null;
}

function routineFires(
  cron: string,
  timeZone: string,
  after: Date,
  count: number,
  direction: 1 | -1,
): Date[] {
  validateRoutineSchedule(cron, timeZone);
  if (
    !Number.isFinite(after.getTime()) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 10
  )
    throw new Error("Invalid preview range.");
  const fields = parseCron(cron);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  function wall(instant: number) {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
  }
  const startWall = wall(after.getTime());
  const startDay = Math.floor(startWall / DAY) * DAY;
  const results = new Set<number>();
  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);
  // Eight years includes the Gregorian leap-day gap across a non-leap century.
  for (let step = 0; step <= 8 * 366 && results.size < count; step++) {
    const day = startDay + step * DAY * direction;
    if (!matchesDay(fields, new Date(day))) continue;
    const offsets = new Set<number>();
    for (
      let probe = day - 2 * DAY;
      probe <= day + 2 * DAY;
      probe += 12 * 3600000
    )
      offsets.add(wall(probe) - probe);
    for (const hour of hours)
      for (const minute of minutes) {
        const target = day + (hour * 60 + minute) * MINUTE;
        const candidates = [...offsets]
          .map((offset) => target - offset)
          .sort((a, b) => a - b);
        // Repeated local times choose the first instant, including if `after` lies in the second fold.
        let chosen = candidates.find((instant) => wall(instant) === target);
        if (chosen === undefined && candidates.length > 1) {
          // A spring gap fires at the first valid minute after the erased reading.
          for (
            let instant = candidates[0];
            instant <= candidates[candidates.length - 1];
            instant += MINUTE
          ) {
            const current = wall(instant);
            const previous = wall(instant - MINUTE);
            if (
              previous < target &&
              current > target &&
              current - previous > MINUTE
            ) {
              chosen = instant;
              break;
            }
          }
        }
        if (chosen !== undefined && (chosen - after.getTime()) * direction > 0)
          results.add(chosen);
      }
  }
  return [...results]
    .sort((a, b) => (a - b) * direction)
    .slice(0, count)
    .map((instant) => new Date(instant));
}

function matchesDay(fields: CronFields, day: Date) {
  if (!fields.months.has(day.getUTCMonth() + 1)) return false;
  const dom = fields.daysOfMonth.has(day.getUTCDate());
  const dow = fields.daysOfWeek.has(day.getUTCDay());
  return fields.bothDaysRestricted ? dom || dow : dom && dow;
}
