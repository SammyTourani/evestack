import { listRegressionCases } from "@/lib/regressions";
import { DatabaseError } from "@/app/db-error";
export const dynamic = "force-dynamic";
export default async function RegressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string }>;
}) {
  const raw = Number((await searchParams).offset ?? 0);
  const offset =
    Number.isSafeInteger(raw) && raw >= 0 && raw <= 1000000 ? raw : 0;
  let data;
  try {
    data = await listRegressionCases(offset);
  } catch (error) {
    return <DatabaseError error={error} />;
  }
  return (
    <>
      <div className="workspace-heading">
        <div>
          <h1>Regression cases</h1>
          <p className="page-sub">
            Save what should change, then compare a later task with the original
            evidence.
          </p>
        </div>
        <a className="primary-action" href="/regressions/new">
          Save a correction
        </a>
      </div>
      <p>
        These are versioned cases and manual observations. They do not run a
        test or execute tools. Use <a href="/evals">regression drafts</a> to
        prepare an executable eval after reviewing its assertions and
        environment.
      </p>
      {data.cases.length === 0 ? (
        <section className="workspace-section">
          <h2>No saved cases in this view</h2>
          <p>
            Open a task that needs correction and save the expected behavior
            with its evidence.
          </p>
          <a href="/tasks">Choose a task</a>
        </section>
      ) : (
        <div className="task-cards">
          {data.cases.map((item) => (
            <section key={item.case_id} className="workspace-section">
              <h2>
                <a href={`/regressions/${item.case_id}`}>{item.title}</a>
              </h2>
              <p>
                Revision {item.revision} ·{" "}
                <a
                  href={`/chat?session=${encodeURIComponent(item.baseline_session_id)}`}
                >
                  Original task
                </a>
              </p>
              <p className="page-sub">
                Open the case to inspect manual observations for its exact
                revision.
              </p>
            </section>
          ))}
        </div>
      )}
      <div className="workspace-actions">
        {offset > 0 && <a href="/regressions">Newest cases</a>}
        {data.nextOffset !== null && (
          <a href={`/regressions?offset=${data.nextOffset}`}>Older cases</a>
        )}
      </div>
    </>
  );
}
