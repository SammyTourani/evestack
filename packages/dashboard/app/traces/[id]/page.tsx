import { getSession } from "@/lib/queries";
import {
  getSpanTree,
  listModelCalls,
  listToolCalls,
  type ModelCall,
  type SpanNode,
  type ToolCall,
} from "@/lib/traces";
import {
  clockTime,
  duration,
  fmt,
  isModelSpan,
  isToolSpan,
  spanFailed,
  spanKind,
} from "../format";
import styles from "../traces.module.css";
import { Fact, MessagesBlock, PayloadBlock } from "./payload";

export const dynamic = "force-dynamic";

/**
 * The trace viewer for one session.
 *
 * Tier 1 (the run tree at /sessions/[id]) says a turn happened, which model ran
 * and what it cost. It cannot say what the agent was told or what `bash`
 * returned — eve writes none of that to a workflow run. This page is the other
 * half: the same session, read out of `evestack.spans`.
 */

/** A span with the indent it renders at. The tree is flattened for display so
 *  the waterfall stays one grid — nested <ul>s cannot share a timeline. */
interface Row {
  node: SpanNode;
  depth: number;
}

function flatten(nodes: readonly SpanNode[], depth = 0, into: Row[] = []): Row[] {
  for (const node of nodes) {
    into.push({ node, depth });
    flatten(node.children, depth + 1, into);
  }
  return into;
}

/**
 * listSpansBySession caps a session at 5,000 spans; rendering all of them is
 * over a megabyte of markup for a page nobody scrolls to the bottom of. The cut
 * is stated below the table rather than made quietly.
 */
const MAX_ROWS = 600;

