import { Suspense } from "react";

import { DatabaseError } from "@/app/db-error";
import { FleetBanner } from "@/app/fleet-banner";
import { Live } from "@/app/live";
import {
  loadOverview,
  makeWindow,
  OVERVIEW_WINDOWS,
  windowLabel,
  type Headline,
} from "@/app/overview";
import { QueryValue, QueryValueRow } from "@/components/charts/query-value";
import { TimeSeriesChart } from "@/components/charts/time-series";
import { TopList } from "@/components/charts/top-list";
import { CONTROL, FOCUS_RING } from "@/components/ui/style";

export const dynamic = "force-dynamic";

/**
 * The front door: a monitor, not a list.
 *
 * `/` used to be the sessions table, which answered "what has run" and left
 * "is anything wrong right now" to be worked out by reading it. The list moved
 * to /sessions in the same wave that built this; there is one list, and it is
 * there.
 *
 * ── Every number carries its coverage ────────────────────────────────────────
 *
 * The tiles are not decoration over a single query — each is a measure, the
 * same measure over the preceding window, and a bucketed trend, and each one
 * says what it was computed over. That last part is the difference between a
 * dashboard and a wall of confident numbers. On the seeded month p95 TTFT comes
 * from 359 of 1,922 turns because spans are opt-in, and spend from 1,651
 * because 209 turns ran an unpriced model and 62 never called one. A reader who
 * cannot see those denominators is being told something false about all three.
 *
 * ── Why `better` differs per tile ────────────────────────────────────────────
 *
 * A delta is meaningless without a direction. More runs is usually good, more
 * spend usually is not, and higher latency never is. `QueryValue` colours the
 * arrow from `better`, and a tile that omitted it would render "+38%" in the
 * same green whether that was throughput or a bill.
 *
 * ── The one thing that is not from Postgres ──────────────────────────────────
 *
 * `FleetBanner` talks to the live agent, and it is behind a Suspense boundary
 * for the reason app/sessions/page.tsx spells out: before that boundary existed
 * the sessions page took 15.2 seconds because each probe ran to its timeout
 * against an agent that had never heard of the session. Everything else here is
 * SQL and paints immediately.
 */

const DEFAULT_WINDOW = 24;

