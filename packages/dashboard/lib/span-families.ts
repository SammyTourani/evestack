/**
 * The two span families a reader came for, named in both vocabularies.
 *
 * WHY THIS IS ITS OWN MODULE. app/traces/format.ts needs these same two pairs,
 * and its header states the constraint it is built around: everything in it is
 * pure and synchronous so both trace pages stay server components and the
 * viewer ships no client JavaScript. lib/traces.ts imports node:fs, node:path
 * and the Postgres pool, so importing the table FROM there would drag all of
 * that behind a formatter that deliberately depends on nothing. A pure module
 * both sides can import is what lets there be one table instead of two.
 *
 *
 * ONE table, because this used to be three. There was a pair of SQL predicates,
 * a pair of inline JS filters in listModelCalls/listToolCalls, and a third pair
 * inside a getTraceStats() that matched `name = 'ai.toolCall'` and
 * `name = 'ai.streamText.doStream'` EXACTLY — the *local tracer's* names. A
 * deployment that exports is the only kind that can reach this dashboard, and it
 * sends `execute_tool <name>` and `chat <model>` instead, so /api/ingest/v1/traces
 * answered `toolCalls: 0` on a table full of tool calls: the endpoint whose only
 * job is telling a wired exporter from a silent one reported silent while
 * working. Deriving both halves from one table is what makes that unrepeatable.
 *
 * The shape of each pair is eve's, not a convention: the local `eve.agent`
 * tracer emits a fixed span name and the vendored AI SDK exporter appends the
 * model or the tool to it, so one half is equality and the other is a prefix.
 */
export interface SpanFamily {
  /** The local tracer's name, which is the whole name. */
  exact: string;
  /** The exporter's name, which carries the model or the tool on the end. */
  prefix: string;
}

export const MODEL_CALL_SPANS: SpanFamily = { exact: "ai.streamText.doStream", prefix: "chat " };
export const TOOL_CALL_SPANS: SpanFamily = { exact: "ai.toolCall", prefix: "execute_tool " };

/**
 * Does this span name belong to the family? The JS half of the predicate.
 *
 * Exported alongside sqlSpanFamily so the two halves can be pinned against each
 * other in a test that needs no database. A name recognised by one and not the
 * other is precisely the page that says "3 tool calls" above a list of two.
 */
export function matchesSpanFamily(family: SpanFamily, name: string): boolean {
  return name === family.exact || name.startsWith(family.prefix);
}

/**
 * The SQL half. These predicates run in Postgres rather than in JS because
 * their callers count across the whole table; pulling every row into Node to
 * measure the length of two arrays is not a query plan.
 *
 * `starts_with` rather than LIKE: `_` is a LIKE wildcard, so `'execute_tool %'`
 * would also match `'executeXtool '`. Interpolated rather than bound because a
 * predicate is not a value — and safe to interpolate for the same reason, since
 * both literals are module constants that never see a request.
 */
export function sqlSpanFamily(family: SpanFamily): string {
  return `(name = '${family.exact}' OR starts_with(name, '${family.prefix}'))`;
}
