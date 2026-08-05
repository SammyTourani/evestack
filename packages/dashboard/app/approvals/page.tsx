import { listApprovals, type ApprovalRow } from "@/lib/approvals";
import { DatabaseUnavailableError, describeDbError } from "@/lib/db";
import styles from "./approvals.module.css";

export const dynamic = "force-dynamic";

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "UTC", hour12: false });
}

/**
 * How much the recorded identity is actually worth.
 *
 * A proxy-supplied header is only as trustworthy as the proxy in front of it,
 * and evestack's Basic credential is one shared secret for the whole
 * deployment — it names a stack, not a person. Saying so in the table beats
 * letting a reader assume every row is a proven human.
 */
function trust(via: string): { label: string; cls: string; title: string } {
  switch (via) {
    case "header":
    case "forwarded-user":
    case "forwarded-email":
      return {
        label: via === "header" ? "header" : via.replace("forwarded-", ""),
        cls: "status-completed",
        title: "Supplied by whatever proxy fronts the dashboard — as trustworthy as that proxy.",
      };
    case "basic":
      return {
        label: "basic",
        cls: "status-running",
        title:
          "HTTP Basic user. evestack generates one shared credential, so this identifies the deployment rather than a person.",
      };
    default:
      return {
        label: "unidentified",
        cls: "status-failed",
        title:
          "Nothing in front of the dashboard identified the caller. Set EVESTACK_REQUIRE_APPROVER=1 to refuse these.",
      };
  }
}

function decision(row: ApprovalRow): string {
  if (row.optionId === "approve") return "approved";
  if (row.optionId === "deny") return "denied";
  if (row.optionId) return row.optionId;
  return row.answerText ? "answered" : "—";
}

export default async function ApprovalsPage() {
  let rows: ApprovalRow[];
  try {
    rows = await listApprovals(200);
  } catch (error) {
    const unavailable = error instanceof DatabaseUnavailableError;
    return (
      <div className="empty">
        <h2>{unavailable ? "Database unreachable" : "Could not read the audit log"}</h2>
        <p>{describeDbError(error)}</p>
      </div>
    );
  }

  const unidentified = rows.filter((r) => r.approverVia === "unidentified").length;

  return (
    <>
      <h1>Approvals</h1>
      <p className={styles.sub}>
        Every human-in-the-loop decision this dashboard carried out. eve&apos;s protocol carries no
        identity, so this is the only place that records <em>who</em>.
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          <h2>No decisions recorded yet</h2>
          <p>
            Approve or deny a gated tool call and it lands here. The template ships{" "}
            <code>forget</code> behind <code>approval: always()</code> if you want something to try
            it with.
          </p>
        </div>
      ) : (
        <>
          {unidentified > 0 && (
            <p className={styles.warn}>
              {unidentified} of these {rows.length} decisions could not be attributed to anyone. Put
              the dashboard behind a proxy that sets <code>X-Forwarded-User</code>, then set{" "}
              <code>EVESTACK_REQUIRE_APPROVER=1</code> to refuse anonymous approvals outright.
            </p>
          )}
          <table className={styles.table}>
            <thead>
              <tr>
                <th>When (UTC)</th>
                <th>Decision</th>
                <th>Tool</th>
                <th>Approver</th>
                <th>Proof</th>
                <th>Session</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const t = trust(row.approverVia);
                return (
                  <tr key={row.id}>
                    <td className="mono">{stamp(row.decidedAt)}</td>
                    <td>
                      <span
                        className={
                          row.optionId === "deny" ? "status status-failed" : "status status-completed"
                        }
                      >
                        {decision(row)}
                      </span>
                    </td>
                    <td className="mono">{row.toolName ?? <span className="faint">—</span>}</td>
                    <td>{row.approver ?? <span className="faint">nobody</span>}</td>
                    <td>
                      <span className={`status ${t.cls}`} title={t.title}>
                        {t.label}
                      </span>
                    </td>
                    <td>
                      <a className="mono" href={`/sessions/${encodeURIComponent(row.sessionId)}`}>
                        {row.sessionId.slice(-10)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
