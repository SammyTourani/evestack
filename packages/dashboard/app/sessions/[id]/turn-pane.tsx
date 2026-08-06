import { Badge, OutcomeBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Placeholder } from "@/components/ui/feedback";
import { EM_DASH, formatCost, formatMetric } from "@/components/ui/format";
import { StatTile } from "@/components/ui/stat";
import { duration, stamp } from "@/lib/time";
import type { ModelCall, ToolCall } from "@/lib/traces";
import { MessagesBlock, PayloadBlock } from "@/app/traces/[id]/payload";

import type { TimelineNode, ToolCallRow, WaterfallRow } from "./data";

/**
 * One turn, in three parts: what it cost, what it did, and what was said.
 *
 * The rule the whole pane is built around is that the second part has to be
 * good with no spans at all. Spans are opt-in and retention-bounded — 1,552 of
 * the seeded month's 1,922 turns have none — so a page that draws its waterfall
 * from traces is a page that is blank for four turns in five. Steps come from
 * `workflow.workflow_steps`, which the engine always writes and which nothing
 * in this dashboard has ever read; model and tool bars are added on top where
 * they exist. What is missing is named, never left as a gap the reader has to
 * interpret.
 */

export interface TurnPaneProps {
  readonly node: TimelineNode;
  readonly total: number;
  readonly waterfall: readonly WaterfallRow[];
  readonly toolCalls: readonly ToolCallRow[];
  /** Span-side model calls for this turn: the prompts and completions. */
  readonly modelCalls: readonly ModelCall[];
  /** Span-side tool calls, by span id, for their arguments and results. */
  readonly toolPayloads: ReadonlyMap<string, ToolCall>;
  /** True when the id in `?turn=` matched nothing and this is the fallback. */
  readonly requestedMissing: boolean;
}

