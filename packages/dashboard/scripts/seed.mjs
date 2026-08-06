#!/usr/bin/env node
/**
 * Dev-only corpus generator: a database that looks like a month of real usage.
 *
 * Why this exists. Every dashboard surface worth building — a p99 latency chart, a
 * cost breakdown by model, a distribution heatmap, a period-over-period delta — needs
 * enough data to have a shape. The dev stacks `create-evestack` produces are named per
 * project and get torn down, and tearing one down destroys its history: the database
 * behind every measurement in .context/dashboard-v2/RESEARCH.md was deleted a few hours
 * after those measurements were taken, and the one that replaced it held three runs.
 * You cannot review a chart drawn over three runs, so this makes a real one on demand.
 *
 * WHY THIS WRITES TO THE `workflow` SCHEMA, WHICH NOTHING ELSE MAY DO.
 * That schema belongs to `@workflow/world-postgres`; it owns those migrations and holds
 * durable session state, so the dashboard only ever reads it. That rule is about the
 * running product. There is no way to fabricate two thousand runs without writing runs,
 * and driving a real agent hard enough to produce them would cost real money and still
 * not let us place a latency spike where we want one. So this script is the documented
 * exception, and it is fenced accordingly:
 *
 *   - It is a script under scripts/, never imported by the app. Nothing in app/ or lib/
 *     can reach it, so it cannot run by accident in a deployment.
 *   - Everything it writes is stamped `deployment_id = 'evestack-seed'`. Real eve runs
 *     carry the deployment id world-postgres assigns (observed: 'postgres'), so seeded
 *     and real rows are distinguishable by a single indexed equality.
 *   - It refuses to touch a database holding runs it did not create, unless you say
 *     --force. The failure mode this prevents is someone seeding their actual agent.
 *   - `--purge` deletes exactly the stamped rows and nothing else, so the exception is
 *     reversible.
 *
 * Determinism is deliberate. The PRNG is seeded and every timestamp is derived from a
 * fixed `--now`, so two runs of this script produce byte-identical data. Screenshots
 * stay comparable across a redesign, and a failing chart test fails the same way twice.
 *
 * It emits SQL on stdout rather than connecting to anything. That keeps it dependency
 * free — no client library to install, nothing to break when a workspace's node_modules
 * is mid-reinstall — makes the fixture reviewable as text before it touches a database,
 * and loads through COPY, which is an order of magnitude faster than parameterised
 * INSERTs at this row count. It also matches how the rest of this package ships schema:
 * a .sql file an operator can pipe into psql.
 *
 * Usage:
 *   node scripts/seed.mjs | psql "$WORKFLOW_POSTGRES_URL"
 *   node scripts/seed.mjs | docker exec -i <pg-container> psql -U evestack -d evestack
 *   node scripts/seed.mjs --purge | psql …              remove seeded rows only
 *   node scripts/seed.mjs --days 60 --sessions 1500
 *   node scripts/seed.mjs --seed 7                      a different but repeatable world
 *
 * The emitted script is one transaction and is idempotent: it deletes its own previous
 * output before writing, so re-running replaces rather than doubles.
 */

// --- Shapes taken from a live database, not from memory ----------------------
//
// These strings are how eve actually writes itself down; the seeder is only useful to
// the extent it is indistinguishable from the real thing. Verified against a running
// instance on 2026-08-06.

const RUN_NAME = {
  session: "workflow//eve//workflowEntry",
  turn: "workflow//eve//turnWorkflow",
  /** Started alongside every session and carries NO `$eve.type` at all. Every query in
   *  lib/queries.ts filters on `$eve.type` precisely to exclude it; reproducing it is
   *  the only way a "count the sessions" bug shows up here rather than in production. */
  timeout: "workflow//eve//sessionTimeoutWorkflow",
};

const EVE_VERSION = "0.30.8";
const STEP = (n) => `step//eve@${EVE_VERSION}//${n}`;

/** The real per-turn step sequence, in order. */
const TURN_STEPS = [
  "resolveInitialTurnCallerStep",
  "sendTurnControlStep",
  "dispatchTurnStep",
  "turnStep",
  "notifyTurnCallerStep",
];

const SESSION_STEPS = ["createSessionStep", "startSessionTimeoutStep"];

const SPAN_RESOURCE = {
  "service.name": "evestack-seed",
  "cloud.provider": "vercel",
  "vercel.runtime": "nodejs",
  "process.runtime.name": "nodejs",
};

/**
 * The placeholder run id engine-noise spans carry.
 *
 * This is not an invention. `workflow.stream.read.complete` spans really do carry
 * `workflow.run.id` set to an all-zero ULID, which is why 92% of a real spans table
 * looks attributable and joins to nothing. RESEARCH.md §11.2 argued that widening the
 * session_id generated column with `workflow.run.id` would attribute engine noise; this
 * is worse than that — it would attribute tens of thousands of spans to a run that has
 * never existed. Seeding it faithfully is what lets the attribution work prove it did
 * not fall into that hole.
 */
