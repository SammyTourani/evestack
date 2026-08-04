import { formatUsd, isPriced } from "@/lib/pricing";
import { getSession, getSessionTree, type TurnRow } from "@/lib/queries";
import styles from "./session.module.css";

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Wall-clock stamp for a run, not "3h ago".
 *
 * A drill-down wants the actual clock time of each turn, and relative time is
 * unreliable here: workflow_runs stores UTC in `timestamp without time zone`
 * columns, so pg hands back a bare string that `new Date()` reads as host-local.
 * Every timestamp therefore lands one UTC offset in the future and "ago" math
 * goes negative. Formatting the local components reverses that shift and prints
 * exactly what the database holds. See the note in the handoff — the fix belongs
 * in lib/queries.ts, which this page does not own.
 */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

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
            {run.model ?? <span className="faint">no model recorded</span>}
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
          <Metric label="Tools">{fmt(run.toolCount)}</Metric>
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
      <div className="empty">
        <h2>Can&apos;t reach the database</h2>
        <p className="dim">{error instanceof Error ? error.message : String(error)}</p>
        <p className="faint">
          The dashboard reads the same Postgres that stores your agent&apos;s sessions. Start it
          with <code>docker compose up postgres</code>.
        </p>
      </div>
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
