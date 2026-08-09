/**
 * Being told, rather than having to look.
 *
 * `lib/monitors.ts` already draws latency and failure rates. This is the other
 * half: a threshold, an evaluation, and a state. A chart tells you something is
 * wrong once you are looking at it, which is the wrong time.
 *
 * ── Defaults, not a builder ──────────────────────────────────────────────────
 *
 * There is no UI here for composing a monitor, and that is the design rather
 * than the backlog. Vercel shipped a dashboard builder as Monitoring, then
 * sunset it in November 2025 and folded the same data into curated insight
 * sections — the lesson being that an empty canvas asks every operator to
 * rediscover what is worth watching, and most never do. Datadog's Agent
 * Observability makes the same bet from the other side with zero-configuration
 * anomaly detection.
 *
 * So the set below ships ON, tuned, and named. Every one of these corresponds
 * to a failure this codebase has actually documented or hit:
 *
 *   wedged                a turn started and never finished; nothing retries it
 *   turn_failure_rate     error_code plus finished-with-no-model-call
 *   turn_latency_p95      the number worth alerting on, not session duration
 *   daily_spend           against EVESTACK_ALERT_DAILY_SPEND_USD, falling back
 *                         to @evestack/budget's own daily cap
 *   unpriced_spend        a model with no catalog price is running and the
 *                         real bill is unknown, which reads as $0.00 anywhere
 *                         that forgets to check `priced`
 *   no_spans_while_active turns are running and no spans have arrived. The
 *                         ingest path fails SILENTLY on a bad token — the 401
 *                         goes to the agent's exporter, not to anyone's screen
 *                         (docs/observability.mdx) — so the only symptom is a
 *                         trace tier that stays empty while work happens
 *   sandbox_networked     a sandbox not on NetworkMode=none
 *   sandbox_long_lived    a sandbox up past the hour, with no idle timeout
 *   schedule_failing      a schedule with a failing streak
 *
 * The last four cannot exist in a hosted product: three of them need the
 * machine, and the ingest one needs to know that the collector is ours.
 *
 * ── A monitor that cannot be evaluated is not OK ─────────────────────────────
 *
 * Every check returns one of `ok`, `firing`, `unknown`. `unknown` is not a
 * failure state and not a passing one: the Docker socket being unmounted, or
 * the budget being unset, means the question was not asked. Collapsing that
 * into `ok` is how a dashboard reports all-clear for something it never looked
 * at, which is the single most dangerous thing an alerting page can do.
 */

import { dailySpendCap } from "./budget-env";
import { query } from "./db";
import { getMonitorSummary } from "./monitors";
import { getSchedules } from "./schedules";
import { concerns, listSandboxes } from "./sandboxes";

export type AlertState = "ok" | "firing" | "unknown";
export type Severity = "page" | "warn" | "info";

export interface AlertResult {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly state: AlertState;
  /** One sentence, always present, saying what was measured and what it was. */
  readonly detail: string;
  /** Where to go to act on it. */
  readonly href?: string;
  /** What would have to be true for this to stop firing. */
  readonly threshold?: string;
}

const WINDOW_HOURS = 24;

/** Defaults chosen to be quiet on a healthy install and loud on a broken one. */
export const THRESHOLDS = {
  failureRate: 0.1,
  latencyP95Ms: 60_000,
  wedgedSessions: 1,
  sandboxLongLivedHours: 1,
  scheduleFailingStreak: 3,
} as const;

/**
 * The cap "Spend today" is judged against, and which cap it is.
 *
 * This used to read `EVESTACK_DAILY_BUDGET_USD`, which is not a variable. The
 * real one is `EVESTACK_BUDGET_DAILY_USD` — the same four words in a different
 * order — and the transposition existed only inside this file, so nothing else
 * in the repository contradicted it. The result was not a wrong number; it was
 * this monitor reporting `unknown` on every install ever made, saying "no cap is
 * configured" while @evestack/budget enforced its $10/day default a process
 * away. lib/budget-env.ts carries the full write-up.
 */
