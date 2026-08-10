import { getTraceOverview, listTracedSessions } from "@/lib/traces";
import { fmt } from "./format";
import { ago, duration } from "@/lib/time";
import styles from "./traces.module.css";
import { DatabaseError } from "@/app/db-error";

export const dynamic = "force-dynamic";

/**
 * The trace index.
 *
 * Tier 2 is opt-in, so the overwhelmingly common state of this page is empty —
 * and an empty page that says "no traces" and nothing else is indistinguishable
 * from a broken one. Three distinct states are therefore reported separately:
 * nothing configured, spans arriving with no session id (the wrong-vocabulary
 * failure), and spans attributed normally. See docs/observability.mdx.
 */
export default async function TracesPage() {
  let overview: Awaited<ReturnType<typeof getTraceOverview>>;
  let sessions: Awaited<ReturnType<typeof listTracedSessions>>;
  try {
    [overview, sessions] = await Promise.all([getTraceOverview(), listTracedSessions(200)]);
  } catch (error) {
    return (
      <DatabaseError error={error} />
    );
  }

  return (
    <>
      <h1>Traces</h1>
      <p className="page-sub">
        What the agent was actually told, and what its tools returned. Read from spans your agent
        exported to this dashboard.
      </p>

      {overview.spans === 0 ? (
        <NoSpans />
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-label">Spans</div>
              <div className="stat-value">{fmt(overview.spans)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Traces</div>
              <div className="stat-value">{fmt(overview.traces)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Sessions</div>
              <div className="stat-value">{fmt(overview.sessions)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Model calls</div>
              <div className="stat-value">{fmt(overview.modelCalls)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Tool calls</div>
              <div className="stat-value">{fmt(overview.toolCalls)}</div>
            </div>
          </div>

          {sessions.length === 0 ? (
            <NoSessionIds overview={overview} />
          ) : (
            <>
              <div className={styles.sectionHead}>
                <h2>Sessions with traces</h2>
                <span className={styles.sectionNote}>
                  {overview.lastReceivedAt
                    ? `last span received ${ago(overview.lastReceivedAt)}`
                    : "never received a span"}
                </span>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Agent</th>
                      {/* Not "Spans". The detail page also has a number under
                          that word and it is a different number — this counts
                          the spans attributed TO the session, that one counts
                          every span in the traces the session touched, and the
                          second is several times the first. One click apart,
                          same label, no way to tell which you were reading. */}
                      <th
                        className="num"
                        title="Spans that resolve to this session. The session's traces also carry plumbing spans that belong to no session; open a session to see those."
                      >
                        Attributed spans
                      </th>
                      <th className="num">Traces</th>
                      <th className="num">Model calls</th>
                      <th className="num">Tool calls</th>
                      <th className="num">Span window</th>
                      <th className="num">Last span</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.sessionId}>
                        <td>
                          <a href={`/traces/${encodeURIComponent(s.sessionId)}`}>
                            <span className="mono">{s.sessionId}</span>
                          </a>
                        </td>
                        <td className="mono dim">{s.service ?? "—"}</td>
                        <td className="num">{fmt(s.spans)}</td>
                        <td className="num dim">{fmt(s.traces)}</td>
                        <td className="num">{fmt(s.modelCalls)}</td>
                        <td className="num">{fmt(s.toolCalls)}</td>
                        {/* First span start to last span start — not to the last
                            span's end, which the aggregate does not carry. Close
                            enough to read as "how long this session was busy",
                            and the tooltip says exactly what it measures. */}
                        <td
                          className="num dim"
                          title={`first span started ${s.firstStart}, last span started ${s.lastStart}`}
                        >
                          {duration(
                            new Date(s.lastStart).getTime() - new Date(s.firstStart).getTime(),
                          )}
                        </td>
                        <td className="num dim" title={s.lastStart}>
                          {ago(s.lastStart)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {overview.unattributedSpans > 0 && (
                <p className={`faint ${styles.truncNote}`}>
                  {fmt(overview.unattributedSpans)} of {fmt(overview.spans)} spans carry no session
                  id and are not listed above. That is normal — workflow plumbing and outbound
                  fetch spans have no agent identity — and they are still read as part of their
                  trace when you open a session.
                </p>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * Spans are arriving but none of them resolves to a session.
 *
 * This is the failure the id columns in sql/traces.sql exist to prevent, and it
 * is worth naming precisely: a database created before those columns learned
 * the AI SDK vocabulary keeps the old single-key expression forever, because
 * CREATE TABLE IF NOT EXISTS does nothing on an existing table. The migration
 * at the bottom of sql/traces.sql fixes it on the next boot.
 */
function NoSessionIds({ overview }: { overview: { spans: number; traces: number } }) {
  return (
    <div className="empty">
      <h2>{fmt(overview.spans)} spans, no session ids</h2>
      <p>
        Spans are reaching this dashboard — {fmt(overview.traces)} traces of them — but not one
        carries <code>agent.session.id</code> or{" "}
        <code>ai.settings.context.eve.session.id</code>, so none of them can be attributed to a
        session.
      </p>
      <p className="faint">
        If this database predates the id columns learning the AI SDK vocabulary, restarting the
        dashboard applies the migration at the bottom of <code>sql/traces.sql</code> and the spans
        already stored will resolve — the columns are generated, so nothing has to be re-exported.
      </p>
    </div>
  );
}

/**
 * The default state. Everything asserted here is checked against
 * docs/observability.mdx and app/api/ingest/v1/traces/route.ts, because a setup
 * page that is subtly wrong costs more than no setup page at all.
 */
function NoSpans() {
  return (
    <div className="empty">
      <h2>No spans yet</h2>
      <div className={styles.setup}>
        <p>
          Trace export is opt-in, and off by default. Sessions, turns, tokens and cost all work
          without it — they come from <code>workflow.workflow_runs</code>, not from spans. What you
          get by turning it on is the content: system prompts, message history, and the arguments
          and results of every tool the agent ran.
        </p>
        <p>Set both variables for the agent, and restart it:</p>
        <pre>
          {"EVESTACK_DASHBOARD_URL=http://localhost:4000/api/ingest/v1/traces\n"}
          {"EVESTACK_INGEST_TOKEN=<the same value this dashboard has>"}
        </pre>
        <ul>
          <li>
            The URL is the <strong>full path</strong>. <code>@vercel/otel</code> uses it verbatim
            and appends nothing, so a bare origin or the conventional{" "}
            <code>:4318/v1/traces</code> never arrives.
          </li>
          <li>
            Both sides need the <em>same</em> <code>EVESTACK_INGEST_TOKEN</code>. Leaving it unset
            on both does not open the endpoint — it makes the route fall back to browser session
            auth, and an exporter has no cookie, so every span is refused with 401.
          </li>
          <li>
            That 401 is silent. An HTTP error resolves a <code>fetch</code>, so the exporter
            reports the rejected batch as a success and never retries. The template probes the
            endpoint once at boot for exactly this reason.
          </li>
          <li>
            Use <code>OTLPHttpJsonTraceExporter</code>. This endpoint parses JSON only and rejects
            protobuf with a 415 rather than half-decoding a span.
          </li>
        </ul>
        <p className="faint">
          <code>create-evestack</code> writes both into <code>.env.local</code>, which the
          dashboard container also reads, so a scaffolded project needs no extra step. Full detail
          is in <code>docs/observability.mdx</code>.
        </p>
      </div>
    </div>
  );
}
