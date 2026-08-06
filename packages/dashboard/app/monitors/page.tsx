import { DatabaseUnavailableError, describeDbError } from "@/lib/db";
import { WINDOWS, getMonitorSummary, type MonitorSummary } from "@/lib/monitors";
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

function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes}m ${Math.round((value % 60_000) / 1000)}s`;
}

const pct = (fraction: number): string => `${(fraction * 100).toFixed(fraction === 0 ? 0 : 1)}%`;

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: "UTC", hour12: false, timeStyle: "short" });

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
            <div className="stat-value">{ms(row.value)}</div>
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
                title={`${clock(bucket.start)} UTC — ${bucket.turns} turn${bucket.turns === 1 ? "" : "s"}, ${bucket.failed} failed${bucket.p95Ms === null ? "" : `, p95 ${ms(bucket.p95Ms)}`}`}
              >
                <div className={styles.barFailed} style={{ height: `${failedShare}%` }} />
              </div>
              <span className={styles.tick}>{clock(bucket.start)}</span>
            </div>
          );
        })}
      </div>
      <p className={styles.note}>
        Turns per bucket, with the failed share in red. An empty bucket is a real zero and is drawn
        as one — skipping it would redraw a quiet hour as continuous load.
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
    const unavailable = error instanceof DatabaseUnavailableError;
    return (
      <div className="empty">
        <h2>{unavailable ? "Database unreachable" : "Could not read monitors"}</h2>
        <p>{describeDbError(error)}</p>
      </div>
    );
  }

  const { turns, sessions } = summary;
  const failing = turns.errored + turns.noModelCall;

  return (
    <>
      <h1>Monitors</h1>
      <p className="page-sub">
        Latency and failure rates over the last {windowLabel(hours)}, from the same{" "}
        <code>workflow.workflow_runs</code> the session list reads. Nothing is sampled and nothing
        is estimated.
      </p>

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
              <div className="stat-label">Failure rate</div>
              <div className={`stat-value ${failing > 0 ? styles.bad : ""}`}>
                {pct(turns.failureRate)}
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
