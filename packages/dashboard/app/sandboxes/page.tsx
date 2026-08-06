import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Placeholder } from "@/components/ui/feedback";
import { FOCUS_RING } from "@/components/ui/style";
import { query } from "@/lib/db";
import {
  concerns,
  listSandboxes,
  ORPHAN_AFTER_MS,
  type Sandbox,
  type SandboxConcern,
} from "@/lib/sandboxes";
import { duration, stamp } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * The containers eve is running right now.
 *
 * A hosted dashboard cannot ship this page. Agent Runs can tell you a tool call
 * happened; it cannot tell you the container that ran it is still alive forty
 * minutes later with the network open, because that is only knowable from the
 * machine. This is the clearest thing self-hosting buys, and until now nothing
 * in evestack looked.
 *
 * ── Three states that are not "no sandboxes" ─────────────────────────────────
 *
 * The empty page is the one that has to be careful, because "nothing is
 * running" and "I cannot see" render identically if you are lazy about it, and
 * they are opposite answers to "is my agent leaking containers":
 *
 *   disabled     the socket was never mounted. Not an error — the default.
 *   unreachable  a path was given and the daemon did not answer.
 *   ok, empty    we looked and there really is nothing.
 *
 * A fourth is invisible from here: `@evestack/sandbox-opensandbox` is a
 * supported backend with no containers at all, so "ok, empty" is also what a
 * correctly-working opensandbox install looks like. The empty state says so
 * rather than implying the agent is idle.
 */

/** Bytes, in the unit a human reading a container list thinks in. */
function bytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function cpu(fraction: number | null): string {
  // Null is "not measurable yet", which happens on the first sample after a
  // container starts. Rendering 0% there would say the thing is idle.
  if (fraction === null) return "—";
  return `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`;
}

const CONCERN_TEXT: Record<SandboxConcern["kind"], { label: string; detail: string }> = {
  networked: {
    label: "network open",
    detail:
      "This sandbox is not on `none`, so code running inside it can reach the network. eve isolates a sandbox by default; something set this one differently.",
  },
  orphaned: {
    label: "long-lived",
    detail:
      "Up for over an hour. eve keeps one container per session and applies no idle timeout, so a sandbox whose conversation ended stays running until something stops it.",
  },
  "session-gone": {
    label: "session gone",
    detail:
      "The session this container names is not in the database. The container outlived its run row, which is how they accumulate unnoticed.",
  },
};