function readWindow(raw: string | undefined): number {
  const asked = Number(raw);
  return (OVERVIEW_WINDOWS as readonly number[]).includes(asked) ? asked : DEFAULT_WINDOW;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `Headline` is shaped for this; keeping the spread in one place.
 *
 * `noun` is per tile rather than global because the denominator is not always
 * turns — "359 of 1,922 turns" and "838 of 838 tool calls" are different
 * sentences, and a shared noun would make one of them wrong.
 */
function tile(h: Headline, previousLabel: string, noun = "turns") {
  return {
    value: h.value,
    previous: h.previous,
    previousLabel,
    spark: h.spark,
    coverage: { ...h.coverage, noun },
  };
}

export default async function OverviewPage(props: PageProps<"/">) {
  const params = await props.searchParams;
  const hours = readWindow(first(params.window));
  const label = windowLabel(hours);
  const window = makeWindow(hours);

  let data: Awaited<ReturnType<typeof loadOverview>>;
  try {
    data = await loadOverview(window);
  } catch (error) {
    return <DatabaseError error={error} />;
  }

  /*
   * If every tile's current-window query failed, the database is unreachable and
   * the honest answer is to say so. Without this the page renders six em dashes,
   * which reads as "your agent did nothing" — the opposite of the truth, on the
   * screen someone opens to find out whether anything is wrong. Caught live with
   * Postgres down and five real turns sitting on disk.
   */
  const blind = [data.runs, data.failureRate, data.latency, data.spend, data.tokens, data.ttft];
  if (blind.every((h) => h.failed)) {
    /*
     * The REAL rejection, not a sentence about it. This used to synthesise
     * `new Error("Every measure on this page failed to read from Postgres.")`,
     * which is true and useless: describeDbFailure() reads a pg error code to
     * tell a stopped container from a database that was never bootstrapped, and
     * a hand-written sentence carries neither. So this page said "Can't reach
     * the database" while /monitors and /evals, reading the same dead database
     * in the same second, said "The database has no agent schema yet" — the
     * message that names the step the reader actually skipped.
     *
     * Every one of them failed to reach this branch, so any reason is
     * representative; the first is taken for determinism.
     */
    const reason = blind.find((h) => h.error !== undefined)?.error;
    return (
      <>
        <h1>Overview</h1>
        <DatabaseError
          error={reason ?? new Error("Every measure on this page failed to read from Postgres.")}
        />
      </>
    );
  }

  const previousLabel = `previous ${label}`;

  return (
    <>
      <h1>Overview</h1>
      <p className="page-sub">
        Every agent run on this machine over the last {label}, read straight from your own Postgres.
        Each number says how much of the window it could actually be computed from.
      </p>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Time range" className="flex flex-wrap gap-1.5">
          {OVERVIEW_WINDOWS.map((w) => (
            <a
              key={w}
              href={w === DEFAULT_WINDOW ? "/" : `/?window=${w}`}
              aria-current={w === hours ? "page" : undefined}
              className={`${CONTROL} aria-[current=page]:border-accent aria-[current=page]:text-text`}
            >
              {windowLabel(w)}
            </a>
          ))}
        </nav>

        {/* This page is force-dynamic and used to stay on whatever it first
            rendered. app/live.tsx records why polling won over SSE and over
            `revalidate`, and why the age of the data is always on screen. */}
        <Live />
      </div>

      {/* Renders nothing when nothing is wrong. Streamed — see the header. */}
      <Suspense fallback={null}>
        <FleetBanner />
      </Suspense>

      <QueryValueRow>
        <QueryValue label="Turns" unit="count" better="higher" {...tile(data.runs, previousLabel)} />
        <QueryValue
          label="Failure rate"
          unit="percent"
          better="lower"
          {...tile(data.failureRate, previousLabel)}
        />
        <QueryValue
          label="p95 turn latency"
          unit="duration"
          better="lower"
          {...tile(data.latency, previousLabel)}
        />
        <QueryValue label="Spend" unit="cost" better="lower" {...tile(data.spend, previousLabel)} />
        <QueryValue
          label="Tokens out"
          unit="tokens"
          better="higher"
          {...tile(data.tokens, previousLabel)}
        />
        <QueryValue
          label="p95 time to first token"
          unit="duration"
          better="lower"
          {...tile(data.ttft, previousLabel)}
        />
      </QueryValueRow>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <TimeSeriesChart
          title="Turns over time"
          subtitle={`By trigger, ${label} window.`}
          series={data.runsByTrigger.series}
          unreadable={data.runsByTrigger.unreadable}
          unit="count"
          variant="stacked-area"
          xLabel="time"
          xPrecision={hours <= 24 ? "time" : "date"}
        />
        <TimeSeriesChart
          title="Spend over time"
          subtitle="By model. A model with no catalog price contributes nothing here and is listed as unpriced below."
          series={data.spendByModel.series}
          unreadable={data.spendByModel.unreadable}
          unit="cost"
          variant="stacked-area"
          xLabel="time"
          xPrecision={hours <= 24 ? "time" : "date"}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <TopList
          title="Models"
          subtitle="Ranked by spend. Sort by error rate or latency to find the one that is expensive for the wrong reason."
          rows={data.topModels.rows}
          unreadable={data.topModels.unreadable}
          unit="cost"
          valueLabel="spend"
          durationLabel="p95"
        />
        <TopList
          title="Tools"
          subtitle="Ranked by calls. A tool that is slow and frequent costs more than one that is slow and rare."
          rows={data.topTools.rows}
          unreadable={data.topTools.unreadable}
          unit="count"
          valueLabel="calls"
          durationLabel="p95"
        />
      </div>

      <p className="mt-6 text-small text-text-dim">
        Looking for a specific run?{" "}
        <a className={`text-accent hover:underline ${FOCUS_RING}`} href="/sessions">
          Every session
        </a>{" "}
        is searchable and filterable.
      </p>
    </>
  );
}
