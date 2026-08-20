import { DatabaseError } from "@/app/db-error";
import { describeDbError } from "@/lib/db";
import { type ApproverIdentity } from "@/lib/approvals";
import { listMemories, listMemoryDeletions, type MemoryDeletionRow } from "@/lib/memories";
import { stamp } from "@/lib/time";
import { MemoryList } from "./memory-client";
import { deletionsNote, MEMORY_DELETIONS_LIMIT, MEMORY_PAGE_LIMIT } from "./truncation";
import styles from "./memory.module.css";

export const dynamic = "force-dynamic";

/**
 * How the deleter is named, in the same vocabulary as /approvals.
 *
 * `actor_via` records how the name was obtained, and the distinction is the
 * whole value of the column: a proxy-supplied header is worth exactly as much
 * as the proxy in front of it, and evestack's own credential is one shared
 * secret per deployment, so it names a stack rather than a person. Rendering
 * `actor` alone would quietly promote all three to "a proven human".
 *
 * `via` widens to `string` coming out of Postgres, so a row written by an older
 * build can carry a value this function has never seen. Those fall through to
 * the raw string rather than being relabelled — inventing a category for an
 * unknown one is how an audit trail starts lying.
 */
const DELETER_LABEL: Record<ApproverIdentity["via"], string> = {
  session: "signed in",
  basic: "basic auth",
  header: "via proxy",
  "forwarded-user": "via proxy",
  "forwarded-email": "via proxy",
  unidentified: "unidentified",
};

function deleter(row: MemoryDeletionRow): string {
  if (!row.actor) return "unidentified";
  // A MAP KEYED BY THE UNION, not a chain of string comparisons, and the
  // difference is not style.
  //
  // The chain this replaces handled `session`, `basic` and `forwarded-*`, and
  // dropped `header` through to the raw value — so a name supplied by a proxy
  // header rendered as `alice (header)`: jargon, and worse, no proxy warning at
  // all. sql/memory-audit.sql:31-34 names `header` in the vocabulary this
  // column is allowed to hold and says outright never to let a proxy-supplied
  // name be mistaken for a proven one.
  //
  // Two properties come from the map that the chain could not give:
  //
  //  - It fails CLOSED. An unknown `via` reads as `unidentified` rather than as
  //    an attributed human, matching app/approvals/page.tsx:57. Falling through
  //    to the raw string was the opposite: the least trustworthy case rendered
  //    as the most specific one.
  //  - `Record<ApproverIdentity["via"], …>` makes the compiler enforce
  //    completeness, so a value added to the union cannot silently miss this
  //    table. approvals/page.tsx:21 carries the same guard, added there after
  //    exactly this bug shipped once already with `session`.
  return `${row.actor} (${DELETER_LABEL[row.actorVia as ApproverIdentity["via"]] ?? "unidentified"})`;
}

/**
 * What the agent believes, and the ability to take a belief away.
 *
 * The search box is a plain text match, not a semantic one — see lib/memories.ts
 * for why that is the right call rather than a shortcut.
 *
 * THE "RECENTLY DELETED" SECTION IS NOT DECORATION. Every delete made here
 * writes a row to `evestack.memory_deletions` (the INSERT at lib/memories.ts:141), and until
 * this section existed nothing in the product read one back: `listMemoryDeletions`
 * had zero callers, so the trail was write-only and reachable solely through
 * `psql`. An audit trail no one can read is not a weaker compliance surface than
 * one they can — it is not a compliance surface at all, because the question it
 * exists to answer ("why does the agent no longer know that?") still gets a
 * shrug. This is the smallest thing that makes it real.
 */
