import { INGEST_PATH, ingestOriginForHumans } from "./ingest-url";
import styles from "./traces.module.css";

/**
 * The default state of /traces, and the setup instructions on it.
 *
 * Its own file rather than a function at the bottom of page.tsx, because every
 * claim it makes is checked against docs/observability.mdx and
 * app/api/ingest/v1/traces/route.ts, and a setup page that is subtly wrong costs
 * more than no setup page at all. Here it can be rendered and asserted on —
 * page.tsx cannot be, since importing it opens a database pool.
 *
 * The URL is a PROP, not a literal and not something this component derives.
 * The line it prints used to be a hardcoded `http://localhost:4000/...`; see
 * ./ingest-url.ts for what that cost and where the real address comes from.
 */
export function NoSpans({ origin }: { origin: string }) {
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
          {`EVESTACK_DASHBOARD_URL=${origin}${INGEST_PATH}\n`}
          {"EVESTACK_INGEST_TOKEN=<the same value this dashboard has>"}
        </pre>
        <ul>
          <li>
            {/* Not a general statement about ports: this is the address YOUR
                browser reached this dashboard on, which is the one fact the
                process is certain of. The scaffolder picks the first free port
                at or after 4000, so a second project is on 4001 and a printed
                4000 would have sent its spans to the first project's
                dashboard. */}
            <code>{origin}</code> is where this dashboard answered the request that rendered this
            page. If your agent runs somewhere that name does not resolve — another machine, or a
            container — use an address that reaches here from there instead.
          </li>
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

/**
 * Re-exported so page.tsx has one import for the empty state and the derivation
 * that feeds it, and so a reader who opens this file finds the reasoning
 * immediately rather than two directories away.
 */
export { ingestOriginForHumans };
