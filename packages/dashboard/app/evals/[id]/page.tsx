import { readRecentEvents, type EveStreamEvent } from "@/lib/agent-client";
import { describeDbError } from "@/lib/db";
import { generateEval, recoverTurns, type GeneratedEval, type RecoveredTurn } from "@/lib/promote-eval";
import { getSession } from "@/lib/queries";
import { CopySource } from "../copy-source";
import styles from "../evals.module.css";

export const dynamic = "force-dynamic";

/**
 * Preview of the eval a session would generate.
 *
 * Generated in the page rather than fetched from `/api/evals/promote/:id?format=json`.
 * The route is the download path and needs its own copy of this logic anyway;
 * calling it from here would mean the server fetching itself over HTTP, which
 * costs an absolute base URL the container does not reliably know and a second
 * pass through the auth proxy for data this process can already produce.
 * `lookback` is pinned to the route's value so the preview and the download are
 * the same file.
 */
const LOOKBACK = 4096;

type LineKind = "code" | "comment" | "suggest";

/**
 * Split the generated source into tinted lines.
 *
 * The distinction that matters is not "comment vs. code" but "prose vs. work".
 * A commented-out assertion — `// turn1.messageIncludes("…");` — is the user's
 * homework, and the whole framing of this screen collapses if it looks like
 * the same grey filler as the file header. Matching on `receiver.method(...);`
 * keeps that to the lines the generator emits for exactly that purpose.
 */
function classify(line: string): LineKind {
  const trimmed = line.trim();
  if (trimmed.startsWith("/*") || trimmed.startsWith("*")) return "comment";
  if (!trimmed.startsWith("//")) return "code";
  const body = trimmed.slice(2).trim();
  return /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(.*\);$/.test(body) ? "suggest" : "comment";
}

function SourceView({ source }: { source: string }) {
  const lines = source.replace(/\n$/, "").split("\n");
  return (
    <pre className={styles.source}>
      {lines.map((line, index) => {
        const kind = classify(line);
        const cls =
          kind === "suggest"
            ? `${styles.line} ${styles.lineSuggest}`
            : kind === "comment"
              ? `${styles.line} ${styles.lineComment}`
              : styles.line;
        // Index keys are safe here: the array is static for the life of the
        // render and never reordered.
        return (
          <span key={index} className={cls}>
            {line === "" ? " " : line}
          </span>
        );
      })}
    </pre>
  );
}

