import { listTasks } from "@/lib/tasks";
import { parseSessionCursor } from "@/lib/queries";
import { TaskCards } from "@/components/task-cards";
import { DatabaseError } from "@/app/db-error";

export const dynamic = "force-dynamic";
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cursor?: string }>;
}) {
  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q.slice(0, 200) : "";
  let cursor = null;
  try {
    cursor = params.cursor ? parseSessionCursor(params.cursor) : null;
  } catch {
    return (
      <p>
        That page link is invalid. <a href="/tasks">Return to Tasks</a>.
      </p>
    );
  }
  let result;
  try {
    result = await listTasks(30, cursor, search);
  } catch (error) {
    return <DatabaseError error={error} />;
  }
  return (
    <>
      <div className="workspace-heading">
        <div>
          <h1>Tasks</h1>
          <p className="page-sub">Your requests, results and next steps.</p>
        </div>
        <a className="primary-action" href="/chat">
          New task
        </a>
      </div>
      <div className="workspace-actions">
        <a href="/approvals">Pending decisions &amp; history</a>
        <a href="/sessions">Detailed table &amp; export</a>
      </div>
      <form className="workspace-search" action="/tasks">
        <label htmlFor="task-search">Search all task titles and IDs</label>
        <div className="workspace-actions">
          <input
            id="task-search"
            name="q"
            defaultValue={search}
            maxLength={200}
            placeholder="Repository brief…"
          />
          <button type="submit">Search</button>
        </div>
      </form>
      {result.tasks.length ? (
        <TaskCards tasks={result.tasks} />
      ) : (
        <section className="workspace-section">
          <h2>{search ? "No matching tasks" : "Start with one useful task"}</h2>
          <p>
            Ask for a repository maintenance brief, then review the sources
            before scheduling it.
          </p>
          <a href="/chat">Write your first request</a>
        </section>
      )}
      {result.nextCursor && (
        <a
          className="primary-action"
          href={`/tasks?${new URLSearchParams({ q: search, cursor: result.nextCursor })}`}
        >
          Older tasks
        </a>
      )}
    </>
  );
}
