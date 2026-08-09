import { DatabaseError } from "@/app/db-error";
import { listApprovals, type ApprovalRow, type ApproverIdentity } from "@/lib/approvals";
import { stamp } from "@/lib/time";
import styles from "./approvals.module.css";

export const dynamic = "force-dynamic";

type Trust = { label: string; cls: string; title: string };

const PROXY_TITLE =
  "Supplied by whatever proxy fronts the dashboard — as trustworthy as that proxy.";

/**
 * Keyed by the union in lib/approvals.ts rather than by `string`, so adding a
 * `via` there fails this file's typecheck instead of silently rendering as
 * "unidentified". That is precisely what happened to `session`: the switch this
 * replaces handled `basic` and the three forwarded values, and every approval
 * made from the signed-in UI — the primary path, and the one the page exists to
 * show — fell through to the default and was reported in red as nobody.
 */
const TRUST: Record<ApproverIdentity["via"], Trust> = {
  header: { label: "header", cls: "status-completed", title: PROXY_TITLE },
  "forwarded-user": { label: "user", cls: "status-completed", title: PROXY_TITLE },
  "forwarded-email": { label: "email", cls: "status-completed", title: PROXY_TITLE },
  session: {
    label: "signed in",
    cls: "status-running",
    title:
      "Signed in to this dashboard. evestack generates one shared credential, so this identifies the deployment rather than a person.",
  },
  basic: {
    label: "basic",
    cls: "status-running",
    title:
      "HTTP Basic user. evestack generates one shared credential, so this identifies the deployment rather than a person.",
  },
  unidentified: {
    label: "unidentified",
    cls: "status-failed",
    title:
      "Nothing in front of the dashboard identified the caller. Set EVESTACK_REQUIRE_APPROVER=1 to refuse these.",
  },
};

/**
 * How much the recorded identity is actually worth.
 *
 * A proxy-supplied header is only as trustworthy as the proxy in front of it,
 * and evestack's Basic credential is one shared secret for the whole
 * deployment — it names a stack, not a person. Saying so in the table beats
 * letting a reader assume every row is a proven human.
 *
 * `via` is widened to `string` on the way out of Postgres, so a row written by
 * an older build can carry a value this table has never heard of. Those are
 * genuinely unidentified and fall back accordingly.
 */
function trust(via: string): Trust {
  return TRUST[via as ApproverIdentity["via"]] ?? TRUST.unidentified;
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
    return <DatabaseError error={error} />;
  }

  const unidentified = rows.filter((r) => r.approverVia === "unidentified").length;

  return (
    <>
      <h1>Approvals</h1>
      <p className="page-sub">
        Every human-in-the-loop decision this dashboard carried out. eve&apos;s protocol carries no
        identity, so this is the only place that records <em>who</em>.
      </p>
      {/*
        Say what this page is NOT, because its name and its position under
        "Drive" both promise otherwise.

        This is a log of decisions already made — it has no controls and cannot
        answer anything. A session parked on a gated tool is answered in Chat,
        which attaches to a durable session by id. Without this line the reader
        who came here to unblock an agent has no way of learning that, and the
        fleet banner used to send them to a read-only page too.
      */}
      <p className="page-sub">
        A record, not a queue — there is nothing to action here. A session parked on a decision is
        answered in <a href="/chat">Chat</a>, which attaches to it by id; the banner on{" "}
        <a href="/">Overview</a> links each waiting session straight through.
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
                <th>When</th>
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
                    {/* An audit log is unbounded in time, so the year is not optional here:
                        without it a decision from last August and one from this August are
                        the same string. See the note on `stamp`. */}
                    <td className="mono">{stamp(row.decidedAt, "second", { year: true })}</td>
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
