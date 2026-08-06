import { formatUsd, isPriced } from "@/lib/pricing";
import { getSession, getSessionTree, type TurnRow } from "@/lib/queries";
import { duration, stamp as utcStamp } from "@/lib/time";
import { ForkPanel } from "./fork-client";
import styles from "./session.module.css";
import { DatabaseError } from "@/app/db-error";

export const dynamic = "force-dynamic";

interface TreeNode {
  run: TurnRow;
  children: TreeNode[];
}

/**
 * Rebuild the run hierarchy from the flat rows getSessionTree() returns.
 *
 * The session row is in that array too (the query matches `id = $1`), but it is
 * the tree, not a node in it, so it is dropped here. Anything whose parent is
 * missing from the result set — a subagent whose caller was pruned, say — hangs
 * off the session rather than disappearing from the page.
 */
function buildTree(rows: TurnRow[], sessionId: string): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const run of rows) {
    if (run.id !== sessionId) nodes.set(run.id, { run, children: [] });
  }

  // Attaching a node whose ancestry loops back to itself would create a cycle,
  // and the recursive render below would never terminate.
  const parentOf = (node: TreeNode): TreeNode | undefined => {
    const direct = node.run.parent ? nodes.get(node.run.parent) : undefined;
    const seen = new Set<string>([node.run.id]);
    for (let cursor = direct; cursor; cursor = cursor.run.parent ? nodes.get(cursor.run.parent) : undefined) {
      if (seen.has(cursor.run.id)) return undefined;
      seen.add(cursor.run.id);
    }
    return direct;
  };

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf(node);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * A drill-down wants the actual clock time of each turn, not "3h ago", and to
 * the second because sequential turns are seconds apart. lib/time.ts prints it
 * in UTC and labels it; the local-component formatting this replaces was a
 * second correction on top of the UTC parser lib/db.ts already installs, and
 * was wrong by the host offset anywhere but the container.
 */
const stamp = (iso: string): string => utcStamp(iso, "second");

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.metric}>
      <div className={styles.metricLabel}>{label}</div>
      <div className={styles.metricValue}>{children}</div>
    </div>
  );
}

/**
 * eve names a subagent by its compiled graph node id, and the built-in `agent`
 * tool — delegating to a copy of the current agent — is literally `__root__`.
 * That is the most common subagent there is, so showing the raw id would put a
 * meaningless token in front of most users. Named subagents keep their name.
 */
function kindLabel(run: TurnRow): string {
  if (run.type !== "subagent") return run.type;
  if (!run.subagent || run.subagent === "__root__") return "subagent";
  return run.subagent;
}