export default async function TraceDetailPage(props: PageProps<"/traces/[id]">) {
  const { id } = await props.params;

  let session: Awaited<ReturnType<typeof getSession>>;
  let tree: SpanNode[];
  let modelCalls: ModelCall[];
  let toolCalls: ToolCall[];
  try {
    // Four reads, three of which re-run the same span query inside
    // lib/traces.ts. They are indexed and issued together, and the alternative
    // is changing signatures in a file this page does not own — noted in the
    // handoff as the refactor to make if this page ever feels slow.
    [session, tree, modelCalls, toolCalls] = await Promise.all([
      getSession(id),
      getSpanTree(id),
      listModelCalls(id),
      listToolCalls(id),
    ]);
  } catch (error) {
    return (
      <div className="empty">
        <h2>Can&apos;t reach the database</h2>
        <p className="dim">{error instanceof Error ? error.message : String(error)}</p>
        <p className="faint">
          Spans live in the <code>evestack</code> schema of the same Postgres that holds your
          sessions. Start it with <code>docker compose up postgres</code>.
        </p>
      </div>
    );
  }

  const rows = flatten(tree);
  const sessionHref = `/sessions/${encodeURIComponent(id)}`;

  if (rows.length === 0) {
    return (
      <>
        <Crumbs />
        <div className="empty">
          <h2>No spans for this session</h2>
          <p className="dim mono">{id}</p>
          <p>
            {session
              ? "The session exists and its run tree is intact — nothing exported spans for it."
              : "No session with this id in workflow_runs either, so there is nothing to line these up against."}
          </p>
          <p className="faint">
            Trace export is opt-in: it needs <code>EVESTACK_DASHBOARD_URL</code> and{" "}
            <code>EVESTACK_INGEST_TOKEN</code> set on the agent. Spans are only recorded for runs
            that happen after that, so an older session stays empty here forever.{" "}
            <a href="/traces" className={styles.metaLink}>
              Setup instructions
            </a>
            {session && (
              <>
                {" · "}
                <a href={sessionHref} className={styles.metaLink}>
                  Run tree for this session
                </a>
              </>
            )}
          </p>
        </div>
      </>
    );
  }

  // The waterfall window. Reduce rather than Math.min(...array): a 5,000-span
  // session would spread 5,000 arguments across the stack.
  let firstStart = Number.POSITIVE_INFINITY;
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const { node } of rows) {
    const start = new Date(node.startTime).getTime();
    const end = node.endTime ? new Date(node.endTime).getTime() : start;
    if (start < firstStart) firstStart = start;
    if (end > lastEnd) lastEnd = end;
  }
  const spanWindowMs = Math.max(lastEnd - firstStart, 1);

  const firstSpan = rows[0]!.node;
  const traces = new Set(rows.map((row) => row.node.traceId));
  const service = rows.find((row) => row.node.resource["service.name"])?.node.resource[
    "service.name"
  ];

  // Every content field the two vocabularies can carry. All null while calls
  // exist is the signature of EVESTACK_TRACE_CONTENT=off — the spans are there,
  // the timings are there, the bodies were never recorded.
  const contentFields = [
    ...modelCalls.flatMap((c) => [c.systemPrompt, c.promptMessages, c.responseText]),
    ...toolCalls.flatMap((c) => [c.argumentsJson, c.resultJson]),
  ];
  const contentOff = contentFields.length > 0 && contentFields.every((v) => v === null);

  // `agent.root.session.id` has no AI SDK counterpart, so an exporting
  // deployment cannot stitch a subagent's trace to its parent from spans alone.
  const hasLineage = rows.some((row) => row.node.rootSessionId !== null);
  // Same gate, seen from the other side: eve installs its own `eve.agent`
  // tracer only when the project authors no agent/instrumentation.ts, and
  // evestack's template authors one. So the agent.* family never arrives.
  const hasLocalTracerSpans = rows.some((row) => row.node.name.startsWith("agent."));

  const inputTokens = sum(modelCalls.map((c) => c.inputTokens));
  const outputTokens = sum(modelCalls.map((c) => c.outputTokens));
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <>
      <Crumbs />

      <h1>{session?.title ?? <span className="faint">Trace</span>}</h1>

      <div className={styles.meta}>
        {session && <span className={`status status-${session.status}`}>{session.status}</span>}
        {typeof service === "string" && (
          <>
            <span>
              agent <span className="mono">{service}</span>
            </span>
            <span className={styles.dot}>•</span>
          </>
        )}
        <span title={firstSpan.startTime}>first span {clockTime(firstSpan.startTime)}</span>
        <span className={styles.dot}>•</span>
        <span>spanning {duration(spanWindowMs)}</span>
        <span className={styles.dot}>•</span>
        <a className={styles.metaLink} href={sessionHref}>
          Run tree, tokens and cost →
        </a>
        <span className={styles.dot}>•</span>
        <span className={styles.runId}>{id}</span>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Spans</div>
          <div className="stat-value">{fmt(rows.length)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Traces</div>
          <div className="stat-value">{fmt(traces.size)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Model calls</div>
          <div className="stat-value">{fmt(modelCalls.length)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Tool calls</div>
          <div className="stat-value">{fmt(toolCalls.length)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Tokens in / out</div>
          <div className="stat-value">
            {inputTokens === null ? (
              <span className="faint">—</span>
            ) : (
              <>
                {fmt(inputTokens)}
                <span className="faint"> / </span>
                {outputTokens === null ? "—" : fmt(outputTokens)}
              </>
            )}
          </div>
        </div>
      </div>

      {inputTokens !== null && (
        <p className={styles.footnote}>
          Those tokens are summed from each model call&apos;s own span. The run tree adds up eve&apos;s
          per-turn <code>$eve.*_tokens</code> tags instead — a different source, so the two can
          disagree. Cost is computed from the run tree, not from here.
        </p>
      )}

      {/* Both of the structural notices are true at once on every exported
          trace — the missing agent.* layer is the cause and the unstitchable
          subagent is its consequence — so they are one notice rather than two
          that always appear together. The standalone lineage notice is left for
          the case they come apart: local-tracer spans present, root id absent. */}
      {(contentOff || !hasLocalTracerSpans || !hasLineage) && (
        <div className={styles.notices}>
          {contentOff && (
            <p className={styles.notice}>
              <strong>No content on these spans.</strong> {fmt(modelCalls.length)} model calls and{" "}
              {fmt(toolCalls.length)} tool calls were recorded, and not one carries a prompt, an
              argument or a result. That is what <code>EVESTACK_TRACE_CONTENT=off</code> does — it
              sets <code>recordInputs</code> and <code>recordOutputs</code> to false while keeping
              timings, model ids and token counts. Unset it and re-run to see bodies here.
            </p>
          )}
          {!hasLocalTracerSpans ? (
            <p className={`${styles.notice} ${styles.noticeInfo}`}>
              <strong>These are AI SDK spans.</strong> There is no{" "}
              <code>agent.session → agent.turn → agent.step</code> layer below, and its absence is
              not a dropped batch: eve installs the tracer that emits that family only when the
              project authors no <code>agent/instrumentation.ts</code>, and exporting anywhere
              means authoring one. Nothing here carries{" "}
              <code>agent.root.session.id</code> either — it has no AI SDK counterpart — so a
              subagent&apos;s spans sit under their own session id and cannot be linked back to
              this one from span data. The{" "}
              <a className={styles.metaLink} href={sessionHref}>
                run tree
              </a>{" "}
              holds the session, turn and subagent hierarchy regardless; it never depended on
              spans.
            </p>
          ) : (
            !hasLineage && (
              <p className={`${styles.notice} ${styles.noticeInfo}`}>
                <strong>Subagent traces are not stitched in.</strong> No span here carries{" "}
                <code>agent.root.session.id</code>, so if this session delegated to a subagent,
                that subagent&apos;s spans cannot be linked to this one from span data. The{" "}
                <a className={styles.metaLink} href={sessionHref}>
                  run tree
                </a>{" "}
                has the lineage regardless, from <code>$eve.root</code>.
              </p>
            )
          )}
        </div>
      )}

      <div className={styles.sectionHead}>
        <h2>Span tree</h2>
        <span className={styles.sectionNote}>
          {traces.size === 1
            ? "one trace"
            : `${fmt(traces.size)} traces, interleaved by start time`}
          {rows.length > MAX_ROWS && ` · showing the first ${fmt(MAX_ROWS)}`}
        </span>
      </div>

      <div className={styles.waterfall}>
        {shown.map(({ node, depth }) => {
          const start = new Date(node.startTime).getTime();
          const offset = ((start - firstStart) / spanWindowMs) * 100;
          const failed = spanFailed(node.statusCode);
          const tool = isToolSpan(node.name);
          const model = isModelSpan(node.name);
          const width =
            node.durationMs === null
              ? 0
              : Math.min(Math.max((node.durationMs / spanWindowMs) * 100, 0.4), 100 - offset);

          return (
            <div className={styles.row} id={`s-${node.spanId}`} key={node.spanId}>
              <div className={styles.rowName} style={{ paddingLeft: depth * 14 }}>
                <span
                  className={`${styles.kind} ${
                    failed
                      ? styles.kindFailed
                      : tool
                        ? styles.kindTool
                        : model
                          ? styles.kindModel
                          : ""
                  }`}
                >
                  {spanKind(node.name)}
                </span>
                {tool || model ? (
                  <a
                    className={`${styles.rowLabel} ${styles.rowLink}`}
                    href={`#c-${node.spanId}`}
                    title={node.name}
                  >
                    {node.name}
                  </a>
                ) : (
                  <span className={styles.rowLabel} title={node.name}>
                    {node.name}
                  </span>
                )}
              </div>

              <div
                className={styles.track}
                title={`${clockTime(node.startTime)} · ${duration(node.durationMs)}`}
              >
                <div
                  className={`${styles.bar} ${
                    node.durationMs === null
                      ? styles.barOpen
                      : failed
                        ? styles.barFailed
                        : tool
                          ? styles.barTool
                          : ""
                  }`}
                  style={{
                    left: `${offset}%`,
                    ...(node.durationMs === null ? {} : { width: `${width}%` }),
                  }}
                />
              </div>

              <div className={styles.rowDuration}>
                {node.durationMs === null ? (
                  <span className="faint" title="No end time — the span never closed">
                    open
                  </span>
                ) : (
                  duration(node.durationMs)
                )}
              </div>
            </div>
          );
        })}
      </div>

      {rows.length > MAX_ROWS && (
        <p className={styles.truncNote}>
          {fmt(rows.length - MAX_ROWS)} further spans are not drawn. Every model and tool call is
          still listed below — the cut is on the timeline only.
        </p>
      )}

      <div className={styles.sectionHead}>
        <h2>Tool calls</h2>
        <span className={styles.sectionNote}>
          what the agent ran, and what came back
          {toolCalls.length > 0 && ` · ${fmt(toolCalls.length)}`}
        </span>
      </div>

      {toolCalls.length === 0 ? (
        <div className="empty">
          <h2>No tool calls in this trace</h2>
          <p className="faint">
            Nothing named <code>execute_tool …</code> or <code>ai.toolCall</code> was exported for
            this session. A turn that only answered from the model produces none.
          </p>
        </div>
      ) : (
        <ul className={styles.cards}>
          {toolCalls.map((call) => (
            <ToolCallCard call={call} key={call.spanId} />
          ))}
        </ul>
      )}

      <div className={styles.sectionHead}>
        <h2>Model calls</h2>
        <span className={styles.sectionNote}>
          system prompt, message history and response
          {modelCalls.length > 0 && ` · ${fmt(modelCalls.length)}`}
        </span>
      </div>

      {modelCalls.length === 0 ? (
        <div className="empty">
          <h2>No model calls in this trace</h2>
          <p className="faint">
            Nothing named <code>chat …</code> or <code>ai.streamText.doStream</code> was exported
            for this session.
          </p>
        </div>
      ) : (
        <ul className={styles.cards}>
          {modelCalls.map((call) => (
            <ModelCallCard call={call} key={call.spanId} />
          ))}
        </ul>
      )}
    </>
  );
}

function Crumbs() {
  return (
    <nav className={styles.crumbs}>
      <a href="/traces">Traces</a>
      <span>/</span>
      <span>this session</span>
    </nav>
  );
}

/**
 * One tool invocation: name, arguments, result.
 *
 * This is the sandbox-observability answer. When the agent ran something, the
 * command it ran is `Arguments` and what the sandbox returned is `Result`, and
 * both are open by default because reading them is the entire reason to be on
 * this page.
 */
function ToolCallCard({ call }: { call: ToolCall }) {
  const failed = spanFailed(call.statusCode);
  return (
    <li className={failed ? `${styles.card} ${styles.cardFailed}` : styles.card} id={`c-${call.spanId}`}>
      <div className={styles.cardHead}>
        <span className={`${styles.kind} ${failed ? styles.kindFailed : styles.kindTool}`}>
          {failed ? "tool failed" : "tool"}
        </span>
        <span className={styles.cardTitle}>
          {call.name ?? <span className="faint">unnamed tool</span>}
        </span>
        <a className={styles.cardSpanId} href={`#s-${call.spanId}`} title="Find on the timeline">
          {call.spanId}
        </a>
      </div>

      <div className={styles.facts}>
        <Fact label="at">
          <span title={call.startTime}>{clockTime(call.startTime)}</span>
        </Fact>
        <Fact label="took">{duration(call.durationMs)}</Fact>
        {call.stepIndex !== null && <Fact label="step">{call.stepIndex}</Fact>}
        {call.callId && (
          <Fact label="call id">
            <span className="mono">{call.callId}</span>
          </Fact>
        )}
        {call.turnId && (
          <Fact label="turn">
            <span className="mono faint">{call.turnId}</span>
          </Fact>
        )}
      </div>

      <PayloadBlock
        label="Arguments"
        value={call.argumentsJson}
        open
        absent="not recorded (EVESTACK_TRACE_CONTENT=off, or the exporter dropped inputs)"
      />
      <PayloadBlock
        label="Result"
        value={call.resultJson}
        open
        absent="not recorded (EVESTACK_TRACE_CONTENT=off, or the tool is still running)"
      />
    </li>
  );
}

/**
 * One model call. The response is open, the prompt and history are not: on a
 * long session the system prompt is the same several thousand tokens every
 * time, and the thing you came to read is what the model said back.
 */
function ModelCallCard({ call }: { call: ModelCall }) {
  return (
    <li className={styles.card} id={`c-${call.spanId}`}>
      <div className={styles.cardHead}>
        <span className={`${styles.kind} ${styles.kindModel}`}>model</span>
        <span className={styles.cardTitle}>
          {call.model ?? <span className="faint">model not recorded</span>}
        </span>
        <a className={styles.cardSpanId} href={`#s-${call.spanId}`} title="Find on the timeline">
          {call.spanId}
        </a>
      </div>

      <div className={styles.facts}>
        <Fact label="at">
          <span title={call.startTime}>{clockTime(call.startTime)}</span>
        </Fact>
        <Fact label="took">{duration(call.durationMs)}</Fact>
        {call.stepIndex !== null && <Fact label="step">{call.stepIndex}</Fact>}
        {call.provider && <Fact label="provider">{call.provider}</Fact>}
        {call.finishReason && <Fact label="finish">{call.finishReason}</Fact>}
        <Fact label="in">{call.inputTokens === null ? "—" : fmt(call.inputTokens)}</Fact>
        <Fact label="out">{call.outputTokens === null ? "—" : fmt(call.outputTokens)}</Fact>
        {call.cacheReadTokens !== null && (
          <Fact label="cached">
            <span className="dim">{fmt(call.cacheReadTokens)}</span>
          </Fact>
        )}
      </div>

      <PayloadBlock label="System prompt" value={call.systemPrompt} />
      <MessagesBlock value={call.promptMessages} />
      <PayloadBlock label="Response" value={call.responseText} open />
      {/* Only the local tracer records this separately; under the AI SDK
          vocabulary the tool calls are inside the response messages, and the
          Tool calls section above has them with their results. */}
      {call.responseToolCalls !== null && (
        <PayloadBlock label="Response tool calls" value={call.responseToolCalls} />
      )}
    </li>
  );
}

/** Null when nothing reported a number, so "—" can be told from a real zero. */
function sum(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}
