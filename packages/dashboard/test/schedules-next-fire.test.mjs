/**
 * The /schedules "next run" projection.
 *
 * The defect this pins down is not arithmetic, it is WHOSE CLOCK. The page
 * rendered the next fire from a client component by calling the package's
 * `nextFire`, which walks the calendar with `getHours()`/`getDate()` — the
 * host's zone. In a client component that host is the container during SSR and
 * the reader's laptop during hydration, so the same cron produced a different
 * UTC instant depending on where the reader was sitting. The first test below
 * asserts both halves of that: the replacement is stable across three process
 * timezones, and the function it replaced is not.
 *
 * The rest exercise the derivation itself. `evestack.schedule_runs.fire_at` is
 * an instant the agent's own clock produced and its own cron matched, so every
 * recorded fire constrains where the agent is; these are the cases where that
 * either pins a zone, refuses to (and must say so), or must not throw.
 *
 * ── ROUND TWO: the two ways it claimed confidence it had not earned ──────────
 *
 * The first version solved for a fixed UTC OFFSET, which cannot spring forward,
 * and cross-checked only the sixteen candidate offsets nearest UTC before
 * declaring the answer `pinned`. Both produced confidently wrong answers, and
 * `pinned` is the flag that SUPPRESSES the page's hedge, so the reader saw a
 * positive chip either way. The last five tests in this file are the guards:
 * two daylight-saving transitions in opposite directions, the ordinary
 * half-hourly weekday schedule that the cap of sixteen got two days wrong, and
 * a differential that walks eighteen real schedules with the package's own
 * runner in their own zones and demands that no disagreement is ever pinned.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { nextFire } from "@evestack/schedules/cron";

/**
 * Two resolutions `test/ui-render.mjs` does not do, needed only by the render
 * test at the bottom of this file and registered here rather than there so a
 * shared harness is not reshaped for one page's needs.
 *
 * `schedules-client.tsx` imports `@/lib/time`, which is a tsconfig path alias
 * Node knows nothing about, and `./schedules.module.css`, which Node refuses
 * outright. Next resolves the first and turns the second into an object of
 * generated class names; the stub below returns the key as its own class name,
 * so `styles.zone` renders as `zone` and an assertion can name it.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      for (const extension of ["", ".ts", ".tsx"]) {
        const candidate = new URL(`../${specifier.slice(2)}${extension}`, import.meta.url);
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
      }
    }
    if (specifier.endsWith(".css") && context.parentURL) {
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => key });",
    };
  },
});

const {
  agentClock,
  describeNextFire,
  formatOffset,
  projectNextFire,
} = await import(new URL("../app/schedules/next-fire.ts", import.meta.url).href);

const { render } = await import(new URL("./ui-render.mjs", import.meta.url).href);
const { ScheduleList } = await import(
  new URL("../app/schedules/schedules-client.tsx", import.meta.url).href
);

/** 2026-08-09T06:00:00Z — a Sunday morning, so every expectation below is fixed. */
const NOW = new Date("2026-08-09T06:00:00.000Z");

/** Run `fn` with the process timezone set, and put it back however it was. */
function inZone(tz, fn) {
  const had = Object.hasOwn(process.env, "TZ");
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (had) process.env.TZ = before;
    else delete process.env.TZ;
  }
}

test("the projection is the same in every reader's timezone; nextFire is not", () => {
  const zones = ["UTC", "America/New_York", "Asia/Tokyo"];
  const projected = new Set();
  const walked = new Set();

  for (const tz of zones) {
    inZone(tz, () => {
      projected.add(projectNextFire("0 9 * * *", ["2026-08-08T09:00:00.000Z"], NOW).at);
      // The old call site, verbatim: what the client component used to do.
      walked.add(nextFire("0 9 * * *", NOW).toISOString());
    });
  }

  assert.equal(projected.size, 1, `projection moved with the timezone: ${[...projected]}`);
  // Not an aspiration — the reason the projection had to be written at all. If
  // this ever stops being 3, the package learned a zone and this file's premise
  // needs re-reading before it is trusted.
  assert.equal(walked.size, 3, `expected nextFire to disagree across zones, got ${[...walked]}`);
});