function RunNode({ node, seq }: { node: TreeNode; seq?: number }) {
  const run = node.run;
  const failed = run.status === "failed" || run.status === "errored" || run.errorCode !== null;
  const priced = isPriced(run.model);

  return (
    <li>
      <div className={failed ? `${styles.card} ${styles.cardFailed}` : styles.card}>
        <div className={styles.cardHead}>
          {seq !== undefined && <span className={styles.seq}>#{seq}</span>}
          <span className={styles.kind}>{kindLabel(run)}</span>
          <span className={`status status-${run.status}`}>{run.status}</span>
          <span className={styles.model}>
            {run.model ?? (
              <span className={run.noModelCall ? "unpriced" : "faint"}>
                {run.noModelCall ? "no model call — turn produced nothing" : "no model recorded"}
              </span>
            )}
          </span>
          {run.model && !priced && (
            <span className="unpriced" title="No price configured for this model">
              unpriced
            </span>
          )}
          <span className={styles.cardId}>{run.id}</span>
        </div>

        {failed && (
          <div className={styles.error}>
            <span className={styles.errorLabel}>Error</span>
            <span className={styles.errorCode}>{run.errorCode ?? "no error code recorded"}</span>
          </div>
        )}

        <div className={styles.metrics}>
          <Metric label="Duration">{duration(run.durationMs)}</Metric>
          <Metric label="In">{fmt(run.inputTokens)}</Metric>
          <Metric label="Out">{fmt(run.outputTokens)}</Metric>
          <Metric label="Cached">
            <span className="dim">{fmt(run.cacheReadTokens)}</span>
          </Metric>
          {run.cacheWriteTokens > 0 && (
            <Metric label="Cache write">
              <span className="dim">{fmt(run.cacheWriteTokens)}</span>
            </Metric>
          )}
          {/*
            Two different facts, never one. `Tools offered` is the size of the
            registry eve handed the model — capacity, not activity, and it read
            as activity while it was labelled `TOOLS` beside duration and cost.
            `Tools called` is absent, not zero, when the turn has no trace to
            count from; see TurnRow in lib/queries.ts.
          */}
          <Metric label="Tools offered">
            {run.toolsOffered === null ? <span className="dim">—</span> : fmt(run.toolsOffered)}
          </Metric>
          <Metric label="Tools called">
            {run.toolInvocations === null ? (
              <span className="dim" title="No exported trace for this turn, so tool calls are unknown">
                —
              </span>
            ) : (
              fmt(run.toolInvocations)
            )}
          </Metric>
          <Metric label="Cost">
            {/* An unpriced model must never render as $0.00 — that reads as free. */}
            {priced ? formatUsd(run.costUsd) : <span className="unpriced">—</span>}
          </Metric>
          <Metric label="Started">
            <span className="dim" title={run.startedAt ?? run.createdAt}>
              {stamp(run.startedAt ?? run.createdAt)}
            </span>
          </Metric>
        </div>
      </div>

      {node.children.length > 0 && (
        <ul className={styles.children}>
          {node.children.map((child) => (
            <RunNode key={child.run.id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default async function SessionDetailPage(props: PageProps<"/sessions/[id]">) {
  const { id } = await props.params;

  let session: Awaited<ReturnType<typeof getSession>>;
  let rows: TurnRow[];
  try {
    [session, rows] = await Promise.all([getSession(id), getSessionTree(id)]);
  } catch (error) {
    return (
      <DatabaseError error={error} />
    );
  }

  if (!session) {
    return (
      <div className="empty">
        <h2>No such session</h2>
        <p className="dim mono">{id}</p>
        <p className="faint">
          It may have been pruned from Postgres, or the id is wrong.{" "}
          <a href="/" style={{ color: "var(--accent)" }}>
            Back to sessions
          </a>
        </p>
      </div>
    );
  }

  const roots = buildTree(rows, session.id);
  const runs = rows.filter((r) => r.id !== session.id);
  // A failed turn is the session most worth promoting to an eval, so the button
  // says so rather than making the user infer it from the tree below.
  const failedTurn = runs.find((r) => r.errorCode || r.noModelCall);
  const subagents = runs.filter((r) => r.type === "subagent");
  // getSession() rolls up turns only, but the session list adds every child run,
  // so subagent spend is folded back in here to keep the two pages agreeing.
  const totalCost = session.costUsd + subagents.reduce((sum, r) => sum + r.costUsd, 0);
  const anyUnpriced = runs.some((r) => r.model !== null && !isPriced(r.model));
  const elapsed =
    new Date(session.completedAt ?? Date.now()).getTime() - new Date(session.createdAt).getTime();
  // Only trustworthy once the session closed; while it is open this measures
  // against now(), which the timestamp skew above makes meaningless.
  const elapsedLabel = session.completedAt
    ? `ran ${duration(elapsed)}`
    : elapsed >= 0
      ? `open for ${duration(elapsed)}`
      : "still open";

  return (
    <>
      <nav className={styles.crumbs}>
        <a href="/">Sessions</a>
        <span>/</span>
        <span>this run</span>
      </nav>

      <h1>{session.title ?? <span className="faint">Untitled session</span>}</h1>

      <div className={styles.meta}>
        <span
          className={`status status-${session.status}`}
          title="eve keeps the session run open until it times out, so an idle session reads as running."
        >
          {session.status}
        </span>
        {session.trigger && (
          <>
            <span className={styles.dot}>•</span>
            <span>
              trigger <span className="mono">{session.trigger}</span>
            </span>
          </>
        )}
        <span className={styles.dot}>•</span>
        <span title={session.createdAt}>started {stamp(session.createdAt)}</span>
        <span className={styles.dot}>•</span>
        <span title={session.completedAt ?? undefined}>{elapsedLabel}</span>
        <span className={styles.dot}>•</span>
        <span className={styles.runId}>{session.id}</span>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Turns</div>
          <div className="stat-value">{fmt(session.turnCount)}</div>
        </div>
        {subagents.length > 0 && (
          <div className="stat">
            <div className="stat-label">Subagents</div>
            <div className="stat-value">{fmt(subagents.length)}</div>
          </div>
        )}
        <div className="stat">
          <div className="stat-label">Tokens in / out</div>
          <div className="stat-value">
            {fmt(session.inputTokens)}
            <span className="faint"> / </span>
            {fmt(session.outputTokens)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Cached reads</div>
          <div className="stat-value">{fmt(session.cacheReadTokens)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Model spend</div>
          <div className="stat-value">{formatUsd(totalCost)}</div>
        </div>
      </div>

      <div className={styles.actions}>
        <a className={styles.promote} href={`/api/evals/promote/${encodeURIComponent(session.id)}`}>
          Promote to eval
        </a>
        <span className={`faint ${styles.actionNote}`}>
          {failedTurn
            ? "This session failed — promoting it gives you the regression test for the bug."
            : "Downloads a draft evals/*.eval.ts replaying this session's real messages."}
        </span>
      </div>

      {/* Its own row, not part of .actions: promoting downloads a file, while
          replaying starts a real run that re-executes this session's tools. The
          two do not belong side by side as if they were the same weight of
          decision, and the panel expands when opened. */}
      <div className={styles.forkSlot}>
        <ForkPanel sessionId={session.id} />
      </div>

      <div className={styles.sectionHead}>
        <h2>Run tree</h2>
        <span className={styles.sectionNote}>
          {runs.length === 0
            ? "nothing recorded yet"
            : `${fmt(runs.length)} run${runs.length === 1 ? "" : "s"} under this session`}
        </span>
      </div>

      {roots.length === 0 ? (
        <div className="empty">
          <h2>No turns recorded</h2>
          <p>
            The session exists but nothing ran under it yet. Send it a message and this tree will
            fill in.
          </p>
        </div>
      ) : (
        <ul className={styles.tree}>
          {roots.map((node, i) => (
            <RunNode key={node.run.id} node={node} seq={i + 1} />
          ))}
        </ul>
      )}

      {anyUnpriced && (
        <p className={`faint ${styles.footnote}`}>
          Some models have no price configured, so their cost shows as —. Set{" "}
          <code>EVESTACK_PRICING</code> to price them.
        </p>
      )}
    </>
  );
}