const PLACEHOLDER_RUN_ID = "wrun_00000000000000000000000000";

/**
 * Models, chosen to exercise all three pricing states rather than to be realistic about
 * market share. `pricing.ts` prices the first two from the generated gateway catalog,
 * prices `ollama/*` at zero on purpose because local inference is genuinely free, and
 * knows nothing about the last one — which must render as "unpriced", never as $0.00.
 */
const MODELS = [
  // rate: USD per million tokens, matching lib/pricing.ts. `priced: false` means the
  // catalog has no entry, which is NOT the same as free and must never be summed as $0.
  {
    id: "openai/gpt-5-mini",
    weight: 40,
    provider: "openai",
    speed: 1.0,
    cached: true,
    priced: true,
    rate: { input: 0.25, output: 2, cacheRead: 0.025 },
  },
  {
    id: "anthropic/claude-sonnet-5",
    weight: 25,
    provider: "anthropic",
    speed: 1.7,
    cached: true,
    priced: true,
    rate: { input: 2, output: 10, cacheRead: 0.2 },
  },
  {
    // Priced, and priced at zero, on purpose: local inference costs no API money.
    id: "ollama/qwen3",
    weight: 25,
    provider: "ollama",
    speed: 3.2,
    cached: false,
    priced: true,
    rate: { input: 0, output: 0, cacheRead: 0 },
  },
  {
    // Not in the catalog at all. Exercises the "unpriced" path, which must render as
    // unpriced rather than as $0.00.
    id: "acme/experimental-v1",
    weight: 10,
    provider: "acme",
    speed: 1.3,
    cached: false,
    priced: false,
    rate: null,
  },
];

const TRIGGERS = [
  { id: "http", weight: 45 },
  { id: "schedule", weight: 25 },
  { id: "slack", weight: 18 },
  { id: "webhook", weight: 12 },
];

const TOOLS = [
  { name: "bash", failRate: 0.08, ms: [120, 4000] },
  { name: "read_file", failRate: 0.02, ms: [8, 120] },
  { name: "write_file", failRate: 0.03, ms: [10, 200] },
  { name: "grep", failRate: 0.02, ms: [20, 900] },
  { name: "remember", failRate: 0.01, ms: [30, 260] },
  { name: "recall", failRate: 0.01, ms: [25, 340] },
  { name: "web_search", failRate: 0.12, ms: [400, 9000] },
];

const TITLES = [
  "Summarize yesterday's error logs",
  "Draft release notes for v0.4.0",
  "Deploy summary email to the team",
  "Write a detailed essay about database indexing",
  "Triage the failing nightly build",
  "Reconcile the invoice spreadsheet",
  "Answer the on-call page",
  "Refactor the auth middleware",
  "Explain this stack trace",
  "Find every caller of getTraceStats",
  "Generate weekly metrics digest",
  "Review the open dependabot PRs",
];

// --- Deterministic randomness ------------------------------------------------
//
// Math.random would make every run produce a different database, which quietly breaks
// the two things this script exists for: comparable screenshots and reproducible tests.

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.next = mulberry32(seed);
  }
  float(lo = 0, hi = 1) {
    return lo + this.next() * (hi - lo);
  }
  int(lo, hi) {
    return Math.floor(this.float(lo, hi + 1));
  }
  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }
  /** Weighted pick over `[{weight}]`. */
  weighted(list) {
    const total = list.reduce((sum, item) => sum + item.weight, 0);
    let roll = this.float(0, total);
    for (const item of list) {
      roll -= item.weight;
      if (roll <= 0) return item;
    }
    return list[list.length - 1];
  }
  chance(p) {
    return this.next() < p;
  }
  /** Log-normal-ish: latency is not symmetric, and a mean with no tail is not latency. */
  lognormal(median, sigma) {
    const u1 = Math.max(this.next(), 1e-9);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return median * Math.exp(sigma * z);
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID-shaped ids. Sortable by construction, like the real ones. */
function makeId(rng, prefix, when) {
  let time = "";
  let ms = when.getTime();
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i += 1) rand += CROCKFORD[rng.int(0, 31)];
  return `${prefix}_${time}${rand}`;
}

function hex(rng, bytes) {
  let out = "";
  for (let i = 0; i < bytes * 2; i += 1) out += "0123456789abcdef"[rng.int(0, 15)];
  return out;
}

// --- Traffic shape -----------------------------------------------------------

/**
 * Relative traffic by hour, UTC. Flat traffic makes every time-series chart a
 * rectangle, which hides exactly the bugs a time series is for — an off-by-one in
 * bucketing reads as correct against a flat line.
 */
const HOUR_WEIGHT = [
  0.2, 0.15, 0.12, 0.1, 0.1, 0.15, 0.3, 0.55, 0.85, 1.0, 1.0, 0.95,
  0.8, 0.9, 1.0, 0.95, 0.85, 0.7, 0.55, 0.45, 0.4, 0.35, 0.3, 0.25,
];