function budgetUsd(): { usd: number | null; scope: "install" | "per-principal" } {
  return dailySpendCap(process.env);
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Everything the alert list needs.
 *
 * `Promise.allSettled` rather than `all`: a monitor whose data source is down
 * must report `unknown` rather than taking the other eight with it. That is the
 * same reasoning as the state itself — a page that shows nothing because one
 * check threw is a page that hides the seven that were fine and the one that
 * was firing.
 */
export async function evaluateAlerts(): Promise<AlertResult[]> {
  const [summary, spend, ingest, sandboxes, schedules] = await Promise.allSettled([
    getMonitorSummary(WINDOW_HOURS),
    dailySpend(),
    ingestHealth(),
    listSandboxes(),
    failingSchedules(),
  ]);

  const out: AlertResult[] = [];

  /* ── turn health ─────────────────────────────────────────────────────────── */
  if (summary.status === "fulfilled") {
    const s = summary.value;
    const rate = s.turns.failureRate;
    out.push({
      id: "turn_failure_rate",
      title: "Turn failure rate",
      severity: "page",
      state: s.turns.total === 0 ? "unknown" : rate > THRESHOLDS.failureRate ? "firing" : "ok",
      detail:
        s.turns.total === 0
          ? `No turns in the last ${WINDOW_HOURS}h, so there is no rate to judge.`
          : `${pct(rate)} of ${s.turns.total.toLocaleString("en-US")} turns failed — ${s.turns.errored} carried an error code and ${s.turns.noModelCall} finished without ever reaching a model.`,
      threshold: `at or under ${pct(THRESHOLDS.failureRate)}`,
      href: "/monitors",
    });

    const p95 = s.turnLatencyMs?.p95 ?? null;
    out.push({
      id: "turn_latency_p95",
      title: "p95 turn latency",
      severity: "warn",
      state: p95 === null ? "unknown" : p95 > THRESHOLDS.latencyP95Ms ? "firing" : "ok",
      detail:
        p95 === null
          ? `Nothing finished in the last ${WINDOW_HOURS}h, so there is no latency to measure.`
          : `p95 is ${(p95 / 1000).toFixed(1)}s over ${s.turnLatencyMs?.count.toLocaleString("en-US")} finished turns. Session duration is deliberately not used here — eve leaves a session running while a human keeps the tab open.`,
      threshold: `at or under ${THRESHOLDS.latencyP95Ms / 1000}s`,
      href: "/monitors",
    });
  } else {
    out.push(unknownFrom("turn_failure_rate", "Turn failure rate", "page", summary.reason));
    out.push(unknownFrom("turn_latency_p95", "p95 turn latency", "warn", summary.reason));
  }

  /* ── wedged ──────────────────────────────────────────────────────────────── */
  out.push(await wedged());

  /* ── money ───────────────────────────────────────────────────────────────── */
  if (spend.status === "fulfilled") {
    const { usd: cap, scope } = budgetUsd();
    const { total, unpriced, unpricedTurns } = spend.value;
    // Which cap this is, said out loud. `dailySpend()` sums every priced turn on
    // the INSTALL, and the fallback cap is per PRINCIPAL — the same number on a
    // single-user install and a different one the moment there are two. Naming
    // the scope is what stops that difference from being a silent wrong answer.
    const scopeNote =
      scope === "per-principal"
        ? " That is @evestack/budget's per-principal daily cap, compared here against the whole install's spend — set EVESTACK_ALERT_DAILY_SPEND_USD to judge the install against its own number."
        : "";
    out.push({
      id: "daily_spend",
      title: "Spend today",
      severity: "warn",
      state: cap === null ? "unknown" : total > cap ? "firing" : "ok",
      detail:
        cap === null
          ? // Which one is off, not "both". `dailySpendCap` returns null from two
            // different places — the operator set EVESTACK_ALERT_DAILY_SPEND_USD
            // to `false`, or budgets are disabled entirely — and telling someone
            // who deliberately switched off spend alerting that their budget cap
            // is also gone would send them to check a setting that is fine.
            scope === "install"
            ? `${usd(total)} so far today. Spend alerting is switched off with EVESTACK_ALERT_DAILY_SPEND_USD=false, so there is nothing to compare it to.`
            : `${usd(total)} so far today. @evestack/budget has no daily cap — either EVESTACK_BUDGET_DAILY_USD=false or budgets are disabled — and EVESTACK_ALERT_DAILY_SPEND_USD is unset, so there is nothing to compare it to.`
          : `${usd(total)} of ${usd(cap)} spent today.${scopeNote}`,
      threshold:
        cap === null ? "set EVESTACK_ALERT_DAILY_SPEND_USD to enable" : `under ${usd(cap)}/day`,
      href: "/",
    });

    out.push({
      id: "unpriced_spend",
      title: "Unpriced models running",
      severity: "info",
      // Not a cost threshold: ANY unpriced traffic means the real bill is
      // unknown, and every surface that forgets to read `priced` renders it as
      // $0.00. One turn is enough to make the spend figure wrong.
      state: unpricedTurns > 0 ? "firing" : "ok",
      detail:
        unpricedTurns > 0
          ? `${unpricedTurns.toLocaleString("en-US")} turn${unpricedTurns === 1 ? "" : "s"} today ran a model with no catalog price (${unpriced.join(", ")}). Their real cost is unknown, not zero — the ${usd(total)} above excludes them entirely.`
          : "Every model that ran today has a catalog price, so today's spend figure is complete.",
      threshold: "every model priced",
      href: "/",
    });
  } else {
    out.push(unknownFrom("daily_spend", "Spend today", "warn", spend.reason));
    out.push(unknownFrom("unpriced_spend", "Unpriced models running", "info", spend.reason));
  }

  /* ── the ingest path, which fails silently ───────────────────────────────── */
  if (ingest.status === "fulfilled") {
    const { activeTurns, spansLastHour } = ingest.value;
    const broken = activeTurns > 0 && spansLastHour === 0;
    out.push({
      id: "no_spans_while_active",
      title: "Trace ingest",
      severity: "warn",
      state: activeTurns === 0 ? "unknown" : broken ? "firing" : "ok",
      detail:
        activeTurns === 0
          ? "No turns ran in the last hour, so an empty trace tier says nothing either way."
          : broken
            ? `${activeTurns} turn${activeTurns === 1 ? "" : "s"} ran in the last hour and no spans arrived. A bad ingest token fails with a 401 the agent's exporter swallows, so this is usually the only visible symptom.`
            : `${spansLastHour.toLocaleString("en-US")} spans arrived in the last hour across ${activeTurns} turn${activeTurns === 1 ? "" : "s"}.`,
      threshold: "spans arriving while turns run",
      href: "/traces",
    });
  } else {
    out.push(unknownFrom("no_spans_while_active", "Trace ingest", "warn", ingest.reason));
  }

  /* ── the machine ─────────────────────────────────────────────────────────── */
  if (sandboxes.status === "fulfilled" && sandboxes.value.kind === "ok") {
    const boxes = sandboxes.value.sandboxes;
    const flags = concerns(boxes, new Set(boxes.map((b) => b.sessionId ?? "")));
    const networked = flags.filter((f) => f.kind === "networked");
    const long = flags.filter((f) => f.kind === "orphaned");

    out.push({
      id: "sandbox_networked",
      title: "Sandbox network isolation",
      severity: "page",
      state: networked.length > 0 ? "firing" : "ok",
      detail:
        networked.length > 0
          ? `${networked.length} running sandbox${networked.length === 1 ? " is" : "es are"} not on NetworkMode=none (${networked.map((f) => f.sandbox.name).join(", ")}), so code inside can reach the network.`
          : `All ${boxes.filter((b) => b.state === "running").length} running sandboxes are network-isolated.`,
      threshold: "every sandbox on `none`",
      href: "/sandboxes",
    });

    out.push({
      id: "sandbox_long_lived",
      title: "Long-lived sandboxes",
      severity: "info",
      state: long.length > 0 ? "firing" : "ok",
      detail:
        long.length > 0
          ? `${long.length} sandbox${long.length === 1 ? " has" : "es have"} been up over ${THRESHOLDS.sandboxLongLivedHours}h. eve keeps one container per session and applies no idle timeout, so they accumulate until something stops them.`
          : "No sandbox has been up longer than an hour.",
      threshold: `under ${THRESHOLDS.sandboxLongLivedHours}h`,
      href: "/sandboxes",
    });
  } else {
    const why =
      sandboxes.status === "fulfilled" && sandboxes.value.kind === "disabled"
        ? "EVESTACK_DOCKER_SOCKET is not set, so the containers on this machine were never looked at."
        : sandboxes.status === "fulfilled" && sandboxes.value.kind === "unreachable"
          ? `Docker did not answer: ${sandboxes.value.reason}`
          : String(sandboxes.status === "rejected" ? sandboxes.reason : "unavailable");
    for (const [id, title] of [
      ["sandbox_networked", "Sandbox network isolation"],
      ["sandbox_long_lived", "Long-lived sandboxes"],
    ] as const) {
      out.push({ id, title, severity: id === "sandbox_networked" ? "page" : "info", state: "unknown", detail: why, href: "/sandboxes" });
    }
  }

  /* ── schedules ───────────────────────────────────────────────────────────── */
  if (schedules.status === "fulfilled") {
    const failing = schedules.value;
    out.push({
      id: "schedule_failing",
      title: "Failing schedules",
      severity: "warn",
      state: failing.length > 0 ? "firing" : "ok",
      detail:
        failing.length > 0
          ? `${failing.map((f) => `${f.name} (${f.streak} in a row)`).join(", ")}.`
          : "No schedule has a failing streak.",
      threshold: `under ${THRESHOLDS.scheduleFailingStreak} consecutive failures`,
      href: "/schedules",
    });
  } else {
    out.push(unknownFrom("schedule_failing", "Failing schedules", "warn", schedules.reason));
  }

  return rankAlerts(out);
}

/**
 * Firing first, then unknown, then ok; within a state, by severity.
 *
 * `unknown` above `ok` is the editorial claim of this whole module, so it is a
 * pure exported function rather than a comparator buried in a closure: "we did
 * not look" deserves more of a reader's attention than "we looked and it was
 * fine", and sorting it below `ok` would bury every un-mounted socket and
 * un-set budget under a list of passes.
 */
export function rankAlerts(alerts: readonly AlertResult[]): AlertResult[] {
  const stateRank: Record<AlertState, number> = { firing: 0, unknown: 1, ok: 2 };
  const sevRank: Record<Severity, number> = { page: 0, warn: 1, info: 2 };
  return [...alerts].sort(
    (a, b) => stateRank[a.state] - stateRank[b.state] || sevRank[a.severity] - sevRank[b.severity],
  );
}

function unknownFrom(id: string, title: string, severity: Severity, reason: unknown): AlertResult {
  return {
    id,
    title,
    severity,
    state: "unknown",
    detail: `Could not be evaluated: ${reason instanceof Error ? reason.message : String(reason)}`,
  };
}

/* -------------------------------------------------------------------------- */

async function wedged(): Promise<AlertResult> {
  try {
    const [row] = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM workflow.workflow_runs
        WHERE attributes->>'$eve.type' IN ('turn','subagent')
          AND completed_at IS NULL
          AND started_at IS NOT NULL
          -- (now() AT TIME ZONE 'utc'), never a bare now(). workflow_runs
          -- timestamps are 'timestamp without time zone' holding UTC (checked
          -- against the running database, not assumed), and comparing one to a
          -- timestamptz makes Postgres read the stored value in the SERVER's
          -- zone. In America/New_York that is a four-hour shift and it points
          -- the wrong way: a turn started twenty minutes ago reads as starting
          -- three hours and forty minutes in the FUTURE, so the comparison
          -- below against a bare now() is false and this alert could never fire.
          --
          -- No backticks in here, ever: this is a template literal, and one
          -- inside the SQL ends the string with a parse error nowhere near the
          -- cause. lib/fleet.ts warns about it in the sibling query; that
          -- warning was written because someone did it, and it has now caught
          -- two more attempts in this file and in the CLI's port.
          --
          -- Not hypothetical, and not exotic: ci.yml runs the whole suite with
          -- TZ=America/New_York precisely to catch this class, and lib/fleet.ts
          -- carries the same conversion because "the CLI port of this file hit
          -- it for real: a session quiet for three hours looked five hours in
          -- the future and the sweep returned nothing".
          AND started_at < (now() AT TIME ZONE 'utc') - interval '15 minutes'`,
    );
    const n = Number(row?.n ?? 0);
    return {
      id: "wedged",
      title: "Wedged turns",
      severity: "page",
      state: n >= THRESHOLDS.wedgedSessions ? "firing" : "ok",
      detail:
        n > 0
          ? `${n} turn${n === 1 ? "" : "s"} started over 15 minutes ago and never finished. Nothing in eve notices or retries these.`
          : "Every turn that started has finished or is still within its first 15 minutes.",
      threshold: "none stalled past 15 minutes",
      href: "/sessions?outcome=wedged",
    };
  } catch (error) {
    return unknownFrom("wedged", "Wedged turns", "page", error);
  }
}

async function dailySpend(): Promise<{ total: number; unpriced: string[]; unpricedTurns: number }> {
  const rows = await query<{ model: string | null; priced: boolean; cost: string | null; n: string }>(
    `SELECT model, priced, sum(cost_usd)::text AS cost, count(*)::text AS n
       FROM evestack.fact_turn
      WHERE created_at >= date_trunc('day', now())
      GROUP BY model, priced`,
  );
  let total = 0;
  const unpriced: string[] = [];
  let unpricedTurns = 0;
  for (const r of rows) {
    if (r.priced) total += Number(r.cost ?? 0);
    else {
      unpricedTurns += Number(r.n ?? 0);
      if (r.model !== null && !unpriced.includes(r.model)) unpriced.push(r.model);
    }
  }
  return { total, unpriced, unpricedTurns };
}

async function ingestHealth(): Promise<{ activeTurns: number; spansLastHour: number }> {
  const [turns] = await query<{ n: string }>(
    // (now() AT TIME ZONE 'utc') — see the wedged() query above for why.
    // workflow_runs.created_at is naive UTC; this one shifts the other way and
    // over-counts, so the "turns ran but no spans arrived" comparison is made
    // against a turn count from the wrong window.
    //
    // The span half below is deliberately NOT converted: evestack.spans is our
    // table and received_at is `timestamp with time zone`, so a bare now() is
    // already correct there. Converting both because they sit next to each
    // other would introduce the bug into the half that never had it.
    `SELECT count(*)::text AS n FROM workflow.workflow_runs
      WHERE attributes->>'$eve.type' IN ('turn','subagent')
        AND created_at >= (now() AT TIME ZONE 'utc') - interval '1 hour'`,
  );
  let spansLastHour = 0;
  try {
    const [spans] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM evestack.spans WHERE received_at >= now() - interval '1 hour'`,
    );
    spansLastHour = Number(spans?.n ?? 0);
  } catch {
    // The spans table is created lazily on first ingest. Not existing is the
    // strongest possible evidence that nothing has ever been exported, which is
    // exactly what this check is about — so it counts as zero, not as an error.
    spansLastHour = 0;
  }
  return { activeTurns: Number(turns?.n ?? 0), spansLastHour };
}

async function failingSchedules(): Promise<{ name: string; streak: number }[]> {
  /*
   * `getSchedules()` already computes this, correctly, from
   * `evestack.schedule_runs` — the table @evestack/schedules actually writes.
   *
   * The first version of this function invented its own query against a run
   * attribute named for schedules, which eve does not write. Contract 06
   * derives the `$eve.*` names evestack reads and asserts each one appears in
   * eve's dist, and it caught this by finding that literal here and failing to
   * find it upstream. The attribute exists nowhere, so the monitor
   * matched zero rows and reported "no schedule has a failing streak" on every
   * install forever. A monitor that cannot fire is worse than a missing one,
   * because the page counts it among the checks that passed.
   *
   * It is also the exact defect this module's own header warns about, written
   * into the module by the same commit as the warning.
   */
  const { schedules, tableExists } = await getSchedules();
  if (!tableExists) throw new Error("no schedule has ever run on this install");
  return schedules
    .filter((x) => x.failingStreak >= THRESHOLDS.scheduleFailingStreak)
    .map((x) => ({ name: x.name, streak: x.failingStreak }));
}