test("an agent four hours behind UTC is pinned by its own recorded fires", () => {
  const next = projectNextFire("0 9 * * *", ["2026-08-08T13:00:00.000Z"], NOW);
  assert.equal(next.at, "2026-08-09T13:00:00.000Z");
  assert.equal(next.offsetMinutes, -240);
  assert.equal(next.pinned, true);
  assert.equal(agentClock(next), "09:00");
  assert.equal(formatOffset(next.offsetMinutes), "UTC-04:00");
});

test("a UTC agent is pinned to UTC and carries no zone chip", () => {
  const next = projectNextFire("0 9 * * *", ["2026-08-08T09:00:00.000Z"], NOW);
  assert.equal(next.at, "2026-08-09T09:00:00.000Z");
  assert.equal(next.offsetMinutes, 0);
  assert.equal(next.pinned, true);
});

test("quarter-hour zones are candidates, so Kathmandu is pinned too", () => {
  // +05:45. Whole-hour candidates only would leave this agent unpinnable and
  // silently projected in UTC, 5h45m out.
  const next = projectNextFire("0 9 * * *", ["2026-08-08T03:15:00.000Z"], NOW);
  assert.equal(next.offsetMinutes, 345);
  assert.equal(formatOffset(next.offsetMinutes), "UTC+05:45");
  assert.equal(next.at, "2026-08-10T03:15:00.000Z");
  assert.equal(agentClock(next), "09:00");
});

test("an expression every zone explains is reported in UTC, not an arbitrary one", () => {
  // A half-hourly cron is consistent with every offset that is a multiple of 30
  // minutes — and all of them predict the same instant, which is what lets this
  // be pinned rather than hedged.
  const next = projectNextFire("0,30 * * * *", ["2026-08-09T05:30:00.000Z"], NOW);
  assert.equal(next.at, "2026-08-09T06:30:00.000Z");
  assert.equal(next.offsetMinutes, 0);
  assert.equal(next.pinned, true);
});

test("a fire from the other side of a daylight-saving change does not erase the offset", () => {
  // 09:00 New York recorded twice: 13:00Z in August (EDT) and 14:00Z in January
  // (EST). No single fixed offset explains both, and intersecting them to
  // nothing would throw the pinned zone away and fall back to UTC — four hours
  // wrong on the value a reader is about to plan around. The walk stops at the
  // first fire it cannot explain instead, keeping the offset the RECENT fires
  // share, which is the one the next fire will use.
  const next = projectNextFire(
    "0 0,9 * * *",
    ["2026-08-08T13:00:00.000Z", "2026-01-15T14:00:00.000Z"],
    NOW,
  );
  assert.equal(next.offsetMinutes, -240);
  assert.equal(next.at, "2026-08-09T13:00:00.000Z");
});

test("two fires narrow the zone where one leaves it ambiguous", () => {
  // 13:00Z alone fits both UTC-04:00 (09:00) and UTC+11:00 (00:00 the next day).
  // 04:00Z is 00:00 at UTC-04:00 and 15:00 at UTC+11:00, so it settles it.
  const one = projectNextFire("0 0,9 * * *", ["2026-08-08T13:00:00.000Z"], NOW);
  const two = projectNextFire(
    "0 0,9 * * *",
    ["2026-08-08T13:00:00.000Z", "2026-08-08T04:00:00.000Z"],
    NOW,
  );
  assert.equal(two.offsetMinutes, -240);
  assert.equal(two.pinned, true);
  assert.equal(one.offsetMinutes, -240, "the closest-to-UTC candidate is the one shown");
});

test("history that no zone explains is reported as assumed, not as pinned", () => {
  // Minute 7 with a `0 9 * * *` cron: every real offset is a multiple of 15, so
  // no zone reads this instant as :00. The expression was edited, or something
  // else is firing it — either way the page must not present the projection as
  // established fact.
  const next = projectNextFire("0 9 * * *", ["2026-08-08T13:07:00.000Z"], NOW);
  assert.equal(next.pinned, false);
  assert.equal(next.offsetMinutes, 0);
  assert.equal(next.at, "2026-08-09T09:00:00.000Z");
  assert.match(describeNextFire(next), /assumes\s+UTC/);
});