export function TurnPane({
  node,
  total,
  waterfall,
  toolCalls,
  modelCalls,
  toolPayloads,
  requestedMissing,
}: TurnPaneProps) {
  const { run, fact } = node;
  const isSubagent = run.type === "subagent";
  const title = isSubagent
    ? `Subagent ${run.subagent && run.subagent !== "__root__" ? run.subagent : "run"}`
    : `Turn ${node.seq ?? "?"} of ${total}`;

  return (
    <div className="flex flex-col gap-4">
      {requestedMissing && (
        <p className="m-0 text-small text-warn">
          No such turn in this session — showing the first one instead. The link may point at a run
          that has been pruned.
        </p>
      )}

      <Card
        title={
          <span className="flex flex-wrap items-baseline gap-2">
            {title}
            {fact ? <OutcomeBadge outcome={fact.outcome} /> : null}
          </span>
        }
        description={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono">{fact?.model ?? run.model ?? "no model recorded"}</span>
            {fact?.priced === false && (
              <Badge tone="warn" title="No price is configured for this model, so its spend is unknown — not zero.">
                unpriced
              </Badge>
            )}
            {fact?.environment && <span>env {fact.environment}</span>}
            <span title={run.startedAt ?? run.createdAt}>
              started {stamp(fact?.startedAt ?? run.startedAt ?? run.createdAt, "second")}
            </span>
            <span className="font-mono text-text-faint">{run.id}</span>
          </span>
        }
      >
        <TurnFacts node={node} />
      </Card>

      <Card
        title="Waterfall"
        headingLevel={3}
        // No caption when there is nothing to caption: the placeholder inside
        // says why, and two sentences saying the same thing read as two
        // different problems.
        description={waterfall.length === 0 ? undefined : waterfallCaption(waterfall)}
      >
        <Waterfall rows={waterfall} subagent={isSubagent} />
      </Card>

      <Card title="Transcript" headingLevel={3}>
        <Transcript
          node={node}
          modelCalls={modelCalls}
          toolCalls={toolCalls}
          toolPayloads={toolPayloads}
        />
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* facts                                                                      */
/* -------------------------------------------------------------------------- */

function TurnFacts({ node }: { node: TimelineNode }) {
  const { run, fact } = node;
  if (!fact) {
    return (
      <Placeholder
        title="No fact row for this run yet"
        detail={
          <>
            The run exists in <code>workflow.workflow_runs</code> but the fact refresh has not
            reached it. It normally takes one page load. Duration was {duration(run.durationMs)}.
          </>
        }
      />
    );
  }

  const spanned = fact.spanCoverage !== "none";
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Duration" value={fact.durationMs} unit="duration" />
        <StatTile label="Time to first chunk" value={fact.ttftMs} unit="duration" />
        <StatTile
          label="Output rate"
          value={fact.outputTokensPerSecond}
          unit="tokens_per_second"
        />
        <StatTile
          label="Cost"
          value={fact.costUsd}
          unit="cost"
          // `priced === null` is a turn that never reached a model: there is
          // nothing to price, and calling that "Unpriced" would blame the
          // pricing catalog for an absent model call. The tile renders an em
          // dash for a null value under `priced: true`.
          priced={fact.priced !== false}
        />
      </div>

      {/* One sentence rather than a caveat per tile. Which numbers came from
          spans is a property of the turn, and repeating it four times reads as
          four different warnings. */}
      <p className="mt-3 mb-0 text-small text-text-dim">
        {spanned
          ? `Spans landed for this turn (${fact.spanCoverage} coverage), so time to first chunk, time per output chunk and the tool calls below are measured.`
          : "No spans were exported for this turn, so time to first chunk, time per output chunk and the count of tool calls are unknown — not zero. Duration, tokens, cost, steps and retries below come from the run row and the workflow engine, and are complete."}
      </p>

      <dl className="mt-4 mb-0 grid grid-cols-2 gap-x-6 gap-y-2 text-small sm:grid-cols-3">
        <Fact label="Tokens in">{formatMetric(fact.inputTokens, "tokens")}</Fact>
        <Fact label="Tokens out">{formatMetric(fact.outputTokens, "tokens")}</Fact>
        <Fact label="Cache read">{formatMetric(fact.cacheReadTokens, "tokens")}</Fact>
        <Fact label="Cache write">{formatMetric(fact.cacheWriteTokens, "tokens")}</Fact>
        <Fact label="Time per output chunk">{formatMetric(fact.timePerOutputChunkMs, "duration")}</Fact>
        <Fact label="Finish reason">{fact.finishReason ?? EM_DASH}</Fact>
        <Fact label="Steps">{formatMetric(fact.stepCount, "count")}</Fact>
        <Fact
          label="Retries"
          title="Attempts past the first, summed over this turn's engine steps."
        >
          {fact.retryCount === null ? (
            EM_DASH
          ) : fact.retryCount > 0 ? (
            <span className="text-warn">{formatMetric(fact.retryCount, "count")}</span>
          ) : (
            "0"
          )}
        </Fact>
        <Fact
          label="Tools offered / called"
          title="Offered is the size of the tool registry eve handed the model — capacity, not activity. Called is counted from spans, so it is unknown rather than zero when none landed."
        >
          {formatMetric(fact.toolsOffered, "count")}
          <span className="px-1 text-text-faint">/</span>
          {fact.toolsCalled === null ? (
            <span title="No spans for this turn, so tool calls cannot be counted">{EM_DASH}</span>
          ) : (
            formatMetric(fact.toolsCalled, "count")
          )}
        </Fact>
      </dl>

      <CostSplit fact={fact} />

      {(fact.errorCode || fact.error) && (
        <p className="mt-4 mb-0 rounded-md border border-[color-mix(in_srgb,var(--err)_40%,transparent)] px-3 py-2 text-small text-err">
          <span className="font-mono">{fact.errorCode ?? "error"}</span>
          {fact.error ? ` — ${fact.error}` : null}
        </p>
      )}
    </>
  );
}

/**
 * Where the money went, decomposed the way `fact_turn` stores it.
 *
 * Rendered only for a priced turn. On an unpriced one every component is NULL,
 * and four em dashes under a "Cost" heading invite the reader to add them up to
 * zero — the tile above already says `Unpriced`, which is the whole answer.
 */
function CostSplit({ fact }: { fact: NonNullable<TimelineNode["fact"]> }) {
  if (fact.priced !== true) return null;
  const parts = [
    { label: "input", value: fact.costInputUsd },
    { label: "output", value: fact.costOutputUsd },
    { label: "cache read", value: fact.costCacheReadUsd },
    { label: "cache write", value: fact.costCacheWriteUsd },
  ];
  return (
    <p className="mt-3 mb-0 flex flex-wrap gap-x-4 gap-y-1 text-small text-text-dim">
      {parts.map((part) => (
        <span key={part.label}>
          {part.label} <span className="tabular-nums text-text">{formatCost(part.value, true)}</span>
        </span>
      ))}
    </p>
  );
}

function Fact({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div title={title}>
      <dt className="text-micro uppercase tracking-[0.06em] text-text-faint">{label}</dt>
      <dd className="m-0 font-mono tabular-nums text-text">{children}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* waterfall                                                                  */
/* -------------------------------------------------------------------------- */

function waterfallCaption(rows: readonly WaterfallRow[]): string {
  const counts = {
    step: rows.filter((row) => row.kind === "step").length,
    model: rows.filter((row) => row.kind === "model").length,
    tool: rows.filter((row) => row.kind === "tool").length,
  };
  const retries = rows.filter((row) => row.attempt !== null && row.attempt > 1).length;
  const parts = [
    `${counts.step} engine step${counts.step === 1 ? "" : "s"}`,
    ...(retries > 0 ? [`${retries} of them retries`] : []),
    ...(counts.model > 0 ? [`${counts.model} model call${counts.model === 1 ? "" : "s"}`] : []),
    ...(counts.tool > 0 ? [`${counts.tool} tool call${counts.tool === 1 ? "" : "s"}`] : []),
  ];
  return `${parts.join(", ")}. Bars are positioned on this turn's own clock.`;
}

const KIND_BAR: Readonly<Record<WaterfallRow["kind"], string>> = {
  step: "bg-text-faint",
  model: "bg-accent",
  tool: "bg-chart-3",
};

function Waterfall({ rows, subagent }: { rows: readonly WaterfallRow[]; subagent: boolean }) {
  if (rows.length === 0) {
    return (
      <Placeholder
        title="Nothing to draw"
        detail={
          subagent
            ? // Verified on the seeded month: every subagent run has zero rows
              // in workflow_steps. The engine records the steps against the
              // turn that delegated, so the caller's waterfall is the one that
              // has them.
              "eve records no engine steps for a subagent run — its work sits inside the steps of the turn that delegated to it. Select that turn to see them."
            : "No engine steps, model calls or tool calls are recorded against this run."
        }
      />
    );
  }

  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((row) => (
        <li key={row.key} className="grid grid-cols-[3.5rem_9rem_1fr_4.5rem] items-center gap-2">
          {/* The kind is a word, not just a bar colour: three hues on a chart
              is a legend nobody read, and this is the row's whole identity. */}
          <span className="font-mono text-micro uppercase tracking-[0.06em] text-text-faint">
            {row.kind}
          </span>
          <span className="truncate text-small text-text" title={row.title ?? row.label}>
            {row.label}
            {row.attempt !== null && row.attempt > 1 && (
              <span className="ml-1.5 font-mono text-micro text-warn">try {row.attempt}</span>
            )}
          </span>
          <span
            aria-hidden="true"
            className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg"
          >
            {row.offsetPct !== null && row.widthPct !== null && (
              <span
                className={`absolute top-0 h-1.5 rounded-full ${row.failed ? "bg-err" : KIND_BAR[row.kind]}`}
                style={{ left: `${row.offsetPct}%`, width: `${row.widthPct}%` }}
              />
            )}
          </span>
          <span className="text-right font-mono text-small tabular-nums text-text-dim">
            {duration(row.durationMs)}
          </span>
          {row.detail && (
            <span className="col-start-2 col-end-5 text-small text-err">{row.detail}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* transcript                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What was actually said, when the spans carry it.
 *
 * Three states, and conflating any two of them is a lie about the agent:
 *
 *   no spans        nothing was exported for this turn. There is no transcript
 *                   and there is no way to get one after the fact.
 *   spans, no text  the export landed but carries timings only. eve's own
 *                   tracer writes `gen_ai.tool.call.arguments`; the AI SDK's
 *                   exported spans do not, and that is the common deployment.
 *                   `fact_tool_call.arguments_bytes` is NULL for exactly this.
 *   spans and text  the prompts, the completions and the tool payloads.
 *
 * The blocks themselves are `app/traces/[id]/payload.tsx`: the same clamping,
 * the same two message vocabularies, the same JSON-or-verbatim fallback. A
 * second renderer here would be a second set of rules for a 24 KB bash result.
 */
function Transcript({
  node,
  modelCalls,
  toolCalls,
  toolPayloads,
}: {
  node: TimelineNode;
  modelCalls: readonly ModelCall[];
  toolCalls: readonly ToolCallRow[];
  toolPayloads: ReadonlyMap<string, ToolCall>;
}) {
  if (node.fact?.spanCoverage === "none" || (modelCalls.length === 0 && toolCalls.length === 0)) {
    return (
      <Placeholder
        title="No transcript for this turn"
        detail={
          <>
            Prompts, completions and tool payloads live only on spans, and none were exported for
            this run. The waterfall above is the workflow engine&apos;s own record, which is always
            written. Turn on OTLP export to capture the rest — see{" "}
            <code>docs/observability.mdx</code>.
          </>
        }
      />
    );
  }

  const recorded =
    modelCalls.some(
      (call) => call.systemPrompt || call.promptMessages || call.responseText || call.responseToolCalls,
    ) ||
    toolCalls.some((call) => {
      const payload = toolPayloads.get(call.spanId);
      return Boolean(payload?.argumentsJson || payload?.resultJson);
    });

  if (!recorded) {
    return (
      <Placeholder
        title="Spans landed, but they carry timings only"
        detail={
          <>
            {modelCalls.length} model call{modelCalls.length === 1 ? "" : "s"} and {toolCalls.length}{" "}
            tool call{toolCalls.length === 1 ? "" : "s"} were exported for this turn with no message
            or payload attributes on them — no <code>gen_ai.input.messages</code>, no{" "}
            <code>gen_ai.tool.call.arguments</code>. The timings above are real; there is no text to
            show.
          </>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {modelCalls.map((call) => (
        <section key={call.spanId}>
          <h4 className="m-0 text-small text-text-dim">
            Model call{call.stepIndex !== null ? ` · step ${call.stepIndex}` : ""}
            {call.finishReason ? ` · ${call.finishReason}` : ""}
          </h4>
          <PayloadBlock label="System prompt" value={call.systemPrompt} />
          <MessagesBlock value={call.promptMessages} />
          <PayloadBlock label="Response" value={call.responseText} open />
          <PayloadBlock label="Tool calls requested" value={call.responseToolCalls} />
        </section>
      ))}

      {toolCalls.map((call) => {
        const payload = toolPayloads.get(call.spanId);
        return (
          <section key={call.spanId}>
            <h4 className="m-0 flex items-baseline gap-2 text-small text-text-dim">
              <span className="font-mono text-text">{call.name}</span>
              <span>{duration(call.durationMs)}</span>
              {call.ok ? null : (
                <Badge tone="err" title={call.errorMessage ?? undefined}>
                  failed
                </Badge>
              )}
            </h4>
            <PayloadBlock
              label="Arguments"
              value={payload?.argumentsJson ?? null}
              absent={call.argumentsBytes === null ? "not recorded by the exporter" : "not recorded"}
            />
            <PayloadBlock
              label="Result"
              value={payload?.resultJson ?? null}
              absent={call.resultBytes === null ? "not recorded by the exporter" : "not recorded"}
            />
          </section>
        );
      })}
    </div>
  );
}
