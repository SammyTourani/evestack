import { DatabaseUnavailableError, describeDbError } from "@/lib/db";
import { listMemories } from "@/lib/memories";
import { MemoryList } from "./memory-client";
import styles from "./memory.module.css";

export const dynamic = "force-dynamic";

/**
 * What the agent believes, and the ability to take a belief away.
 *
 * The search box is a plain text match, not a semantic one — see lib/memories.ts
 * for why that is the right call rather than a shortcut.
 */
export default async function MemoryPage(props: PageProps<"/memory">) {
  const params = await props.searchParams;
  const search = typeof params.q === "string" ? params.q : undefined;

  let page: Awaited<ReturnType<typeof listMemories>>;
  try {
    page = await listMemories({ ...(search ? { search } : {}), limit: 200 });
  } catch (error) {
    const unavailable = error instanceof DatabaseUnavailableError;
    return (
      <div className="empty">
        <h2>{unavailable ? "Database unreachable" : "Could not read memories"}</h2>
        <p>{describeDbError(error)}</p>
      </div>
    );
  }

  return (
    <>
      <h1>Memory</h1>
      <p className={styles.sub}>
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
            <MemoryList rows={page.rows} />
          )}
        </>
      )}
    </>
  );
}