/** Weekends are quieter. */
const DAY_WEIGHT = [0.35, 1.0, 1.0, 1.0, 1.0, 0.95, 0.4];

function pickMoment(rng, startMs, endMs) {
  // Rejection-sample against the diurnal/weekly envelope so density follows the curve
  // rather than being uniform with a decorative label.
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const at = new Date(rng.float(startMs, endMs));
    const weight = HOUR_WEIGHT[at.getUTCHours()] * DAY_WEIGHT[at.getUTCDay()];
    if (rng.next() <= weight) return at;
  }
  return new Date(rng.float(startMs, endMs));
}

// --- Incident windows --------------------------------------------------------
//
// A chart that reveals nothing is not evidence that the chart works. Each of these is
// a thing someone should be able to SEE, and therefore a thing a reviewer can check.

function makeIncidents(rng, startMs, endMs) {
  const span = endMs - startMs;
  const at = (frac, hours) => ({
    from: startMs + span * frac,
    to: startMs + span * frac + hours * 3600_000,
  });
  return {
    /** Latency triples. Should be obvious on p95, invisible on a count. */
    latency: at(0.42, 5),
    /** Provider errors cluster. Should move the error rate, not the latency. */
    errors: at(0.68, 3),
    /** Retry storm: steps retry, turns still succeed. Only a step view shows it. */
    retries: at(0.83, 4),
  };
}

const within = (window, ms) => ms >= window.from && ms <= window.to;

// --- Generation --------------------------------------------------------------

