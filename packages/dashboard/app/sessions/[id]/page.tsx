import { Badge, OutcomeBadge, type Outcome, type Tone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Placeholder } from "@/components/ui/feedback";
import { formatMetric } from "@/components/ui/format";
import { StatTile } from "@/components/ui/stat";
import { CONTROL } from "@/components/ui/style";
import { getSession, getSessionTree } from "@/lib/queries";
import { duration, stamp } from "@/lib/time";
import { listModelCalls, listToolCalls, type ModelCall, type ToolCall } from "@/lib/traces";
import { DatabaseError } from "@/app/db-error";

import {
  buildTimeline,
  buildWaterfall,
  flattenTimeline,
  listSteps,
  listToolCallFacts,
  listTurnFacts,
  type StepRow,
  type TimelineNode,
  type ToolCallRow,
  type TurnFact,
} from "./data";
import { ForkPanel } from "./fork-client";
import { Timeline } from "./timeline";
import { TurnPane } from "./turn-pane";

export const dynamic = "force-dynamic";

/**
 * The page you live in.
 *
 * Three panes, left to right and top to bottom: the session's turns as a
 * timeline, the selected turn's facts and waterfall, and its transcript. Which
 * turn is selected is `?turn=`, not client state — see `timeline.tsx`.
 *
 * Two numbers on this page are traps, and both are handled rather than avoided.
 * A session's wall-clock span is NOT a latency: `$eve.type = 'session'` stays
 * `running` until eve times it out, so a session someone left open overnight
 * measures the human. lib/monitors.ts says so at length and it is why the stat
 * strip leads with the sum of TURN durations and the wall clock is a
 * parenthetical in the meta line. And span-derived numbers are missing on four
 * turns in five, so every one of them is labelled with what it was computed
 * over rather than rendered as a confident zero.
 */

interface PageData {
  readonly session: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  readonly tree: TimelineNode[];
  readonly flat: TimelineNode[];
  readonly stepsByRun: ReadonlyMap<string, StepRow[]>;
  readonly toolsByRun: ReadonlyMap<string, ToolCallRow[]>;
  readonly modelCallsByTurn: ReadonlyMap<string, ModelCall[]>;
  readonly toolPayloads: ReadonlyMap<string, ToolCall>;
}

async function load(id: string): Promise<PageData | null> {
  const [session, rows] = await Promise.all([getSession(id), getSessionTree(id)]);
  if (!session) return null;

  const facts = await listTurnFacts(session.id);
  const tree = buildTimeline(rows, session.id, facts);
  const flat = flattenTimeline(tree);
  const runIds = flat.map((node) => node.run.id);

  const [stepsByRun, toolsByRun] = await Promise.all([
    listSteps(runIds),
    listToolCallFacts(runIds),
  ]);

  // The span reads pull whole traces, so they are skipped entirely when the
  // fact layer already says no turn in this session has a span. That is the
  // common case — 1,552 of the seeded month's 1,922 turns — and it is the
  // difference between one indexed lookup and a scan of every trace the
  // session touched.
  const anySpans = flat.some((node) => node.fact && node.fact.spanCoverage !== "none");
  const [modelCalls, spanToolCalls] = anySpans
    ? await Promise.all([listModelCalls(session.id), listToolCalls(session.id)])
    : [[] as ModelCall[], [] as ToolCall[]];

  const modelCallsByTurn = new Map<string, ModelCall[]>();
  for (const call of modelCalls) {
    if (!call.turnId) continue;
    const list = modelCallsByTurn.get(call.turnId) ?? [];
    list.push(call);
    modelCallsByTurn.set(call.turnId, list);
  }

  return {
    session,
    tree,
    flat,
    stepsByRun,
    toolsByRun,
    modelCallsByTurn,
    toolPayloads: new Map(spanToolCalls.map((call) => [call.spanId, call])),
  };
}

/**
 * `workflow_runs.status` is the engine's word, not `fact_turn.outcome`, so it
 * cannot go through `OutcomeBadge` — `completed` is not one of the seven
 * outcomes and would be a type error. An explicit map with a neutral default,
 * rather than interpolating the value into a class name, which is how an
 * unknown status renders as an unstyled pill nobody notices.
 */