test("no history at all is never reported as pinned", () => {
  const next = projectNextFire("0 9 * * *", [], NOW);
  assert.equal(next.pinned, false);
  assert.equal(next.at, "2026-08-09T09:00:00.000Z");
});

test("an expression the parser refuses returns null instead of throwing", () => {
  // The reason this guard exists: the old call site was inside the render of a
  // client component and `nextFire` throws, so one unreadable `cron` column
  // would have taken the entire page down rather than one row's label.
  assert.throws(() => nextFire("0 9 * * * *", NOW));
  assert.equal(projectNextFire("0 9 * * * *", ["2026-08-08T13:00:00.000Z"], NOW), null);
  assert.equal(projectNextFire("@fortnightly", [], NOW), null);
});

test("an expression that can never fire returns null rather than spinning", () => {
  assert.equal(projectNextFire("0 0 30 2 *", [], NOW), null);
});

test("the offset marker reads as a zone at both ends of the range", () => {
  assert.equal(formatOffset(0), "UTC");
  assert.equal(formatOffset(-720), "UTC-12:00");
  assert.equal(formatOffset(840), "UTC+14:00");
  assert.equal(formatOffset(-210), "UTC-03:30");
  assert.equal(formatOffset(345), "UTC+05:45");
});

/**
 * Every fire the runner would have recorded in `tz` in the `days` before `now`.
 *
 * Built with the package's own `nextFire` under that process timezone, so the
 * history handed to the projection is exactly the history the agent would have
 * written — including whatever it does at a transition, which is the part under
 * test. `fires.at(-1)` is therefore the run the agent is about to do next.
 */
function historyIn(tz, expression, now, days) {
  return inZone(tz, () => {
    const out = [];
    let cursor = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 2000; i += 1) {
      const at = nextFire(expression, cursor);
      if (!at || at >= now) break;
      out.push(at.toISOString());
      cursor = at;
    }
    return out.reverse();
  });
}

const truthIn = (tz, expression, now) =>
  inZone(tz, () => nextFire(expression, now)?.toISOString());

test("a projection across a fall-back transition is the runner's answer, not an hour early", () => {
  // The reproduction from the round-one review, and the reason this file was
  // reopened. Cron `0 9 * * *`, agent in New York, standing on the Saturday
  // evening before the clocks go back. The offset-based version answered
  // 2026-11-01T13:00:00Z with `offsetMinutes: -240` and `pinned: true` — 08:00
  // EST, an hour early, with the page's hedge suppressed. -04:00 is simply not
  // the offset New York is on when this fire happens.
  const now = new Date("2026-10-31T20:00:00.000Z");
  const next = projectNextFire("0 9 * * *", historyIn("America/New_York", "0 9 * * *", now, 500), now);

  assert.equal(next.at, truthIn("America/New_York", "0 9 * * *", now));
  assert.equal(next.at, "2026-11-01T14:00:00.000Z");
  // The offset AT THE FIRE, which is the whole point: -300, not the -240 the
  // agent is on right now, and the reading it produces is the 09:00 written.
  assert.equal(next.offsetMinutes, -300);
  assert.equal(agentClock(next), "09:00");
  assert.equal(next.pinned, true);
});

test("a projection across a spring-forward transition is the runner's answer too", () => {
  // The same defect in the other direction: the offset-based version answered
  // 2026-03-08T14:00:00Z, an hour late, also pinned.
  const now = new Date("2026-03-07T20:00:00.000Z");
  const next = projectNextFire("0 9 * * *", historyIn("America/New_York", "0 9 * * *", now, 500), now);

  assert.equal(next.at, truthIn("America/New_York", "0 9 * * *", now));
  assert.equal(next.at, "2026-03-08T13:00:00.000Z");
  assert.equal(next.offsetMinutes, -240);
  assert.equal(agentClock(next), "09:00");
  assert.equal(next.pinned, true);
});

