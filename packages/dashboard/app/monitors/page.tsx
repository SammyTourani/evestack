import { DatabaseError } from "@/app/db-error";
import { Suspense } from "react";

import { AlertsPanel } from "./alerts-panel";
import { WINDOWS, getMonitorSummary, type MonitorSummary } from "@/lib/monitors";
import { clock, duration, stamp } from "@/lib/time";
import styles from "./monitors.module.css";

export const dynamic = "force-dynamic";

/**
 * Latency and failure rates over a rolling window.
 *
 * The marketing site has rendered a p50/p75/p95/p99 panel under the caption
 * "read straight from your own postgres" since launch, and until this page
 * existed the dashboard had no percentile code at all — `grep -riE 'p50|p95'`
 * over app/ and lib/ returned nothing. This is that claim, made true against
 * the same `workflow.workflow_runs` every other page reads.
 *
 * Turn latency leads because it is the number worth alerting on; session
 * duration is reported separately and only over sessions that actually ended.
 * lib/monitors.ts explains why they must not be averaged together.
 */

const pct = (fraction: number): string => `${(fraction * 100).toFixed(fraction === 0 ? 0 : 1)}%`;

function windowLabel(hours: number): string {
  if (hours < 24) return `${hours}h`;
  return hours === 24 ? "24h" : `${Math.round(hours / 24)}d`;
}

function Percentiles({ title, note, data }: {
  title: string;
  note: string;
  data: MonitorSummary["turnLatencyMs"];
}) {
  if (data === null) {
    return (
      <section className={styles.block}>
        <h2 className={styles.h2}>{title}</h2>
        <p className={styles.note}>Nothing finished in this window, so there is no distribution to report.</p>
      </section>
    );
  }
  const rows = [
    { label: "p50", value: data.p50 },
    { label: "p75", value: data.p75 },
    { label: "p95", value: data.p95 },
    { label: "p99", value: data.p99 },
    { label: "max", value: data.max },
  ];
  return (
    <section className={styles.block}>
      <h2 className={styles.h2}>{title}</h2>
      <div className="stat-row">
        {rows.map((row) => (
          <div className="stat" key={row.label}>
            <div className="stat-label">{row.label}</div>
            <div className="stat-value">{duration(row.value)}</div>
          </div>
        ))}
      </div>
      <p className={styles.note}>
        {note} Computed by Postgres with <code>percentile_cont</code> over {data.count.toLocaleString()}{" "}
        finished {data.count === 1 ? "row" : "rows"}.
      </p>
    </section>
  );
}

/**
 * Bars, not a chart library. Twelve buckets is few enough that CSS heights read
 * accurately, and a dependency here would be the only one on the page.
 */
function Series({ summary }: { summary: MonitorSummary }) {
  const peak = Math.max(1, ...summary.buckets.map((b) => b.turns));
  return (
    <section className={styles.block}>
      <h2 className={styles.h2}>Throughput and failures</h2>
      <div className={styles.chart}>
        {summary.buckets.map((bucket) => {
          const height = (bucket.turns / peak) * 100;
          const failedShare = bucket.turns === 0 ? 0 : (bucket.failed / bucket.turns) * 100;
          return (
            <div className={styles.col} key={bucket.start}>
              <div
                className={styles.bar}
                style={{ height: `${height}%` }}
                title={`${stamp(bucket.start)} — ${bucket.turns} turn${bucket.turns === 1 ? "" : "s"}, ${bucket.failed} failed${bucket.unfinished === 0 ? "" : `, ${bucket.unfinished} unfinished`}${bucket.p95Ms === null ? "" : `, p95 ${duration(bucket.p95Ms)}`}`}
              >
                <div className={styles.barFailed} style={{ height: `${failedShare}%` }} />
              </div>
              <span className={styles.tick}>{clock(bucket.start)}</span>
            </div>
          );
        })}
      </div>
      <p className={styles.note}>
        Turns per bucket, with the failed share in red. Counts, not the rate above: an unfinished
        turn is part of the bar&rsquo;s height because it is throughput, and is in the tooltip
        because it is not a success. An empty bucket is a real zero and is drawn as one — skipping
        it would redraw a quiet hour as continuous load. Tick labels are each bucket&rsquo;s start
        time in UTC.
      </p>
    </section>
  );
}