function SandboxRow({ sandbox, flags }: { sandbox: Sandbox; flags: readonly SandboxConcern[] }) {
  const running = sandbox.state === "running";
  const mine = flags.filter((f) => f.sandbox.id === sandbox.id);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-body text-text">{sandbox.name}</span>
          <Badge tone={running ? "ok" : "neutral"}>{sandbox.state}</Badge>
          {mine.map((f) => (
            <Badge
              key={f.kind}
              tone={f.kind === "networked" ? "err" : "warn"}
              title={CONCERN_TEXT[f.kind].detail}
            >
              {CONCERN_TEXT[f.kind].label}
            </Badge>
          ))}
        </div>
        <span className="font-mono text-small text-text-dim">
          {running && sandbox.uptimeMs !== null ? `up ${duration(sandbox.uptimeMs)}` : sandbox.status}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-small sm:grid-cols-4">
        <div>
          <dt className="text-text-dim">session</dt>
          <dd className="m-0 font-mono">
            {sandbox.sessionId === null ? (
              <span className="text-text-faint">—</span>
            ) : (
              <a
                className={`text-accent hover:underline ${FOCUS_RING}`}
                href={`/sessions/${sandbox.sessionId}`}
              >
                {sandbox.sessionId.slice(0, 18)}…
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-text-dim">network</dt>
          <dd
            className={`m-0 font-mono ${sandbox.networkMode !== null && sandbox.networkMode !== "none" ? "text-err" : ""}`}
          >
            {sandbox.networkMode ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-text-dim">agent</dt>
          <dd className="m-0 font-mono">{sandbox.agent ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-text-dim">channel</dt>
          <dd className="m-0 font-mono">{sandbox.channel ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-text-dim">cpu</dt>
          <dd className="m-0 font-mono">{cpu(sandbox.stats?.cpu ?? null)}</dd>
        </div>
        <div>
          <dt className="text-text-dim">memory</dt>
          <dd className="m-0 font-mono">
            {bytes(sandbox.stats?.memoryBytes ?? null)}
            {sandbox.stats?.memoryLimitBytes ? (
              <span className="text-text-faint"> / {bytes(sandbox.stats.memoryLimitBytes)}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-text-dim">net i/o</dt>
          <dd className="m-0 font-mono">
            {bytes(sandbox.stats?.networkRxBytes ?? null)}
            <span className="text-text-faint"> / </span>
            {bytes(sandbox.stats?.networkTxBytes ?? null)}
          </dd>
        </div>
        <div>
          <dt className="text-text-dim">started</dt>
          <dd className="m-0 font-mono">
            {sandbox.startedAt === null ? "—" : stamp(sandbox.startedAt, "minute")}
          </dd>
        </div>
      </dl>

      <p className="mt-3 mb-0 font-mono text-micro text-text-faint">
        {sandbox.image}
        {sandbox.templateKey === null ? null : ` · template ${sandbox.templateKey}`}
        {sandbox.role === null ? null : ` · role ${sandbox.role}`}
      </p>
    </Card>
  );
}

export default async function SandboxesPage() {
  const result = await listSandboxes();

  if (result.kind === "disabled") {
    return (
      <>
        <h1>Sandboxes</h1>
        <Placeholder
          tone="empty"
          title="Sandbox visibility is off"
          detail="Set EVESTACK_DOCKER_SOCKET to your Docker socket to see the containers eve is running. It is off by default on purpose: a process that can talk to the Docker socket can start a container with the host filesystem mounted, which makes it root-equivalent on this machine. Nothing here writes — lifecycle actions need EVESTACK_DOCKER_LIFECYCLE as well."
        />
      </>
    );
  }

  if (result.kind === "unreachable") {
    return (
      <>
        <h1>Sandboxes</h1>
        <Placeholder
          tone="error"
          title="Docker did not answer"
          detail={`EVESTACK_DOCKER_SOCKET is set, but the daemon could not be reached: ${result.reason}. This page cannot tell you whether sandboxes are running, which is not the same as there being none.`}
        />
      </>
    );
  }

  const { sandboxes } = result;

  // Which of the named sessions still exist. One query, not one per container:
  // the whole point of the "session gone" flag is that it is cheap enough to
  // compute for every row.
  const ids = [...new Set(sandboxes.map((s) => s.sessionId).filter((v): v is string => v !== null))];
  let known = new Set<string>();
  if (ids.length > 0) {
    try {
      const rows = await query<{ id: string }>(
        `SELECT id FROM workflow.workflow_runs WHERE id = ANY($1::text[])`,
        [ids],
      );
      known = new Set(rows.map((r) => r.id));
    } catch {
      // The database being down must not turn every container into an orphan.
      // Leaving `known` empty would flag all of them; instead treat every named
      // session as present and lose only that one flag.
      known = new Set(ids);
    }
  }

  const flags = concerns(sandboxes, known);
  const running = sandboxes.filter((s) => s.state === "running").length;

  return (
    <>
      <h1>Sandboxes</h1>
      <p className="page-sub">
        The containers eve is running on this machine, read from your own Docker daemon. A hosted
        dashboard cannot show you this.
      </p>

      {sandboxes.length === 0 ? (
        <Placeholder
          tone="empty"
          title="No sandbox containers"
          detail="Nothing on this machine carries eve's sandbox label. That means either no agent has needed a sandbox yet, or this install uses a non-Docker backend — @evestack/sandbox-opensandbox runs no containers at all, and looks exactly like this."
        />
      ) : (
        <>
          <p className="mb-4 text-small text-text-dim">
            {running} running, {sandboxes.length - running} stopped.
            {flags.length === 0
              ? " Nothing needs attention."
              : ` ${flags.length} thing${flags.length === 1 ? "" : "s"} worth a look, flagged below.`}{" "}
            A sandbox is called long-lived after {duration(ORPHAN_AFTER_MS)}, because eve keeps one
            container per session and never times one out.
          </p>
          <div className="flex flex-col gap-3">
            {sandboxes.map((s) => (
              <SandboxRow key={s.id} sandbox={s} flags={flags} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