test("a reading a spring-forward erased fires where the runner fires it", () => {
  // 02:30 does not exist in Berlin on 2026-03-29; the clock goes 02:00 -> 03:00.
  // Vixie runs the job once, at the moment the clock lands, which is what
  // `stepMinute` (packages/evestack-schedules/src/cron.ts:265) implements for
  // the runner — so the projection has to implement it too or it disagrees with
  // the scheduler on precisely the morning a reader would notice.
  const now = new Date("2026-03-28T20:00:00.000Z");
  const next = projectNextFire("30 2 * * *", historyIn("Europe/Berlin", "30 2 * * *", now, 500), now);

  assert.equal(next.at, truthIn("Europe/Berlin", "30 2 * * *", now));
  assert.equal(next.at, "2026-03-29T01:00:00.000Z"); // 03:00 CEST, the landing
  assert.equal(next.pinned, true);
});

test("a reading a fall-back repeats is not offered twice", () => {
  // The mirror of the test above, and the one the first version got wrong.
  // 01:30 happens twice in New York on 2026-11-01: once at 05:30Z on EDT, then
  // again at 06:30Z on EST. Vixie fires the first and does not re-run the
  // repeat, so standing exactly on the first occurrence the next fire is the
  // NEXT DAY — not the repeat an hour later.
  //
  // The walk used to resume at the transition itself, which put the repeated
  // hour back in front of it in the new offset's frame and handed the second
  // occurrence straight back: 2026-11-01T06:30:00Z, twenty-four hours early,
  // and `pinned` because a history spanning a transition pins the zone. So the
  // page drew a firm answer, with the hedge suppressed, for the wrong instant.
  const now = new Date("2026-11-01T05:30:00.000Z");
  const next = projectNextFire("30 1 * * *", historyIn("America/New_York", "30 1 * * *", now, 500), now);

  assert.equal(next.at, truthIn("America/New_York", "30 1 * * *", now));
  assert.equal(next.at, "2026-11-02T06:30:00.000Z"); // 01:30 EST, the next day
  assert.notEqual(next.at, "2026-11-01T06:30:00.000Z"); // the repeat, never fired
  assert.equal(next.pinned, true);
});

test("a history that cannot tell a DST zone from a fixed one is not pinned", () => {
  // Two summer fires of `0 9 * * *` at 13:00Z, standing the day before the
  // clocks go back. America/New_York and America/Caracas both explain them and
  // both are ordinary places to run an agent; one springs back on the Sunday
  // and one never has. Nothing here can say which, and the offset-based version
  // said `pinned: true` anyway.
  const now = new Date("2026-10-31T20:00:00.000Z");
  const observed = ["2026-10-31T13:00:00.000Z", "2026-10-30T13:00:00.000Z"];
  const next = projectNextFire("0 9 * * *", observed, now);

  // Both candidates really do fit the recorded fires — the runner walking in
  // either zone lands on the newest one exactly.
  for (const zone of ["America/New_York", "America/Caracas"]) {
    const justBefore = new Date(Date.parse(observed[0]) - 60_000);
    assert.equal(inZone(zone, () => nextFire("0 9 * * *", justBefore).toISOString()), observed[0]);
  }
  // And they disagree about the fire being projected.
  assert.notEqual(
    truthIn("America/New_York", "0 9 * * *", now),
    truthIn("America/Caracas", "0 9 * * *", now),
  );

  assert.equal(next.pinned, false);
  assert.equal(next.source, "history", "the zone was narrowed, so this is not the UTC fallback");
  // Not "assumed UTC" either — that chip would claim the history said nothing.
  assert.match(describeNextFire(next), /disagree about this fire/);
});

