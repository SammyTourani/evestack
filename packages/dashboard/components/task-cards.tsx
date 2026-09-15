import { OutcomeBadge } from "./ui/badge";
import { stamp } from "@/lib/time";
import type { listTasks } from "@/lib/tasks";

export function TaskCards({
  tasks,
}: {
  tasks: Awaited<ReturnType<typeof listTasks>>["tasks"];
}) {
  return (
    <div className="task-cards">
      {tasks.map((task) => (
        <article className="task-card" key={task.id}>
          <div className="workspace-heading">
            <h3>
              <a href={`/chat?session=${encodeURIComponent(task.id)}`}>
                {task.title ?? "Untitled task"}
              </a>
            </h3>
            {task.outcome ? (
              <OutcomeBadge outcome={task.outcome} />
            ) : (
              <span className="page-sub">Outcome unavailable</span>
            )}
          </div>
          <p className="page-sub">
            {task.turnCount} turns ·{" "}
            {stamp(task.lastActivity, "minute", { year: true })} ·{" "}
            {task.costUsd === null
              ? "Cost unavailable"
              : `$${task.costUsd.toFixed(4)} recorded`}
            {task.unpricedTurns > 0
              ? ` · ${task.unpricedTurns} unpriced turns`
              : ""}
          </p>
          <div className="workspace-actions">
            <a href={`/chat?session=${encodeURIComponent(task.id)}`}>
              Open workspace
            </a>
            <a href={`/sessions/${encodeURIComponent(task.id)}`}>
              Result evidence &amp; diagnostics
            </a>
          </div>
        </article>
      ))}
    </div>
  );
}