export function generate(opts) {
  const rng = new Rng(opts.seed);
  const endMs = opts.now.getTime();
  const startMs = endMs - opts.days * 86400_000;
  const incidents = makeIncidents(rng, startMs, endMs);

  const runs = [];
  const steps = [];
  const events = [];
  const spans = [];
  const budgetSteps = [];
  const budgetEvents = [];
  const budgetStops = [];

  // Spans are only generated for the tail of the window. That is not a shortcut: a real
  // install exports spans opt-in and prunes them long before it prunes runs, so a
  // database where every run has spans is the unrealistic one. It also keeps the row
  // count sane — at the true ~880 spans per run, a month would be well over a million.
  const spanFromMs = endMs - Math.min(opts.days, opts.spanDays) * 86400_000;

  let eventSeq = 0;
  let turnOrdinal = 0;
  const pushEvent = (runId, type, at, payload = null) => {
    eventSeq += 1;
    events.push({
      id: `wevt_${String(eventSeq).padStart(20, "0")}`,
      type,
      run_id: runId,
      created_at: at,
      payload,
    });
  };

  for (let s = 0; s < opts.sessions; s += 1) {
    const sessionStart = pickMoment(rng, startMs, endMs);
    const sessionMs = sessionStart.getTime();
    const trigger = rng.weighted(TRIGGERS).id;
    const model = rng.weighted(MODELS);
    const sessionId = makeId(rng, "wrun", sessionStart);
    const title = rng.pick(TITLES);

    const turnCount = rng.chance(0.55) ? 1 : rng.int(2, 6);

    // A handful of sessions are deliberately pathological, because "what does the
    // dashboard do when this happens" is the question the dashboard exists to answer.
    const isWedged = s % 97 === 0;
    const awaitingHuman = s % 61 === 0 && !isWedged;
    const budgetStopped = s % 131 === 0 && !isWedged && !awaitingHuman;
    // Sessions stay `running` while a conversation is open; only some ever settle.
    // lib/monitors.ts leans on this — a session duration measures the human, not the
    // agent — so the seeded mix has to contain both.
    const sessionCompletes = !isWedged && !awaitingHuman && rng.chance(0.8);

    let cursor = sessionMs;
    const turns = [];

    for (let t = 0; t < turnCount; t += 1) {
      // Think time between turns is a human, not a machine.
      if (t > 0) cursor += rng.lognormal(38_000, 1.1);
      const turnStart = new Date(cursor);
      const turnId = makeId(rng, "wrun", turnStart);

      const inLatency = within(incidents.latency, cursor);
      const inErrors = within(incidents.errors, cursor);
      const inRetries = within(incidents.retries, cursor);

      // Base turn latency, stretched during the latency incident.
      let durationMs = rng.lognormal(4200 * model.speed, 0.75) * (inLatency ? 3.1 : 1);

      const toolsOffered = rng.int(8, 18);
      const toolCalls = rng.chance(0.62) ? rng.int(1, 6) : 0;

      // Three distinct ways a turn goes wrong, which the dashboard must not conflate:
      //   errored       the workflow row carries an error_code
      //   noModelCall   it finished, but never recorded `$eve.model` — the provider was
      //                 never reached. lib/queries.ts calls this out; an error rate
      //                 built on error_code alone reports these as successes.
      //   cancelled     a human stopped it, which is not a failure at all
      // Rare outcomes are forced on a fixed stride as well as rolled for, because a
      // 1.2% chance over a small --sessions run produces zero of them, and a fixture
      // that omits the failure path lets code that mishandles it pass. The stride
      // guarantees presence; the roll keeps the distribution from looking mechanical.
      turnOrdinal += 1;
      const errored = turnOrdinal % 29 === 0 || rng.chance(inErrors ? 0.28 : 0.025);
      const noModelCall = !errored && (turnOrdinal % 37 === 0 || rng.chance(inErrors ? 0.09 : 0.012));
      const cancelled = !errored && !noModelCall && (turnOrdinal % 53 === 0 || rng.chance(0.008));
      const lastTurnOfWedged = isWedged && t === turnCount - 1;

      const settled = !lastTurnOfWedged;
      const turnEnd = settled ? new Date(cursor + durationMs) : null;

      const cacheRead = model.cached && t > 0 ? rng.int(1200, 14_000) : 0;
      const cacheWrite = model.cached && t === 0 ? rng.int(800, 9000) : 0;
      const inputTokens = rng.int(900, 12_000) + cacheRead;
      const outputTokens = errored || noModelCall ? 0 : rng.int(40, 2600);

      const status = lastTurnOfWedged
        ? "running"
        : cancelled
          ? "cancelled"
          : errored
            ? "failed"
            : "completed";

      const attributes = {
        "$eve.type": "turn",
        "$eve.parent": sessionId,
        "$eve.root": sessionId,
        $parentRunId: sessionId,
        $rootRunId: sessionId,
        "$eve.tool_count": String(toolsOffered),
      };
      // eve writes `$eve.model` only once a model call reports usage. Its absence on a
      // finished turn IS the no-model-call signal, so it must genuinely be absent.
      if (!noModelCall) {
        attributes["$eve.model"] = model.id;
        attributes["$eve.input_tokens"] = String(inputTokens);
        attributes["$eve.output_tokens"] = String(outputTokens);
        attributes["$eve.cache_read_tokens"] = String(cacheRead);
        attributes["$eve.cache_write_tokens"] = String(cacheWrite);
      }

      runs.push({
        id: turnId,
        name: RUN_NAME.turn,
        status,
        created_at: turnStart,
        started_at: turnStart,
        completed_at: turnEnd,
        updated_at: turnEnd ?? turnStart,
        error: errored ? "Provider returned 529 (overloaded)" : null,
        error_code: errored ? "provider_overloaded" : null,
        attributes,
      });

      pushEvent(turnId, "run_created", turnStart);
      pushEvent(turnId, "run_started", turnStart);

      // Steps, with retry attempts during the retry storm. A turn that succeeded after
      // four attempts looks identical to a clean one unless something reads steps.
      let stepAt = turnStart.getTime();
      for (const name of TURN_STEPS) {
        const attempts = inRetries && name === "turnStep" ? rng.int(2, 5) : 1;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          const last = attempt === attempts;
          const stepMs = (durationMs / TURN_STEPS.length) * rng.float(0.6, 1.4);
          const stepStart = new Date(stepAt);
          const stepEnd = settled ? new Date(stepAt + stepMs) : null;
          steps.push({
            run_id: turnId,
            step_id: makeId(rng, "wstp", stepStart),
            step_name: STEP(name),
            status: !settled ? "running" : last ? (errored ? "failed" : "completed") : "failed",
            attempt,
            started_at: stepStart,
            completed_at: stepEnd,
            created_at: stepStart,
            updated_at: stepEnd ?? stepStart,
            error: last ? null : "transient: connection reset",
          });
          pushEvent(turnId, "step_created", stepStart);
          pushEvent(turnId, "step_started", stepStart);
          if (stepEnd) pushEvent(turnId, "step_completed", stepEnd);
          stepAt += stepMs;
        }
      }

      if (settled) pushEvent(turnId, "run_completed", turnEnd);

      // Cost ledger. Mirrors what @evestack/budget records per step.
      if (!noModelCall && !errored) {
        budgetSteps.push({
          session_id: sessionId,
          turn_id: turnId,
          step_index: t,
          sequence: budgetSteps.length,
          principal_id: `user_${(s % 7) + 1}`,
          day: turnStart,
          model: model.id,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cacheRead,
          priced: model.priced,
          // Cost is computed from THIS model's rates. Billing every model at one rate
          // would make the cost surface agree with itself and disagree with reality,
          // which is the one thing a cost fixture must not do. An unpriced model
          // records 0 alongside priced=false; the zero is a placeholder, and the
          // boolean is what stops anything summing it as though it were free.
          cost_usd: model.priced
            ? (inputTokens - cacheRead) * (model.rate.input / 1e6) +
              cacheRead * (model.rate.cacheRead / 1e6) +
              outputTokens * (model.rate.output / 1e6)
            : 0,
          created_at: turnStart,
        });
      }

      turns.push({
        turnId,
        turnStart,
        turnEnd,
        model,
        toolCalls,
        toolsOffered,
        inputTokens,
        outputTokens,
        cacheRead,
        errored,
        noModelCall,
        durationMs,
      });

      cursor += durationMs;

      // A subagent, occasionally. Nested runs are the thing the session tree renders.
      if (rng.chance(0.12)) {
        const subStart = new Date(turnStart.getTime() + rng.float(200, 1500));
        const subId = makeId(rng, "wrun", subStart);
        const subMs = rng.lognormal(2600, 0.8);
        runs.push({
          id: subId,
          name: RUN_NAME.turn,
          status: "completed",
          created_at: subStart,
          started_at: subStart,
          completed_at: new Date(subStart.getTime() + subMs),
          updated_at: new Date(subStart.getTime() + subMs),
          error: null,
          error_code: null,
          attributes: {
            "$eve.type": "subagent",
            "$eve.parent": turnId,
            "$eve.root": sessionId,
            $parentRunId: turnId,
            $rootRunId: sessionId,
            "$eve.model": model.id,
            "$eve.input_tokens": String(rng.int(400, 3000)),
            "$eve.output_tokens": String(rng.int(20, 700)),
            "$eve.cache_read_tokens": "0",
            "$eve.cache_write_tokens": "0",
            "$eve.tool_count": String(rng.int(3, 9)),
          },
        });
      }
    }

    const sessionEnd = sessionCompletes ? new Date(cursor + rng.float(500, 4000)) : null;

    runs.push({
      id: sessionId,
      name: RUN_NAME.session,
      status: isWedged ? "running" : sessionCompletes ? "completed" : "running",
      created_at: sessionStart,
      started_at: sessionStart,
      completed_at: sessionEnd,
      updated_at: sessionEnd ?? sessionStart,
      error: null,
      error_code: null,
      attributes: { "$eve.type": "session", "$eve.title": title, "$eve.trigger": trigger },
    });

    pushEvent(sessionId, "run_created", sessionStart);
    pushEvent(sessionId, "run_started", sessionStart);
    if (sessionEnd) pushEvent(sessionId, "run_completed", sessionEnd);

    for (const name of SESSION_STEPS) {
      steps.push({
        run_id: sessionId,
        step_id: makeId(rng, "wstp", sessionStart),
        step_name: STEP(name),
        status: "completed",
        attempt: 1,
        started_at: sessionStart,
        completed_at: new Date(sessionMs + rng.float(5, 60)),
        created_at: sessionStart,
        updated_at: sessionStart,
        error: null,
      });
    }

    // The untagged companion run. Excluded from every count by the `$eve.type` filter,
    // and a silent 2x overcount for anything that forgets it.
    const timeoutId = makeId(rng, "wrun", sessionStart);
    runs.push({
      id: timeoutId,
      name: RUN_NAME.timeout,
      status: "running",
      created_at: sessionStart,
      started_at: sessionStart,
      completed_at: null,
      updated_at: sessionStart,
      error: null,
      error_code: null,
      attributes: { $parentRunId: sessionId, $rootRunId: sessionId },
    });

    if (budgetStopped) {
      const spent = rng.float(5.2, 9.8);
      budgetStops.push({
        scope: "session",
        scope_key: sessionId,
        session_id: sessionId,
        reason: "session budget exhausted",
        limit_usd: 5,
        spent_usd: spent,
        created_at: new Date(cursor),
      });
      budgetEvents.push({
        session_id: sessionId,
        turn_id: turns.at(-1)?.turnId ?? null,
        principal_id: `user_${(s % 7) + 1}`,
        scope: "session",
        limit_usd: 5,
        spent_usd: spent,
        action: "stop",
        detail: { reason: "limit exceeded" },
        created_at: new Date(cursor),
      });
    }

    if (sessionMs >= spanFromMs) {
      emitSpans({ rng, spans, sessionId, title, turns, model });
    }
  }

  return { runs, steps, events, spans, budgetSteps, budgetEvents, budgetStops };
}