test("an ordinary half-hourly weekday schedule is not pinned when the far offsets differ", () => {
  // The counterexample the round-one cap of 16 cross-checks got wrong. One
  // recorded fire on a Tuesday leaves all 53 half-hour offsets standing; the 16
  // nearest UTC all agree on 19:30Z, so it was reported pinned — and twenty of
  // the ones past the cap land on 2026-08-08 instead. Two days out, no hedge.
  const now = new Date("2026-08-06T19:00:00.000Z");
  const observed = ["2026-08-04T00:00:00.000Z"];
  const next = projectNextFire("*/30 * * * 0-4", observed, now);

  assert.equal(next.at, "2026-08-06T19:30:00.000Z");
  assert.equal(next.offsetMinutes, 0);
  assert.equal(next.pinned, false);

  // The disagreement is real, not theoretical: Asia/Tokyo explains the recorded
  // fire just as well as UTC does, and the runner there says two days later.
  const justBefore = new Date(Date.parse(observed[0]) - 60_000);
  assert.equal(
    inZone("Asia/Tokyo", () => nextFire("*/30 * * * 0-4", justBefore).toISOString()),
    observed[0],
  );
  assert.equal(truthIn("Asia/Tokyo", "*/30 * * * 0-4", now), "2026-08-08T15:00:00.000Z");
});

test("across eighteen real schedules, nothing that disagrees with the runner is pinned", () => {
  // The invariant `pinned` is supposed to carry, checked the only way that
  // means anything: run the package's own scheduler in a real zone, hand its
  // history back, and compare. A hedged wrong answer is a miss and allowed; a
  // PINNED wrong answer is the defect this round exists to remove.
  const cases = [
    ["30 2 * * *", "Europe/Berlin", "2026-03-28T20:00:00.000Z"],
    ["0 9 * * *", "Europe/Berlin", "2026-03-28T20:00:00.000Z"],
    ["0 9 * * *", "America/New_York", "2026-10-31T20:00:00.000Z"],
    ["0 9 * * *", "America/New_York", "2026-03-07T20:00:00.000Z"],
    ["30 2 * * *", "America/New_York", "2026-03-07T20:00:00.000Z"],
    ["30 1 * * *", "America/New_York", "2026-10-31T20:00:00.000Z"],
    ["0 9 * * 1-5", "Australia/Sydney", "2026-04-04T05:00:00.000Z"],
    ["15 6 * * *", "Asia/Kathmandu", "2026-08-09T06:00:00.000Z"],
    ["0 2 * * *", "America/Santiago", "2026-09-05T20:00:00.000Z"],
    ["0 4 * * *", "Asia/Tehran", "2026-08-09T06:00:00.000Z"],
    ["*/30 * * * 0-4", "Europe/London", "2026-10-24T20:00:00.000Z"],
    ["0 0 * * 0", "Pacific/Chatham", "2026-04-04T05:00:00.000Z"],
    ["0 9 * * *", "UTC", "2026-10-31T20:00:00.000Z"],
    ["0 3 * * *", "Europe/Dublin", "2026-10-24T20:00:00.000Z"],
    ["0 8 * * *", "Asia/Tokyo", "2026-08-09T06:00:00.000Z"],
    ["*/5 * * * *", "Europe/Berlin", "2026-03-28T20:00:00.000Z"],
    ["* * * * *", "UTC", "2026-08-09T06:00:00.000Z"],
    ["0 0 1 * *", "America/Sao_Paulo", "2026-08-09T06:00:00.000Z"],
  ];

  const wronglyPinned = [];
  let pinnedAndRight = 0;
  for (const [expression, zone, nowIso] of cases) {
    const now = new Date(nowIso);
    const next = projectNextFire(expression, historyIn(zone, expression, now, 500), now);
    const truth = truthIn(zone, expression, now);
    assert.ok(next, `${expression} @ ${zone} projected nothing at all`);
    if (next.at === truth) {
      if (next.pinned) pinnedAndRight += 1;
    } else if (next.pinned) {
      wronglyPinned.push(`${expression} @ ${zone}: said ${next.at}, runner says ${truth}`);
    }
  }

  assert.deepEqual(wronglyPinned, [], "a wrong answer was presented as pinned");
  // A floor, not a target. Without it this test would still pass if the
  // projection gave up and hedged everything, which is the cheap way to satisfy
  // the line above and is not the fix. Measured: 17 of the 18 are pinned and
  // right; the margin is for a tzdata update moving a few of them.
  assert.ok(
    pinnedAndRight >= 12,
    `only ${pinnedAndRight}/18 were pinned and correct — the projection has stopped pinning`,
  );
});

