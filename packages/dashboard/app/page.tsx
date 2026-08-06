import { FleetBanner } from "./fleet-banner";
import { agentUrlForHumans } from "@/lib/agent-client";
import { isPriced } from "@/lib/pricing";
import { formatUsd } from "@/lib/pricing";
import { getTotals, listSessions } from "@/lib/queries";
import { DatabaseError } from "@/app/db-error";

export const dynamic = "force-dynamic";

function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export default async function SessionsPage() {
  let sessions;
  let totals;
  try {
    [sessions, totals] = await Promise.all([listSessions(100), getTotals()]);
  } catch (error) {
    return (
      <DatabaseError error={error} />
    );
  }

  const anyUnpriced = sessions.some((s) => s.models.some((m) => !isPriced(m)));

  return (
    <>
      <h1>Sessions</h1>
      <p className="page-sub">
        Every agent run on this machine. Read straight from your own Postgres.
      </p>

      {/* Renders nothing when nothing is wrong — see fleet-banner.tsx. */}
      <FleetBanner />

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Sessions</div>
          <div className="stat-value">{fmt(totals.sessions)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Turns</div>
          <div className="stat-value">{fmt(totals.turns)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Tokens in / out</div>
          <div className="stat-value">
            {fmt(totals.inputTokens)}
            <span className="faint"> / </span>
            {fmt(totals.outputTokens)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Model spend</div>
          <div className="stat-value">{formatUsd(totals.costUsd)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Infrastructure</div>
          <div className="stat-value free">$0.00</div>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="empty">
          <h2>No sessions yet</h2>
          {/*
            This used to offer a curl command and nothing else — to the one
            reader who has, by definition, just arrived and has never used this.
            The Chat page is one click away and does the same thing with a text
            box, so it goes first and the curl goes second, for the people who
            want it. The URL is read from EVESTACK_AGENT_URL rather than
            hardcoded to :2000, because `eve dev` auto-increments when that port
            is taken and a copy-pasteable command that quietly points at someone
            else&apos;s agent is worse than no command. Through
            agentUrlForHumans(), because inside the container the configured host
            is `host.docker.internal`, which does not resolve in the terminal
            this is meant to be pasted into.
          */}
          <p>
            <a href="/chat">Open Chat</a> and send your agent a message — it will show up here.
          </p>
          <p className="faint">Or from a terminal:</p>
          <p className="faint mono">
            curl -X POST {agentUrlForHumans()}/eve/v1/session -H &apos;content-type:
            application/json&apos; -d &apos;{"{"}&quot;message&quot;:&quot;hello&quot;{"}"}&apos;
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Status</th>
                <th className="num">Turns</th>
                <th>Model</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th className="num">Cached</th>
                <th className="num">Cost</th>
                <th className="num">Started</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={`/sessions/${s.id}`}>
                      <div>{s.title ?? <span className="faint">untitled</span>}</div>
                      <div className="mono faint">{s.id.slice(0, 24)}…</div>
                    </a>
                  </td>
                  <td>
                    <span className={`status status-${s.status}`}>{s.status}</span>
                  </td>
                  <td className="num">{s.turnCount}</td>
                  <td className="mono dim">
                    {s.models.length ? s.models.join(", ") : "—"}
                    {s.models.some((m) => !isPriced(m)) && (
                      <div className="unpriced" title="No price configured for this model">
                        unpriced
                      </div>
                    )}
                  </td>
                  <td className="num">{fmt(s.inputTokens)}</td>
                  <td className="num">{fmt(s.outputTokens)}</td>
                  <td className="num dim">{fmt(s.cacheReadTokens)}</td>
                  <td className="num">{formatUsd(s.costUsd)}</td>
                  <td className="num dim">{ago(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {anyUnpriced && (
        <p className="faint" style={{ marginTop: 14, fontSize: 12 }}>
          Some models have no price configured, so their cost reads $0.00. Set{" "}
          <code>EVESTACK_PRICING</code> to price them.
        </p>
      )}
    </>
  );
}