const STATUS_TONE: Readonly<Record<string, Tone>> = {
  running: "info",
  completed: "neutral",
  failed: "err",
  errored: "err",
  cancelled: "neutral",
};

export default async function SessionDetailPage(props: PageProps<"/sessions/[id]">) {
  const [{ id }, search] = await Promise.all([props.params, props.searchParams]);

  let data: PageData | null;
  try {
    data = await load(id);
  } catch (error) {
    return <DatabaseError error={error} />;
  }

  if (!data) {
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

  const { session, flat, tree } = data;
  const facts = flat.map((node) => node.fact).filter((fact): fact is TurnFact => fact !== null);
  const turns = flat.filter((node) => node.run.type !== "subagent");
  const subagents = flat.length - turns.length;

  // Turn time, not session time. Subagents are excluded because a subagent runs
  // INSIDE its caller's turn — adding both counts the same seconds twice.
  const turnTimeMs = turns.reduce((sum, node) => sum + (node.fact?.durationMs ?? 0), 0);
  const inputTokens = facts.reduce((sum, fact) => sum + (fact.inputTokens ?? 0), 0);
  const outputTokens = facts.reduce((sum, fact) => sum + (fact.outputTokens ?? 0), 0);
  const spend = facts.reduce((sum, fact) => sum + (fact.costUsd ?? 0), 0);
  const unpricedTurns = facts.filter((fact) => fact.priced === false).length;
  const spannedTurns = facts.filter((fact) => fact.spanCoverage !== "none").length;
  const maxDurationMs = facts.reduce<number | null>(
    (max, fact) => (fact.durationMs === null ? max : Math.max(max ?? 0, fact.durationMs)),
    null,
  );

  const requested = typeof search.turn === "string" ? search.turn : null;
  const selected = flat.find((node) => node.run.id === requested) ?? flat[0];

  const wallClockMs =
    new Date(session.completedAt ?? Date.now()).getTime() - new Date(session.createdAt).getTime();

  return (
    <>
      <nav className="mb-2.5 flex items-center gap-2 text-small text-text-faint">
        <a href="/" className="text-text-dim hover:text-text">
          Sessions
        </a>
        <span>/</span>
        <span>this run</span>
      </nav>

      <h1 className="m-0 text-title font-medium text-text">
        {session.title ?? <span className="text-text-faint">Untitled session</span>}
      </h1>

      <div className="mt-2 mb-6 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-small text-text-dim">
        <Badge
          tone={STATUS_TONE[session.status] ?? "neutral"}
          title="eve keeps the session run open until it times out, so an idle session reads as running."
        >
          {session.status}
        </Badge>
        {session.trigger && (
          <span>
            trigger <span className="font-mono">{session.trigger}</span>
          </span>
        )}
        <span title={session.createdAt}>started {stamp(session.createdAt, "second")}</span>
        {/* Wall clock, deliberately small and deliberately not called latency.
            An open session's span is the time a person has had the tab open. */}
        <span
          title={
            session.completedAt
              ? "Wall clock between the session opening and closing, including the time it sat idle between turns."
              : "This session has not closed. eve leaves the session run open until it times out, so this is how long the tab has been open, not how long the agent worked."
          }
        >
          {session.completedAt
            ? `open ${duration(wallClockMs)} end to end`
            : wallClockMs >= 0
              ? `open ${duration(wallClockMs)} so far`
              : "still open"}
        </span>
        <span className="font-mono text-text-faint break-all">{session.id}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Turns" value={turns.length} unit="count" />
        <StatTile label="Turn time" value={turnTimeMs} unit="duration" />
        <StatTile label="Tokens in" value={inputTokens} unit="tokens" />
        <StatTile label="Tokens out" value={outputTokens} unit="tokens" />
        {/* `$0.00` on a session where nothing could be priced would read as
            free. It is only a real zero when at least one turn WAS priced, or
            when no turn had a model to price in the first place. */}
        <StatTile
          label="Spend"
          value={spend}
          unit="cost"
          priced={facts.some((fact) => fact.priced === true) || unpricedTurns === 0}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-small text-text-dim">
        <OutcomeMix facts={facts} />
        {subagents > 0 && (
          <span>
            {subagents} subagent run{subagents === 1 ? "" : "s"}, nested below their caller
          </span>
        )}
      </div>

      {unpricedTurns > 0 && (
        <p className="mt-2 mb-0 text-small text-warn">
          {unpricedTurns} turn{unpricedTurns === 1 ? "" : "s"} ran on a model with no configured
          price, so {unpricedTurns === 1 ? "its" : "their"} spend is not in that total — it is
          unknown, not zero. Set <code>EVESTACK_PRICING</code> to price{" "}
          {unpricedTurns === 1 ? "it" : "them"}.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <a className={CONTROL} href={`/api/evals/promote/${encodeURIComponent(session.id)}`}>
          Promote to eval
        </a>
        <span className="text-small text-text-faint">
          {facts.some((fact) => fact.outcome === "failed" || fact.outcome === "no_model_call")
            ? "This session has a failed turn — promoting it gives you the regression test for the bug."
            : "Downloads a draft evals/*.eval.ts replaying this session's real messages."}
        </span>
      </div>

      {/* Its own row, not beside Promote: promoting downloads a file, while
          replaying starts a real run that re-executes this session's tools. */}
      <div className="mt-2.5 mb-6">
        <ForkPanel sessionId={session.id} />
      </div>

      {flat.length === 0 || selected === undefined ? (
        <Card title="Timeline">
          <Placeholder
            title="No turns recorded"
            detail="The session exists but nothing has run under it yet. Send it a message and this fills in."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <Card
            title="Timeline"
            description={coverageCaption(spannedTurns, facts.length)}
            className="lg:sticky lg:top-4"
          >
            <Timeline
              nodes={tree}
              selectedId={selected.run.id}
              maxDurationMs={maxDurationMs}
              sessionId={session.id}
            />
          </Card>

          <TurnPane
            node={selected}
            total={turns.length}
            waterfall={buildWaterfall(
              {
                startedAt: selected.fact?.startedAt ?? selected.run.startedAt,
                durationMs: selected.fact?.durationMs ?? selected.run.durationMs,
              },
              data.stepsByRun.get(selected.run.id) ?? [],
              data.toolsByRun.get(selected.run.id) ?? [],
              data.modelCallsByTurn.get(selected.run.id) ?? [],
            )}
            toolCalls={data.toolsByRun.get(selected.run.id) ?? []}
            modelCalls={data.modelCallsByTurn.get(selected.run.id) ?? []}
            toolPayloads={data.toolPayloads}
            requestedMissing={requested !== null && requested !== selected.run.id}
          />
        </div>
      )}
    </>
  );
}

/**
 * How many turns the span-derived numbers actually cover.
 *
 * `coverageNote()` in components/ui/format.ts is the same sentence for a
 * metric, but this is a caption on a pane rather than a caveat under a value,
 * and it has to say something in the full case too — "all of them" is the
 * answer to a question the reader is about to ask about every TTFT below.
 */
function coverageCaption(spanned: number, total: number): string {
  if (total === 0) return "";
  // "Runs", not "turns": this pane lists subagent runs too, so its denominator
  // is deliberately a different number from the `Turns` tile above it. Calling
  // both of them turns is how a reader concludes the tile is wrong.
  if (spanned === 0) return `No spans on any of the ${total} runs; steps and costs are complete.`;
  if (spanned === total) return `Spans on all ${total} runs.`;
  return `Spans on ${spanned} of ${total} runs — the rest have steps and costs only.`;
}

function OutcomeMix({ facts }: { facts: readonly TurnFact[] }) {
  const counts = new Map<Outcome, number>();
  for (const fact of facts) counts.set(fact.outcome, (counts.get(fact.outcome) ?? 0) + 1);
  if (counts.size === 0) return null;
  return (
    <span
      className="flex flex-wrap items-center gap-2"
      title="Every run under this session — turns and subagent runs alike."
    >
      {[...counts].map(([outcome, count]) => (
        <span key={outcome} className="flex items-baseline gap-1">
          <OutcomeBadge outcome={outcome} />
          <span className="tabular-nums">{formatMetric(count, "count")}</span>
        </span>
      ))}
    </span>
  );
}