export default async function MemoryPage(props: PageProps<"/memory">) {
  const params = await props.searchParams;
  const search = typeof params.q === "string" ? params.q : undefined;

  let page: Awaited<ReturnType<typeof listMemories>>;
  try {
    // The constant, not a literal: ./truncation.ts quotes this same number back
    // to the reader as "showing the most recent N", and the two drifting apart
    // would turn an honest footnote into a specific lie.
    page = await listMemories({ ...(search ? { search } : {}), limit: MEMORY_PAGE_LIMIT });
  } catch (error) {
    return <DatabaseError error={error} />;
  }

  /*
   * Read in its own try, and NOT allowed to take the page down with it.
   *
   * Two reasons this is not folded into the try above. First, the memories are
   * what the reader came for; failing the whole page because an audit table
   * could not be read would trade the useful answer for the secondary one.
   * Second, `listMemoryDeletions` calls `ensureMemoryAuditSchema`, which
   * executes sql/memory-audit.sql — guarded and idempotent, but still DDL, so a
   * deployment whose Postgres role cannot CREATE will throw here and nowhere
   * else on this page.
   *
   * The failure is REPORTED rather than swallowed. Rendering an empty
   * "Recently deleted" list after a failed read would say "nothing was ever
   * deleted" when the truth is "I could not look" — the exact substitution
   * contract 22 exists to stop, applied to the one table on this page whose
   * whole purpose is to be believed.
   *
   * The trail is read whether or not `evestack.memories` exists, on purpose:
   * the audit rows keep the deleted content verbatim (sql/memory-audit.sql:9)
   * and are meant to outlive the memories they describe, so a dropped or
   * not-yet-created memories table must not hide them.
   */
  let deletions: MemoryDeletionRow[] = [];
  let deletionsError: string | null = null;
  try {
    deletions = await listMemoryDeletions(MEMORY_DELETIONS_LIMIT);
  } catch (error) {
    deletionsError = describeDbError(error);
  }
  const deletionsCap = deletionsNote(deletions.length, MEMORY_DELETIONS_LIMIT);

  return (
    <>
      <h1>Memory</h1>
      <p className="page-sub">
        Everything the agent has chosen to remember, in your Postgres. An agent with persistent
        memory can be quietly wrong forever — this is where you find out, and fix it.
      </p>

      {!page.tableExists ? (
        <div className="empty">
          <h2>No memory table yet</h2>
          <p>
            The agent creates <code>evestack.memories</code> the first time it calls{" "}
            <code>remember</code>. Ask it to remember something and this page fills in.
          </p>
        </div>
      ) : (
        <>
          <form className={styles.searchRow} method="get">
            <input
              className={styles.search}
              type="search"
              name="q"
              defaultValue={search ?? ""}
              placeholder="Search content and tags…"
              aria-label="Search memories"
            />
            <button className={styles.searchBtn} type="submit">
              Search
            </button>
            {search && (
              <a className={styles.clear} href="/memory">
                clear
              </a>
            )}
            <span className={`faint ${styles.count}`}>
              {page.total.toLocaleString("en-US")} {page.total === 1 ? "memory" : "memories"}
              {search ? " matching" : ""}
            </span>
          </form>

          {page.rows.length === 0 ? (
            <div className="empty">
              <h2>{search ? "Nothing matches that" : "Nothing remembered yet"}</h2>
              <p>
                {search
                  ? "Text search only — the agent's own recall is semantic and may still find it."
                  : "Ask the agent to remember something and it will appear here."}
              </p>
            </div>
          ) : (
            <MemoryList rows={page.rows} total={page.total} searching={Boolean(search)} />
          )}
        </>
      )}

      <section className={styles.audit} aria-labelledby="recently-deleted">
        <h2 className={styles.auditHead} id="recently-deleted">
          Recently deleted
        </h2>
        <p className={`faint ${styles.auditSub}`}>
          Deleting a memory is irreversible, so every delete made from this page is recorded in{" "}
          <code>evestack.memory_deletions</code> with the content it removed and who removed it.
          The agent&apos;s own <code>forget</code> tool is a different path and lands in{" "}
          <a href="/approvals">Approvals</a>.
        </p>

        {deletionsError !== null ? (
          /*
            "I could not look" — never rendered as an empty list. See the read above.
          */
          <p className={styles.auditError}>
            The deletion trail could not be read, so this section is not evidence that nothing was
            deleted. {deletionsError}
          </p>
        ) : deletions.length === 0 ? (
          <p className="faint">
            Nothing has been deleted from this page. The trail is kept from the first delete
            onwards.
          </p>
        ) : (
          <>
            <ul className={styles.auditList}>
              {deletions.map((row) => (
                <li key={row.id} className={styles.auditItem}>
                  <div className={styles.auditContent}>{row.content}</div>
                  <div className={styles.meta}>
                    <span className="mono">#{row.memoryId}</span>
                    <span className={styles.dot}>•</span>
                    <span title={row.deletedAt}>deleted {stamp(row.deletedAt, "second", { year: true })}</span>
                    <span className={styles.dot}>•</span>
                    <span
                      className={row.actorVia === "unidentified" ? styles.unattributed : undefined}
                      title={`actor_via = ${row.actorVia}`}
                    >
                      by {deleter(row)}
                    </span>
                    {row.tags.length > 0 && (
                      <span className={styles.tags}>
                        {row.tags.map((tag) => (
                          <span key={tag} className={styles.tag}>
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {deletionsCap && (
              <p className={`faint ${styles.note}`}>
                {deletionsCap} This list is capped, not the table:{" "}
                <code>evestack.memory_deletions</code> holds every deletion ever made here.
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