export default async function MonitorsPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>;
}) {
  const { hours: raw } = await searchParams;
  const requested = Number(raw);
  const hours = (WINDOWS as readonly number[]).includes(requested) ? requested : 24;

  let summary: MonitorSummary;
  try {
    summary = await getMonitorSummary(hours);
  } catch (error) {
    // The <h1> comes too, on this path as on every other. Returning the error
    // alone left the reader on a page that did not say which page it was — the
    // sidebar's active item was the only clue, and that is not what a heading is
    // for. The subtitle is not repeated here because it quotes the window, and
    // the window is a fact about data this branch could not read.
    return (
      <>
        <h1>Monitors</h1>
        <DatabaseError error={error} />
      </>
    );
  }

  const { turns, sessions } = summary;
  // `turns.failed`, not `errored + noModelCall`: a turn can be both, so the sum
  // reports one failure twice. Only used to decide whether to colour the rate,
  // so the old bug was invisible here — but it is the same bug lib/monitors.ts
  // carried in the rate itself, and leaving one copy behind is how it comes back.
  const failing = turns.failed;

  return (
    <>
      <h1>Monitors</h1>

      {/* Title, then subtitle, then content — the order every other page uses.
          The panel used to sit between the two, which put a card between a
          heading and the sentence explaining it. */}
      <p className="page-sub">
        Latency and failure rates over the last {windowLabel(hours)}, from the same{" "}
        <code>workflow.workflow_runs</code> the session list reads. Nothing is sampled and nothing
        is estimated.
      </p>

      {/* Streamed: the sandbox checks talk to the Docker daemon, which costs
          about two seconds for its CPU sample, and the charts below are pure
          SQL. Blocking the whole page on the slowest check is the mistake
          app/sessions/page.tsx already paid 15 seconds for. */}
      <Suspense fallback={null}>
        <AlertsPanel />
      </Suspense>

      <nav className={styles.windows} aria-label="Time window">
        {WINDOWS.map((option) => (
          <a
            key={option}
            href={`/monitors?hours=${option}`}
            className={option === hours ? styles.windowOn : styles.window}
            aria-current={option === hours ? "page" : undefined}
          >
            {windowLabel(option)}
          </a>
        ))}
      </nav>

      {turns.total === 0 ? (
        <div className="empty">
          <h2>No turns in the last {windowLabel(hours)}</h2>
          <p>
            Send the agent a message, or widen the window above. Monitors read the same rows as the
            session list, so if that page has sessions this one will fill on the next turn.
          </p>
        </div>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-label">Turns</div>
              <div className="stat-value">{turns.total.toLocaleString()}</div>
            </div>
            <div className="stat">
              {/* The denominator is named in the label, not buried in a
                  footnote: the number is `failed / finished`, and a reader who
                  divides it back out against the Turns tile beside it would
                  otherwise get a different answer whenever anything is open. */}
              <div className="stat-label">Failure rate (of finished)</div>
              <div className={`stat-value ${failing > 0 ? styles.bad : ""}`}>
                {turns.finished === 0 ? "—" : pct(turns.failureRate)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Errored</div>
              <div className="stat-value">{turns.errored.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="stat-label">No model call</div>
              <div className="stat-value">{turns.noModelCall.toLocaleString()}</div>
            </div>
            {/* Not folded into the rate, so it gets its own tile. An unfinished
                turn used to score as a success inside the rate, which meant a
                crashed agent made this page look better. */}
            <div className="stat">
              <div className="stat-label">Unfinished</div>
              <div className={`stat-value ${turns.stalled > 0 ? styles.bad : ""}`}>
                {turns.unfinished.toLocaleString()}
                {turns.stalled > 0 && (
                  <span className={styles.running}> · {turns.stalled} stalled</span>
                )}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Sessions</div>
              <div className="stat-value">
                {sessions.total.toLocaleString()}
                {sessions.running > 0 && (
                  <span className={styles.running}> · {sessions.running} open</span>
                )}
              </div>
            </div>
          </div>

          {turns.unfinished > 0 && (
            <p className={styles.warnBox}>
              {turns.unfinished.toLocaleString()} of these {turns.total.toLocaleString()} turns{" "}
              {turns.unfinished === 1 ? "has" : "have"} not reached a verdict, so{" "}
              {turns.unfinished === 1 ? "it is" : "they are"} in neither half of the failure rate —
              the rate above is over the {turns.finished.toLocaleString()} that finished.
              {turns.stalled > 0 && (
                <>
                  {" "}
                  {turns.stalled.toLocaleString()} {turns.stalled === 1 ? "has" : "have"} been open
                  for more than an hour, which is the point evestack calls a turn wedged; nothing in
                  eve will resume {turns.stalled === 1 ? "it" : "them"}.
                </>
              )}{" "}
              A turn parked on an unanswered approval is <em>not</em> counted here: eve emits{" "}
              <code>turn.completed</code> before it parks, so the run row says finished while the
              work is not.
            </p>
          )}

          {turns.noModelCall > 0 && (
            <p className={styles.warnBox}>
              {turns.noModelCall} finished {turns.noModelCall === 1 ? "turn" : "turns"} recorded no
              model call. eve writes <code>$eve.model</code> only once a call reports usage, and a
              turn killed by a provider rate limit still lands as{" "}
              <code>status = &apos;completed&apos;</code> — so these are counted as failures here
              even though the workflow considers them fine.
            </p>
          )}

          <Percentiles
            title="Turn latency"
            note="One model exchange, measured completed_at − started_at so queue time is excluded."
            data={summary.turnLatencyMs}
          />

          <Series summary={summary} />

          <Percentiles
            title="Session duration"
            note="Sessions that actually ended. A session stays open while the conversation is, so this measures the conversation, not the agent — turn latency is the number to alert on."
            data={summary.sessionDurationMs}
          />
        </>
      )}
    </>
  );
}