test("the page draws three different things, because there are three answers", () => {
  // The defect was never only arithmetic: `pinned` is what suppresses the hedge
  // in schedules-client.tsx, so an hour-wrong instant reached the reader wearing
  // a positive "09:00 UTC-04:00" chip. Rendering the real component is the only
  // way to hold that surface still — a projection can be as honest as it likes
  // and the page can still draw over it.
  const schedule = {
    name: "nightly",
    cron: "0 9 * * *",
    paused: false,
    failingStreak: 0,
    totalRuns: 3,
    failures: 0,
    lastRun: null,
    pausedBy: null,
  };
  const draw = (next) =>
    render(ScheduleList, { schedules: [schedule], recent: [], nextFires: { nightly: next } });

  // Pinned away from UTC: the reading and the zone, stated as fact.
  const pinned = draw({
    at: "2026-11-01T14:00:00.000Z",
    offsetMinutes: -300,
    pinned: true,
    source: "history",
  });
  assert.match(pinned, /next Nov 1 14:00:00 UTC<span class="zone">09:00 UTC-05:00<\/span>/);

  // Pinned ON UTC: no chip, because there is no second reading to give.
  const utc = draw({
    at: "2026-11-01T09:00:00.000Z",
    offsetMinutes: 0,
    pinned: true,
    source: "history",
  });
  assert.doesNotMatch(utc, /class="zone/);

  // Nothing was established: the pre-existing hedge, unchanged.
  const assumed = draw({
    at: "2026-11-01T09:00:00.000Z",
    offsetMinutes: 0,
    pinned: false,
    source: "assumed",
  });
  assert.match(assumed, /<span class="zone">assumed UTC<\/span>/);

  // The state the page could not previously say: the zone IS narrowed, the
  // candidates left disagree about this fire. This must not render as either of
  // the two above — "assumed UTC" would understate what the history gave us and
  // the bare chip would overstate it.
  const ambiguous = draw({
    at: "2026-11-01T13:00:00.000Z",
    offsetMinutes: -240,
    pinned: false,
    source: "history",
  });
  assert.match(ambiguous, /<span class="zone unconfirmed">unconfirmed · UTC-04:00<\/span>/);
  assert.doesNotMatch(ambiguous, /assumed UTC/);
});

test("the tooltip names the agent's zone whenever it differs from the reader's frame", () => {
  const pinned = projectNextFire("0 9 * * *", ["2026-08-08T13:00:00.000Z"], NOW);
  const text = describeNextFire(pinned);
  assert.match(text, /agent's timezone/);
  assert.match(text, /UTC-04:00/);
  assert.match(text, /09:00/);

  const utc = projectNextFire("0 9 * * *", ["2026-08-08T09:00:00.000Z"], NOW);
  assert.match(describeNextFire(utc), /consistent with UTC/);
});

test("a reading past the far edge of a repeated hour still fires, in a half-hour zone", () => {
  // The other half of the fall-back rule, and the case skipping the whole
  // interval got wrong. St John's replays 01:00–02:00 on 2026-11-01; `0 2` sits
  // on the far edge, so it has NOT already fired and occurs exactly once, at
  // the new offset:
  //
  //   skipping the interval  2026-11-02T05:30:00Z   twenty-five hours late, PINNED
  //   the runner             2026-11-01T05:30:00Z   02:00 NST, the same evening
  //
  // New York's `30 1 * * *` above is the opposite case — 01:30 is INSIDE the
  // replayed hour — so the two together pin the rule rather than one example of
  // it. A half-hour zone is not special here; it only made the bug legible,
  // because a 30-minute error is harder to mistake for a rounding artefact.
  const now = new Date("2026-10-31T20:00:00.000Z");
  const next = projectNextFire("0 2 * * *", historyIn("America/St_Johns", "0 2 * * *", now, 500), now);

  assert.equal(next.at, truthIn("America/St_Johns", "0 2 * * *", now));
  assert.equal(next.at, "2026-11-01T05:30:00.000Z");
  assert.notEqual(next.at, "2026-11-02T05:30:00.000Z"); // the skipped-past answer
});
