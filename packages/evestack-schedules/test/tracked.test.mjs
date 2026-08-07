import assert from "node:assert/strict";
import { test } from "node:test";
import { pauseWith, trackedWith } from "../dist/runner.js";

/**
 * The headline API, tested without a Postgres.
 *
 * `tracked()` had no test at all, which is how it shipped a wrapper that ran the
 * handler twice for one tick after every restart. The bugs in it are ordering
 * bugs — which tick a catch-up may replay, and what a refused claim is allowed to
 * mean — so what a test needs is not a database but the one rule the database
 * enforces: a unique index over (name, fire_at). `trackedWith` takes the store as
 * an argument for exactly that reason, and `dist/runner.js` is reachable from
 * here but not from a consumer, because the package's `exports` map publishes
 * only `.` and `./cron`.
 *
 * What this cannot cover: store.ts itself. `ensureSchema`, `claimRun`,
 * `finishRun`, `isPaused`, `setPaused`, `lastFireAt` and `closePool` are SQL, and
 * SQL needs a server — the `pnpm test` CI job has none, so a test for them would
 * be permanently skipped rather than green.
 */

/**
 * A store with the one property the real one is relied on for. Nothing else about
 * Postgres is load-bearing for the ordering rules below.
 */
function fakeStore({ lastFire = null, paused = false, breakClaim = false, breakPause = false } = {}) {
  const rows = new Map();
  const pauseWrites = [];
  let nextId = 1;
  return {
    rows,
    pauseWrites,
    async claimRun({ name, cron, fireAt, caughtUp }) {
      if (breakClaim) throw new Error("relation \"evestack.schedule_runs\" does not exist");
      const key = `${name}|${fireAt.getTime()}`;
      if (rows.has(key)) return null; // the (name, fire_at) unique index
      const id = String(nextId++);
      rows.set(key, {
        id,
        name,
        cron: cron ?? null,
        fireAt,
        caughtUp: caughtUp ?? false,
        status: "running",
        error: null,
      });
      return id;
    },
    async finishRun(id, outcome) {
      for (const row of rows.values()) {
        if (row.id !== id) continue;
        row.status = outcome.status;
        row.error = outcome.error ?? null;
      }
    },
    async isPaused() {
      if (breakPause) throw new Error("connection terminated");
      return paused;
    },
    async lastFireAt() {
      return lastFire;
    },
    async setPaused(name, value, by) {
      pauseWrites.push({ name, paused: value, by });
    },
  };
}

/** The wrapper logs on every path that swallows something; keep it out of the report. */
async function quiet(body) {
  const { warn, error } = console;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await body();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return lines;
}

/** Now, floored to the minute — the same tick the wrapper computes for itself. */
function tick() {
  const at = new Date();
  at.setSeconds(0, 0);
  return at;
}

const sorted = (store) => [...store.rows.values()].sort((a, b) => a.fireAt - b.fireAt);

test("a fire is recorded and completed, with the expression on the row", async () => {
  const store = fakeStore();
  let ran = 0;
  await trackedWith(store, "digest", "* * * * *", async () => {
    ran += 1;
  })({});
  assert.equal(ran, 1);
  const [row] = sorted(store);
  assert.equal(store.rows.size, 1);
  assert.equal(row.status, "completed");
  assert.equal(row.caughtUp, false);
  assert.equal(row.cron, "* * * * *");
});

test("a handler that throws is recorded as failed and the error still escapes", async () => {
  const store = fakeStore();
  await assert.rejects(
    trackedWith(store, "digest", "* * * * *", async () => {
      throw new TypeError("nope");
    })({}),
    /nope/,
  );
  const [row] = sorted(store);
  assert.equal(row.status, "failed");
  assert.equal(row.error, "TypeError: nope");
});