/**
 * Spans, in the vocabulary an exporting deployment actually emits.
 *
 * This reproduces the broken attribution shape on purpose, and that is the single most
 * important thing in this file. Authoring `agent/instrumentation.ts` (required to export
 * anywhere) disables eve's local `agent.*` tracer, so a real exporting install only ever
 * emits `gen_ai.*` and `ai.settings.context.eve.*`. Within that:
 *
 *   `step N` and `invoke_agent <model>`   carry the session and turn ids
 *   `chat <model>` and `execute_tool <x>` carry NOTHING and hang beneath them
 *
 * Verified across every parent/child pair in the live database, no exceptions. Tagging
 * the children here would be "helpful" and would destroy the value of the fixture: the
 * W1 attribution work has to inherit ids down the trace tree, and this is the only thing
 * that can prove it did.
 */
function emitSpans({ rng, spans, sessionId, title, turns, model }) {
  for (const turn of turns) {
    const traceId = hex(rng, 16);
    const startNs = BigInt(turn.turnStart.getTime()) * 1_000_000n;
    const durNs = BigInt(Math.round(turn.durationMs)) * 1_000_000n;

    const push = (name, parent, offsetNs, lengthNs, attributes, failed = false) => {
      const spanId = hex(rng, 8);
      spans.push({
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parent,
        name,
        kind: 1,
        start_unix_nano: (startNs + offsetNs).toString(),
        end_unix_nano: (startNs + offsetNs + lengthNs).toString(),
        start_time: new Date(Number((startNs + offsetNs) / 1_000_000n)),
        end_time: new Date(Number((startNs + offsetNs + lengthNs) / 1_000_000n)),
        status_code: failed ? 2 : 1,
        status_message: failed ? "provider overloaded" : null,
        attributes,
        events: [],
      });
      return spanId;
    };

    // Root: the turn. Carries the ids, in the AI SDK's namespace.
    const identity = {
      "ai.settings.context.eve.session.id": sessionId,
      "ai.settings.context.eve.turn.id": turn.turnId,
    };

    // eve's own root turn span (dist/src/harness/tool-loop.js) sets exactly these
    // three, plus an optional ai.telemetry.functionId. Note `eve.session.id`, which is
    // a different key from the AI SDK's `ai.settings.context.eve.session.id` — both
    // appear on a real trace and neither is a rename of the other.
    const root = push("ai.eve.turn", null, 0n, durNs, {
      ...identity,
      "eve.session.id": sessionId,
      "eve.version": EVE_VERSION,
      "eve.environment": "development",
    });

    const agentSpan = push(
      `invoke_agent ${model.id.split("/")[1]}`,
      root,
      1_000_000n,
      durNs - 2_000_000n,
      {
        ...identity,
        "gen_ai.provider.name": model.provider,
        "gen_ai.request.model": model.id.split("/")[1],
        "gen_ai.agent.name": model.id.split("/")[1],
      },
    );

    const stepSpan = push(`step 1`, agentSpan, 2_000_000n, durNs - 4_000_000n, identity);

    // The model call. NO identity attributes — this is the whole point.
    if (!turn.noModelCall) {
      const chatNs = BigInt(Math.round(turn.durationMs * 0.62)) * 1_000_000n;
      const ttft = turn.durationMs * rng.float(0.25, 0.7);
      push(
        `chat ${model.id.split("/")[1]}`,
        stepSpan,
        3_000_000n,
        chatNs,
        {
          // No `operation.name` here. A real chat span does carry one — the value
          // `gen_ai.client` was observed on a live span — but the AI SDK builds it as
          // `${operationId}${functionId}`, so it exists as a literal nowhere in eve's
          // dist and contract 14 cannot verify it. Nothing reads it, so the fixture
          // omits what it cannot prove rather than asserting a value from memory.
          "gen_ai.provider.name": model.provider,
          "gen_ai.request.model": model.id.split("/")[1],
          "gen_ai.response.id": `aitxt-${hex(rng, 8)}`,
          "gen_ai.usage.input_tokens": turn.inputTokens,
          "gen_ai.usage.output_tokens": turn.outputTokens,
          "gen_ai.response.finish_reasons": [turn.errored ? "error" : "stop"],
          // Seconds, floats — the units the real exporter uses.
          "gen_ai.client.operation.duration": turn.durationMs / 1000,
          "gen_ai.client.operation.time_to_first_chunk": ttft / 1000,
          "gen_ai.client.operation.time_per_output_chunk":
            turn.outputTokens > 0 ? turn.durationMs / 1000 / turn.outputTokens : 0,
        },
        turn.errored,
      );
    }

    // Tool calls. Also no identity attributes.
    for (let i = 0; i < turn.toolCalls; i += 1) {
      const tool = rng.pick(TOOLS);
      const toolMs = rng.float(tool.ms[0], tool.ms[1]);
      const failed = rng.chance(tool.failRate);
      push(
        `execute_tool ${tool.name}`,
        stepSpan,
        BigInt(Math.round(turn.durationMs * 0.65 + i * toolMs)) * 1_000_000n,
        BigInt(Math.round(toolMs)) * 1_000_000n,
        {
          "gen_ai.tool.name": tool.name,
          "gen_ai.tool.type": "function",
          // The key is `gen_ai.execute_tool.duration`. An earlier draft of this file
          // wrote `gen_ai.client.operation.execute_tool.duration` by pattern-matching
          // the model-call keys, which is not a name the AI SDK emits — every one of
          // the literals above is checked against eve's dist by
          // contract/contracts/14-telemetry.contract.mjs, which is how that was caught.
          "gen_ai.execute_tool.duration": toolMs / 1000,
        },
        failed,
      );
    }

    // Engine noise, at something close to the real ratio. Each one is its own
    // single-span trace carrying the all-zero placeholder run id — which is why a real
    // spans table is 92% "attributable" rows that join to nothing at all.
    const noise = rng.int(40, 120);
    for (let i = 0; i < noise; i += 1) {
      const noiseTrace = hex(rng, 16);
      const at = startNs + BigInt(Math.round(rng.float(0, turn.durationMs))) * 1_000_000n;
      spans.push({
        trace_id: noiseTrace,
        span_id: hex(rng, 8),
        parent_span_id: null,
        name: "workflow.stream.read.complete",
        kind: 1,
        start_unix_nano: at.toString(),
        end_unix_nano: (at + 5_000_000n).toString(),
        start_time: new Date(Number(at / 1_000_000n)),
        end_time: new Date(Number((at + 5_000_000n) / 1_000_000n)),
        status_code: 1,
        status_message: null,
        attributes: {
          "operation.name": "workflow.client",
          "workflow.run.id": PLACEHOLDER_RUN_ID,
          "workflow.stream.name": `strm_${PLACEHOLDER_RUN_ID.slice(5)}_user`,
          "workflow.stream.operation": "read_complete",
          "workflow.stream.read.bytes": rng.int(0, 4096),
          "workflow.stream.read.chunks": rng.int(0, 40),
          "workflow.stream.read.total_ms": rng.int(1, 25),
          "workflow.stream.read.reconnects": 0,
        },
        events: [],
      });
    }
  }
}

