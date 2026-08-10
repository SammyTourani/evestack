import { listApprovals, type ApprovalRow } from "@/lib/approvals";
import { EM_DASH } from "@/components/ui/format";
import { describeDbError } from "@/lib/db";
import { suggestFilename } from "@/lib/promote-eval";
import { gradeOf, RANK, type Grade } from "./grade";
import { query } from "@/lib/db";
import { listSessions, type SessionRow } from "@/lib/queries";
// Minute precision: this is a ranked list, and the rows are minutes apart.
import { stamp } from "@/lib/time";
import styles from "./evals.module.css";
import { DatabaseError } from "@/app/db-error";

export const dynamic = "force-dynamic";

/**
 * Which sessions are worth turning into evals.
 *
 * Ranked from Postgres alone. The signal that would rank best — what the agent
 * actually did, turn by turn — lives in the agent's durable event stream, and
 * reading it costs one bounded HTTP stream per session (see readRecentEvents,
 * 4096 events for a promotion). Doing that for a hundred rows to paint a list
 * would make this the slowest page in the dashboard for information the user
 * gets anyway the moment they open a preview. So the list ranks on two columns
 * that are already in hand, and the preview does the real read.
 */

interface Candidate {
  session: SessionRow;
  grade: Grade;
  /** Tools a human denied in this session, per the dashboard's audit log. */
  deniedTools: string[];
}



/**
 * Why this row is here, in the terms the generated file will actually use.
 *
 * Each line names the assertion promotion will produce, so the reason a session
 * is recommended and the thing you get for promoting it are the same sentence.
 */
function explain(grade: Grade): { label: string; cls: string; line: string } {
  switch (grade) {
    case "denial":
      return {
        label: "denial replayed",
        cls: styles.whyDenial,
        line:
          "A human denied a tool call here. The draft replays the denial — that path used to end " +
          "the durable session, so it is the single most valuable thing to keep under test.",
      };
    case "failed":
      return {
        label: "regression",
        cls: styles.whyFailed,
        line:
          "This session ended badly. The draft still asserts succeeded(), so it stays red until " +
          "the bug is fixed — which is what a regression test is.",
      };
    case "plain":
      return {
        label: "happy path",
        cls: styles.whyPlain,
        line: "Nothing went wrong here. Promoting it pins the behaviour so it stays that way.",
      };
    case "empty":
      return {
        label: "nothing to replay",
        cls: styles.whyEmpty,
        line:
          "No turns recorded under this session, so there are no user messages to send and the " +
          "generated file would have an empty test body.",
      };
  }
}

