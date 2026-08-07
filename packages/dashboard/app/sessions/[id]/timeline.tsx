import { OutcomeBadge } from "@/components/ui/badge";
import { formatCost, formatMetric } from "@/components/ui/format";
import { FOCUS_RING } from "@/components/ui/style";
import { clock, duration } from "@/lib/time";

import type { TimelineNode } from "./data";

/**
 * Every turn of the session, in order, with the slow one visible without
 * reading a number.
 *
 * The bar is scaled to the longest turn in the session rather than to a fixed
 * axis, so a session of 3-second turns and a session of 3-minute turns both
 * show their own shape. That is the whole job of this pane: the latency spike
 * in the seeded month is one turn among six, and a column of durations in text
 * makes you compare them yourself.
 *
 * Selection is a query parameter, not client state. The pane is a list of
 * links, so the whole page renders from HTML, every turn is a URL somebody can
 * paste into an incident channel, and the browser's back button works. The
 * trace viewer already made that trade and this is the same page family.
 */

export interface TimelineProps {
  readonly nodes: readonly TimelineNode[];
  readonly selectedId: string;
  /** The longest turn duration in the session; the bar's 100%. */
  readonly maxDurationMs: number | null;
  readonly sessionId: string;
}

export function Timeline({ nodes, selectedId, maxDurationMs, sessionId }: TimelineProps) {
  return (
    <ol className="m-0 flex list-none flex-col gap-px p-0">
      {nodes.map((node) => (
        <TimelineItem
          key={node.run.id}
          node={node}
          selectedId={selectedId}
          maxDurationMs={maxDurationMs}
          sessionId={sessionId}
          depth={0}
        />
      ))}
    </ol>
  );
}

function TimelineItem({
  node,
  selectedId,
  maxDurationMs,
  sessionId,
  depth,
}: Omit<TimelineProps, "nodes"> & { node: TimelineNode; depth: number }) {
  return (
    <li>
      <TimelineRow
        node={node}
        selected={node.run.id === selectedId}
        maxDurationMs={maxDurationMs}
        sessionId={sessionId}
        depth={depth}
      />
      {node.children.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-px p-0">
          {node.children.map((child) => (
            <TimelineItem
              key={child.run.id}
              node={child}
              selectedId={selectedId}
              maxDurationMs={maxDurationMs}
              sessionId={sessionId}
              depth={depth + 1}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

/**
 * eve names a subagent by its compiled graph node id, and the built-in `agent`
 * tool — delegating to a copy of the current agent — is literally `__root__`.
 * That is the most common subagent there is, so showing the raw id would put a
 * meaningless token in front of most readers. Named subagents keep their name.
 */
function label(node: TimelineNode): string {
  if (node.run.type !== "subagent") return `#${node.seq ?? "?"}`;
  if (!node.run.subagent || node.run.subagent === "__root__") return "subagent";
  return node.run.subagent;
}

function TimelineRow({
  node,
  selected,
  maxDurationMs,
  sessionId,
  depth,
}: {
  node: TimelineNode;
  selected: boolean;
  maxDurationMs: number | null;
  sessionId: string;
  depth: number;
}) {
  const { run, fact } = node;
  const durationMs = fact?.durationMs ?? run.durationMs;
  // lib/monitors.ts's failure population, both halves: a turn carrying an error
  // code, and a turn that finished having never reached a model. Tinting only
  // the first would draw 62 of the seeded month's failures as healthy.
  const failed = fact ? fact.outcome === "failed" || fact.outcome === "no_model_call" : false;
  const widthPct =
    durationMs !== null && maxDurationMs !== null && maxDurationMs > 0
      ? Math.max(1.5, Math.min(100, (durationMs / maxDurationMs) * 100))
      : null;

  return (
    <a
      href={`/sessions/${encodeURIComponent(sessionId)}?turn=${encodeURIComponent(run.id)}`}
      aria-current={selected ? "true" : undefined}
      className={[
        "block rounded-sm border-l-2 py-2 pr-2 no-underline",
        selected
          ? "border-l-accent bg-bg-hover"
          : "border-l-transparent hover:bg-bg-hover hover:border-l-border",
        FOCUS_RING,
      ].join(" ")}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-micro text-text-faint">{label(node)}</span>
        {fact ? (
          <OutcomeBadge outcome={fact.outcome} />
        ) : (
          // A run row exists and no fact row does yet. Saying "ok" here would be
          // an outcome nobody computed.
          <span className="font-mono text-micro text-text-faint" title="Not in the fact table yet">
            no facts
          </span>
        )}
        <span className="ml-auto font-mono text-small tabular-nums text-text">
          {duration(durationMs)}
        </span>
      </div>

      {/* The bar is decoration for the duration on the line above, which is why
          it is aria-hidden: a screen reader gets the number, not a rectangle. */}
      <div aria-hidden="true" className="mt-1.5 h-1 w-full rounded-full bg-bg">
        {widthPct !== null && (
          <div
            className={`h-1 rounded-full ${failed ? "bg-err" : "bg-accent"}`}
            style={{ width: `${widthPct}%` }}
          />
        )}
      </div>

      <div className="mt-1.5 flex items-baseline gap-2 text-micro text-text-faint">
        <span className="font-mono">{clock(fact?.startedAt ?? run.startedAt ?? run.createdAt, "second")}</span>
        <span className="font-mono tabular-nums">
          {formatMetric(fact?.inputTokens ?? run.inputTokens, "tokens")}
          <span className="px-1">→</span>
          {formatMetric(fact?.outputTokens ?? run.outputTokens, "tokens")}
        </span>
        {/* Three states, one expression: an amount when the model is priced,
            `Unpriced` when it has no rate, and an em dash when the turn never
            reached a model at all and there is nothing to price. */}
        <span className="ml-auto font-mono tabular-nums">
          {formatCost(fact?.costUsd, fact?.priced !== false)}
        </span>
      </div>
    </a>
  );
}