test("CATCH-UP does not replay the tick the live fire is about to run", async () => {
  // The bug: `missedFires` is inclusive of its end and catch-up passed the
  // current tick as that end, so the tick that is happening was replayed as a
  // tick that was missed. Then the live fire claimed the same tick, got the
  // refusal the catch-up had caused, and ran the handler anyway — two model turns
  // and two messages for one scheduled fire, with one row to show for it.
  const store = fakeStore({ lastFire: new Date(tick().getTime() - 3 * 60_000) });
  let ran = 0;
  await quiet(() =>
    trackedWith(store, "hb", "* * * * *", async () => {
      ran += 1;
    }, { catchUp: true, catchUpLimit: 10 })({}),
  );

  const rows = sorted(store);
  // The invariant, and it is the whole test: one run per recorded tick. Before
  // the fix this was 4 runs against 3 rows.
  assert.equal(ran, rows.length, "every recorded tick must have run exactly once");
  assert.ok(rows.length >= 3, `expected the gap plus the live fire, got ${rows.length}`);
  const live = rows.at(-1);
  assert.equal(live.caughtUp, false, "the newest tick belongs to the live fire, not to the replay");
  assert.ok(
    rows.slice(0, -1).every((row) => row.caughtUp),
    "the older ticks are replays and must be labelled as such",
  );
});

test("a tick another worker already claimed does not run a second time", async () => {
  const store = fakeStore();
  // Seed both this minute and the next: the wrapper reads the clock itself, so if
  // the minute turns over mid-test the fire belongs to the following tick.
  await store.claimRun({ name: "hb", fireAt: tick() });
  await store.claimRun({ name: "hb", fireAt: new Date(tick().getTime() + 60_000) });
  let ran = 0;
  await quiet(() =>
    trackedWith(store, "hb", "* * * * *", async () => {
      ran += 1;
    })({}),
  );
  assert.equal(ran, 0, "a tick already in the table has already run");
  assert.equal(store.rows.size, 2, "and nothing new was recorded for it");
});

test("a store that cannot record the fire does not stop the fire", async () => {
  // The other half of the same decision. A refused claim and a broken claim were
  // both `null`; only the first one may stop the handler, or a schedule goes
  // quiet because its bookkeeping database did.
  const store = fakeStore({ breakClaim: true });
  let ran = 0;
  const logged = await quiet(() =>
    trackedWith(store, "hb", "* * * * *", async () => {
      ran += 1;
    })({}),
  );
  assert.equal(ran, 1, "fails open: the handler runs unrecorded");
  assert.equal(store.rows.size, 0);
  assert.ok(logged.some((line) => line.includes("could not record this fire")));
});

test("an unreadable pause table fails open too", async () => {
  const store = fakeStore({ breakPause: true });
  let ran = 0;
  const logged = await quiet(() =>
    trackedWith(store, "hb", "* * * * *", async () => {
      ran += 1;
    })({}),
  );
  assert.equal(ran, 1);
  assert.ok(logged.some((line) => line.includes("could not read pause state")));
});

test("a paused schedule records a skip instead of running", async () => {
  const store = fakeStore({ paused: true });
  let ran = 0;
  await trackedWith(store, "hb", "* * * * *", async () => {
    ran += 1;
  })({});
  assert.equal(ran, 0);
  const [row] = sorted(store);
  assert.equal(row.status, "skipped");
  assert.equal(row.error, "schedule is paused");
});

test("catch-up runs once per process, not once per fire", async () => {
  const store = fakeStore({ lastFire: new Date(tick().getTime() - 2 * 60_000) });
  const run = trackedWith(store, "hb", "* * * * *", async () => {}, { catchUp: true });
  const first = await quiet(() => run({}));
  const second = await quiet(() => run({}));
  assert.ok(first.some((line) => line.includes("replaying")));
  assert.ok(!second.some((line) => line.includes("replaying")), "the second fire must not replay again");
});

test("tracked parses at wrap time — and an uppercase day name is not a parse error", () => {
  // Eager parsing is the point: a bad expression fails at module load rather than
  // at 3am. It is also why the case-insensitivity bug was fatal — `0 9 * * WED`
  // threw here, at import, and took the agent with it.
  assert.doesNotThrow(() => trackedWith(fakeStore(), "hb", "0 9 * * WED", async () => {}));
  assert.doesNotThrow(() => trackedWith(fakeStore(), "hb", "0 0 1 JUL *", async () => {}));
  assert.throws(() => trackedWith(fakeStore(), "hb", "0 9 * * funday", async () => {}), /not a number/);
  assert.throws(() => trackedWith(fakeStore(), "hb", "0 0 L * *", async () => {}), /not supported/);
});

test("pause and resume write opposite values, and carry who did it", async () => {
  const store = fakeStore();
  await pauseWith(store, "hb", true, "sammy");
  await pauseWith(store, "hb", false);
  assert.deepEqual(store.pauseWrites, [
    { name: "hb", paused: true, by: "sammy" },
    { name: "hb", paused: false, by: undefined },
  ]);
});