export default async function EvalsPage() {
  let sessions: SessionRow[];
  try {
    sessions = await listSessions(100);
  } catch (error) {
    return (
      <>
        <h1>Evals</h1>
        <DatabaseError error={error} />
      </>
    );
  }

  /*
   * Denials come from evestack's own audit log, which only holds decisions this
   * dashboard carried out (recordApproval is called from the approve route and
   * nowhere else). A denial answered by curling the agent directly is invisible
   * here — the session is still promotable, it just will not be flagged. Losing
   * the whole page to a missing approvals table would be a worse trade, so this
   * degrades instead of throwing.
   */
  let approvals: ApprovalRow[] = [];
  let approvalsError: string | null = null;
  try {
    approvals = await listApprovals(500);
  } catch (error) {
    approvalsError = describeDbError(error);
  }

  /*
   * How many turns in each session actually failed. One query for the whole
   * page rather than one per session, and it degrades to "no failures known"
   * rather than taking the page down: an install whose role cannot read the
   * evestack schema still gets a working promotion list, just without the
   * ranking that puts broken sessions first.
   */
  const failedBySession = new Map<string, number>();
  /**
   * Set when the query above did not answer.
   *
   * Without it the catch below produced an empty map, `gradeOf` never returned
   * `failed`, the "Ended badly" tile rendered a confident `0`, and every row's
   * Why column read "Nothing went wrong here." — a per-session verdict derived
   * from a read that never happened. The approvals half of this page already
   * has exactly this affordance twenty lines up; this half did not.
   */
  let failedError: string | null = null;
  try {
    const rows = await query<{ session_id: string; n: string }>(
      `SELECT session_id, count(*)::text AS n
         FROM evestack.fact_turn
        WHERE outcome IN ('failed', 'no_model_call') AND session_id = ANY($1::text[])
        GROUP BY session_id`,
      [sessions.map((x) => x.id)],
    );
    for (const r of rows) failedBySession.set(r.session_id, Number(r.n));
  } catch (error) {
    // Ranking degrades; promotion still works — but it degrades OUT LOUD, so
    // "Ended badly: 0" is never printed about turns nobody counted.
    failedError = describeDbError(error);
  }

  const deniedBySession = new Map<string, string[]>();
  for (const row of approvals) {
    if (row.optionId !== "deny") continue;
    const tools = deniedBySession.get(row.sessionId) ?? [];
    // toolName is null for a denied `ask_question`, which is a denial worth
    // flagging even though it names no tool.
    if (row.toolName && !tools.includes(row.toolName)) tools.push(row.toolName);
    deniedBySession.set(row.sessionId, tools);
  }

  // Stable sort: listSessions already returns newest-first, so sorting only by
  // grade leaves recency as the tiebreak within each group.
  const candidates: Candidate[] = sessions
    .map((session) => {
      const deniedTools = deniedBySession.get(session.id) ?? [];
      const failedTurns = failedBySession.get(session.id) ?? 0;
      return { session, deniedTools, grade: gradeOf(session, deniedTools, failedTurns) };
    })
    .sort((a, b) => RANK[a.grade] - RANK[b.grade]);

  const counts = {
    denial: candidates.filter((c) => c.grade === "denial").length,
    failed: candidates.filter((c) => c.grade === "failed").length,
    promotable: candidates.filter((c) => c.grade !== "empty").length,
  };

  return (
    <>
      <h1>Evals</h1>
      <p className="page-sub">
        Turn a session that already happened into an eve eval. The transcript <em>is</em> the test:
        promotion replays the user&apos;s real messages and asserts what the agent really did.
      </p>

      <p className={styles.draft}>
        <strong>What you get is a draft, not a finished test.</strong> The event log records what
        the agent did; it can never record what it should have done. So the messages and tool calls
        in the generated file are real, and every assertion about <em>meaning</em> — did the reply
        say the right thing — is emitted as a commented suggestion for you to sharpen. Promoting a
        session is the first ten minutes of writing the test, not the whole of it.
      </p>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Promotable</div>
          <div className="stat-value">{counts.promotable}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Denials to replay</div>
          <div className="stat-value">{counts.denial}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Ended badly</div>
          <div className="stat-value">{failedError === null ? counts.failed : EM_DASH}</div>
        </div>
      </div>

      {failedError && (
        <p className={styles.warn}>
          Could not count failed turns, so no session below is described as having ended badly and
          the count above is unknown rather than zero. {failedError}
        </p>
      )}

      {approvalsError && (
        <p className={styles.warn}>
          Could not read the approvals audit log, so sessions with a denied tool call are not
          flagged below. {approvalsError}
        </p>
      )}

      {candidates.length === 0 ? (
        <div className="empty">
          <h2>No sessions to promote yet</h2>
          <p>
            Every agent run shows up here as an eval candidate. The ones worth promoting first are
            the ones that went wrong.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Why</th>
                <th className="num">Turns</th>
                <th className="num">Started</th>
                <th>Generates</th>
                <th aria-label="Preview" />
              </tr>
            </thead>
            <tbody>
              {candidates.map(({ session, grade, deniedTools }) => {
                const why = explain(grade);
                const filename = suggestFilename(session.id, session.title);
                return (
                  <tr key={session.id}>
                    <td>
                      <a href={`/sessions/${encodeURIComponent(session.id)}`}>
                        <div>{session.title ?? <span className="faint">untitled</span>}</div>
                        <div className="mono faint">{session.id.slice(0, 24)}…</div>
                      </a>
                    </td>
                    <td>
                      <span className={`${styles.why} ${why.cls}`}>{why.label}</span>
                      <span className={styles.whyLine}>{why.line}</span>
                      {deniedTools.length > 0 && (
                        <span className={styles.tools}>
                          {deniedTools.map((tool) => (
                            <span key={tool} className={styles.tool}>
                              {tool}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="num">{session.turnCount}</td>
                    <td className="num dim">{stamp(session.createdAt)}</td>
                    <td className={styles.filenameCell}>
                      {grade === "empty" ? <span className="faint">—</span> : `evals/${filename}`}
                    </td>
                    <td>
                      <a
                        className={styles.previewLink}
                        href={`/evals/${encodeURIComponent(session.id)}`}
                      >
                        preview →
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.note}>
        Ranking uses Postgres only — session status and this dashboard&apos;s approvals log. The
        actual transcript comes off the agent&apos;s durable event stream and is read when you open
        a preview, so a session whose events eve has already pruned still appears here and tells you
        so on the way in.
      </p>
    </>
  );
}