// --- Emitting SQL ------------------------------------------------------------

const SEED_DEPLOYMENT = "evestack-seed";

/**
 * Escape one value for COPY's text format.
 *
 * The rules are small and unforgiving: backslash is the escape character, tab is the
 * column separator, newline ends the row, and \N (a literal backslash-N, not the string
 * "NULL") is how you say NULL. Getting any of these wrong does not error — it silently
 * shifts every subsequent column by one, which is the worst possible failure for a
 * fixture whose whole job is to be trusted.
 */
export function copyValue(value) {
  if (value === null || value === undefined) return "\\N";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "t" : "f";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function copyBlock(out, table, columns, rows) {
  if (rows.length === 0) return;
  out.push(`COPY ${table} (${columns.join(", ")}) FROM STDIN;`);
  for (const row of rows) out.push(columns.map((c) => copyValue(row[c])).join("\t"));
  out.push("\\.");
  out.push("");
}

/**
 * Delete exactly what a previous run of this script wrote, and nothing else.
 *
 * Runs are found by their deployment stamp; children are found by their run id; spans
 * are found by the resource service.name the generator sets. Ordering matters only
 * because the child deletes read the run ids, so they have to happen first.
 */
function purgeStatements() {
  return [
    `CREATE SCHEMA IF NOT EXISTS evestack;`,
    ``,
    `CREATE TEMP TABLE _seeded_runs ON COMMIT DROP AS`,
    `  SELECT id FROM workflow.workflow_runs WHERE deployment_id = '${SEED_DEPLOYMENT}';`,
    ``,
    `DELETE FROM workflow.workflow_events WHERE run_id IN (SELECT id FROM _seeded_runs);`,
    `DELETE FROM workflow.workflow_steps  WHERE run_id IN (SELECT id FROM _seeded_runs);`,
    `DELETE FROM evestack.budget_steps    WHERE session_id IN (SELECT id FROM _seeded_runs);`,
    `DELETE FROM evestack.budget_events   WHERE session_id IN (SELECT id FROM _seeded_runs);`,
    `DELETE FROM evestack.budget_stops    WHERE session_id IN (SELECT id FROM _seeded_runs);`,
    `DELETE FROM evestack.spans WHERE resource->>'service.name' = '${SPAN_RESOURCE["service.name"]}';`,
    `DELETE FROM workflow.workflow_runs WHERE deployment_id = '${SEED_DEPLOYMENT}';`,
    ``,
  ];
}

/**
 * A guard that runs inside the transaction, so it can see the database this is actually
 * being piped into. The script cannot inspect the target itself — it never connects —
 * so the check has to travel with the data. A DO block that RAISEs aborts the whole
 * transaction, which means a refused seed leaves nothing behind.
 */
function guardStatement() {
  return [
    `DO $seedguard$`,
    `DECLARE foreign_runs int;`,
    `BEGIN`,
    `  SELECT count(*) INTO foreign_runs FROM workflow.workflow_runs`,
    `   WHERE deployment_id <> '${SEED_DEPLOYMENT}';`,
    `  IF foreign_runs > 0 THEN`,
    `    RAISE EXCEPTION 'Refusing to seed: % run(s) here were not created by scripts/seed.mjs.`,
    `That looks like a real agent history, and seeding over it would make every number meaningless.`,
    `Re-run with --force, or point psql at a scratch database.', foreign_runs;`,
    `  END IF;`,
    `END`,
    `$seedguard$;`,
    ``,
  ];
}

export function parseArgs(argv) {
  const opts = {
    days: 30,
    spanDays: 7,
    sessions: 700,
    seed: 1,
    now: null,
    purge: false,
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--days") (opts.days = Number(value)), (i += 1);
    else if (arg === "--span-days") (opts.spanDays = Number(value)), (i += 1);
    else if (arg === "--sessions") (opts.sessions = Number(value)), (i += 1);
    else if (arg === "--seed") (opts.seed = Number(value)), (i += 1);
    else if (arg === "--now") (opts.now = new Date(value)), (i += 1);
    else if (arg === "--purge") opts.purge = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
  }
  // A fixed default, so two runs an hour apart still produce the same relative shape.
  if (!opts.now) opts.now = new Date("2026-08-06T12:00:00Z");
  return opts;
}

const USAGE = `Dev-only seeder for the evestack dashboard. Emits SQL on stdout.

  node scripts/seed.mjs | psql "$WORKFLOW_POSTGRES_URL"
  node scripts/seed.mjs --purge | psql "$WORKFLOW_POSTGRES_URL"

  --days N        window to spread runs over          (default 30)
  --span-days N   trailing days that also get spans   (default 7)
  --sessions N    sessions to generate                (default 700)
  --seed N        PRNG seed; same seed, same data     (default 1)
  --now ISO       anchor the window                   (default 2026-08-06T12:00:00Z)
  --force         seed even if unseeded runs exist
  --purge         emit only the cleanup statements

Every run it writes carries deployment_id = '${SEED_DEPLOYMENT}', which is how --purge
finds them again. Spans are matched on resource->>'service.name'.`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const out = ["BEGIN;", ""];

  if (opts.purge) {
    out.push(...purgeStatements(), "COMMIT;", "");
    process.stdout.write(out.join("\n"));
    return;
  }

  if (!opts.force) out.push(...guardStatement());
  // Idempotent: clear our own previous output first, so re-running replaces it.
  out.push(...purgeStatements());

  const data = generate(opts);

  copyBlock(
    out,
    "workflow.workflow_runs",
    [
      "id",
      "name",
      "status",
      "deployment_id",
      "created_at",
      "started_at",
      "completed_at",
      "updated_at",
      "error",
      "error_code",
      "attributes",
    ],
    data.runs.map((r) => ({
      ...r,
      deployment_id: SEED_DEPLOYMENT,
      attributes: JSON.stringify(r.attributes),
    })),
  );

  copyBlock(
    out,
    "workflow.workflow_steps",
    [
      "run_id",
      "step_id",
      "step_name",
      "status",
      "attempt",
      "started_at",
      "completed_at",
      "created_at",
      "updated_at",
      "error",
    ],
    data.steps,
  );

  copyBlock(
    out,
    "workflow.workflow_events",
    ["id", "type", "run_id", "created_at", "payload"],
    data.events.map((e) => ({ ...e, payload: e.payload ? JSON.stringify(e.payload) : null })),
  );

  copyBlock(
    out,
    "evestack.spans",
    [
      "trace_id",
      "span_id",
      "parent_span_id",
      "name",
      "kind",
      "start_unix_nano",
      "end_unix_nano",
      "start_time",
      "end_time",
      "status_code",
      "status_message",
      "attributes",
      "resource",
      "events",
    ],
    data.spans.map((s) => ({
      ...s,
      attributes: JSON.stringify(s.attributes),
      resource: JSON.stringify(SPAN_RESOURCE),
      events: JSON.stringify(s.events),
    })),
  );

  copyBlock(
    out,
    "evestack.budget_steps",
    [
      "session_id",
      "turn_id",
      "step_index",
      "sequence",
      "principal_id",
      "day",
      "model",
      "cost_usd",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "priced",
      "created_at",
    ],
    data.budgetSteps.map((b) => ({
      ...b,
      day: b.day.toISOString().slice(0, 10),
      cost_usd: b.cost_usd.toFixed(8),
    })),
  );

  copyBlock(
    out,
    "evestack.budget_events",
    [
      "session_id",
      "turn_id",
      "principal_id",
      "scope",
      "limit_usd",
      "spent_usd",
      "action",
      "detail",
      "created_at",
    ],
    data.budgetEvents.map((e) => ({ ...e, detail: JSON.stringify(e.detail) })),
  );

  copyBlock(
    out,
    "evestack.budget_stops",
    ["scope", "scope_key", "session_id", "reason", "limit_usd", "spent_usd", "created_at"],
    data.budgetStops,
  );

  out.push("COMMIT;", "");

  // Progress goes to stderr so it cannot corrupt the SQL on stdout.
  process.stderr.write(
    `seed: ${data.runs.length} runs, ${data.steps.length} steps, ` +
      `${data.events.length} events, ${data.spans.length} spans, ` +
      `${data.budgetSteps.length} budget steps\n`,
  );

  process.stdout.write(out.join("\n"));
}

// Only run when invoked directly, so tests can import the generator without emitting SQL.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