function excerpt(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export default async function EvalPreviewPage(props: PageProps<"/evals/[id]">) {
  const { id } = await props.params;

  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession(id);
  } catch (error) {
    return (
      <div className="empty">
        <h2>Can&apos;t reach the database</h2>
        <p className="dim">{describeDbError(error)}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="empty">
        <h2>No such session</h2>
        <p className="dim mono">{id}</p>
        <p className="faint">
          <a href="/evals" style={{ color: "var(--accent)" }}>
            Back to eval candidates
          </a>
        </p>
      </div>
    );
  }

  const header = (
    <>
      <p className={styles.crumb}>
        <a href="/evals">Evals</a> <span>/</span>{" "}
        <a href={`/sessions/${encodeURIComponent(session.id)}`}>{session.title ?? "untitled"}</a>
      </p>
      <h1>Draft eval</h1>
    </>
  );

  /*
   * The transcript lives on the agent, not in Postgres, so this is the one read
   * on the page that can fail while the rest of the dashboard is healthy. It
   * gets its own failure state instead of an error boundary: "the agent is
   * unreachable" and "this session is too old to promote" are different
   * problems with different fixes, and both are things the user can act on.
   */
  let events: readonly EveStreamEvent[];
  try {
    ({ events } = await readRecentEvents(session.id, { lookback: LOOKBACK }));
  } catch (error) {
    return (
      <>
        {header}
        <p className={styles.warn}>
          Could not read this session&apos;s durable event stream, so there is nothing to generate
          from. {error instanceof Error ? error.message : String(error)}
        </p>
        <p className={styles.note}>
          Promotion replays the agent&apos;s own event log — the same NDJSON the chat view consumes
          — so the agent has to be reachable from the dashboard even though every other page here
          reads Postgres.
        </p>
      </>
    );
  }

  let generated: GeneratedEval;
  let turns: RecoveredTurn[];
  try {
    generated = generateEval({ sessionId: session.id, title: session.title, events });
    turns = recoverTurns(events);
  } catch (error) {
    // generateEval throws only when its own output would carry a key eve's eval
    // loader rejects. Handing that to the user as a stack trace would be worse
    // than saying plainly that the generator, not the session, is at fault.
    return (
      <>
        {header}
        <p className={styles.warn}>
          The generator produced a file eve would refuse to load, so nothing is offered here.{" "}
          {error instanceof Error ? error.message : String(error)}
        </p>
      </>
    );
  }

  const completedCalls = turns.flatMap((turn) =>
    turn.toolNames.filter((name) => !turn.deniedTools.includes(name)),
  );
  const deniedCalls = turns.flatMap((turn) => turn.deniedTools);
  const repliesObserved = turns.filter((turn) => turn.assistantReply !== null).length;
  const parkedTurns = turns.filter((turn) => turn.deniedTools.length > 0).length;

  return (
    <>
      {header}
      <p className={styles.sub}>
        {turns.length === 0
          ? "Nothing was recovered from this session's event log."
          : `Replays ${turns.length} real message${turns.length === 1 ? "" : "s"} from session ${session.id.slice(-10)}.`}
      </p>

      <p className={styles.draft}>
        <strong>This is a draft you edit, not a test you ship.</strong> Everything below actually
        happened, which is what makes it worth replaying — but a recording of behaviour is not a
        statement of intent. The file asserts that the same tools get called and the same turns
        succeed; deciding whether any of that was <em>right</em> is the part only you can write, and
        it is left as commented suggestions in the source.
      </p>

      {generated.warnings.map((warning) => (
        <p key={warning} className={styles.warn}>
          {warning}
        </p>
      ))}

      <div className={styles.fileBox}>
        <div className={styles.fileLabel}>Save it as</div>
        <div className={styles.filePath}>
          <span className={styles.filePathDir}>evals/</span>
          {generated.filename}
        </div>
        <p className={styles.fileWhy}>
          The path <em>is</em> the eval&apos;s identity. eve derives the id and name from the file&apos;s
          location under <code>evals/</code> and throws at load time if the definition carries an{" "}
          <code>id</code> or <code>name</code> key of its own — so this file deliberately has
          neither, and renaming the file renames the eval. The suggested name is the session title
          plus the last six characters of its id: unique, but rename it to whatever will read well
          in a CI failure line.
        </p>
      </div>

      <div className={styles.actions}>
        <a
          className={`${styles.btn} ${styles.btnPrimary}`}
          href={`/api/evals/promote/${encodeURIComponent(session.id)}`}
        >
          Download {generated.filename}
        </a>
        <CopySource source={generated.source} />
        {session.status === "running" && (
          <span className={styles.copyNote}>
            This session is still running. Copy takes exactly what is shown; the download
            regenerates, so it will include any turn that lands in the meantime.
          </span>
        )}
      </div>

      <div className={styles.grid}>
        <div className={styles.card}>
          <div className={`${styles.cardHead} ${styles.cardHeadYes}`}>What this file asserts</div>
          <ul className={`${styles.cardList} ${styles.cardListYes}`}>
            <li>
              {turns.length} user message{turns.length === 1 ? "" : "s"}, replayed verbatim through{" "}
              <code>t.send()</code>.
            </li>
            <li>
              Each turn&apos;s outcome, asserted on the handle <code>t.send()</code> returned —{" "}
              <code>turn1.succeeded()</code>, never a bare <code>t.succeeded()</code>.{" "}
              <em>
                That one is session-scoped and fails with &ldquo;run parked on N unanswered input
                request(s)&rdquo; whenever a session ends parked, even though every turn behaved.
              </em>
            </li>
            {completedCalls.length > 0 && (
              <li>
                {completedCalls.length} completed tool call
                {completedCalls.length === 1 ? "" : "s"} via <code>calledTool(name)</code> on the
                turn that requested them:{" "}
                <code>{[...new Set(completedCalls)].join(", ")}</code>.
              </li>
            )}
            {deniedCalls.length > 0 && (
              <li>
                {parkedTurns} denied approval{parkedTurns === 1 ? "" : "s"} —{" "}
                <code>parked()</code>, then <code>t.respondAll(&quot;deny&quot;)</code>, then{" "}
                <code>t.calledTool(name, {"{"} status: &quot;rejected&quot; {"}"})</code> at{" "}
                <em>session</em> scope.{" "}
                <em>
                  Both halves are required: the request lands in the parked turn and the rejection
                  resolves in the resumed one, so no single turn holds both, and the default status
                  &ldquo;completed&rdquo; is a state a denied call never reaches.
                </em>
              </li>
            )}
            {turns.some((turn) => turn.failed) && (
              <li>
                Success on a turn that <em>failed</em> in production. The draft is red on purpose
                until the bug is fixed.
              </li>
            )}
          </ul>
        </div>

        <div className={styles.card}>
          <div className={`${styles.cardHead} ${styles.cardHeadNo}`}>What it does not assert</div>
          <ul className={`${styles.cardList} ${styles.cardListNo}`}>
            <li>
              What the agent <em>said</em>.{" "}
              {repliesObserved > 0 ? (
                <>
                  {repliesObserved} observed repl{repliesObserved === 1 ? "y is" : "ies are"} inlined
                  as commented <code>messageIncludes(…)</code> lines — highlighted in the source
                  below. Uncomment one and cut it down to the phrase that actually matters.
                </>
              ) : (
                <>No assistant text was recovered, so there is nothing to suggest.</>
              )}
            </li>
            <li>
              Tool <em>arguments</em>. <code>calledTool</code> matches on name, so the file proves
              an email was sent, never that it went to the right address.
            </li>
            <li>Ordering. Tool assertions within a turn are a set, not a sequence.</li>
            <li>Model, tokens, cost, or latency. None of it is in the generated file.</li>
            <li>
              That any of this was correct. The event log is a record of what happened; only you
              know what should have.
            </li>
          </ul>
        </div>
      </div>

      {turns.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            <h2>Turn by turn</h2>
            <span className={styles.sectionNote}>
              recovered from {events.length} event{events.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Message replayed</th>
                  <th>Assertions generated</th>
                </tr>
              </thead>
              <tbody>
                {turns.map((turn, index) => {
                  const handle = `turn${index + 1}`;
                  const completed = turn.toolNames.filter((n) => !turn.deniedTools.includes(n));
                  return (
                    <tr key={`${turn.turnId ?? "turn"}-${index}`}>
                      <td className="num dim">{index + 1}</td>
                      <td>
                        <span className={styles.msg} title={turn.userMessage}>
                          {excerpt(turn.userMessage)}
                        </span>
                        {turn.failed && (
                          <span className="status status-failed" style={{ marginTop: 6, display: "inline-block" }}>
                            failed
                          </span>
                        )}
                      </td>
                      <td>
                        {completed.map((tool) => (
                          <span key={tool} className={styles.assertLine}>
                            {handle}.calledTool(&quot;{tool}&quot;)
                          </span>
                        ))}
                        {turn.deniedTools.length > 0 ? (
                          <>
                            <span className={`${styles.assertLine} ${styles.assertLineDenied}`}>
                              {handle}.parked()
                            </span>
                            <span className={`${styles.assertLine} ${styles.assertLineDenied}`}>
                              {handle}Resumed.succeeded()
                            </span>
                            {turn.deniedTools.map((tool) => (
                              <span
                                key={tool}
                                className={`${styles.assertLine} ${styles.assertLineDenied}`}
                              >
                                t.calledTool(&quot;{tool}&quot;, {"{"} status: &quot;rejected&quot;{" "}
                                {"}"})
                              </span>
                            ))}
                          </>
                        ) : (
                          <span className={styles.assertLine}>{handle}.succeeded()</span>
                        )}
                        {turn.assistantReply && (
                          <span className={`${styles.assertLine} ${styles.assertLineSuggest}`}>
                            // {handle}.messageIncludes(…) — suggested, commented out
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className={styles.sectionHead}>
        <h2>Generated file</h2>
        <span className={styles.sectionNote}>evals/{generated.filename}</span>
      </div>
      <SourceView source={generated.source} />
      <p className={styles.legend}>
        <span>
          <span className={`${styles.legendSwatch} ${styles.legendSuggest}`} />
          commented assertion — your job
        </span>
        <span>
          <span className={`${styles.legendSwatch} ${styles.legendComment}`} />
          explanation
        </span>
      </p>
    </>
  );
}
