/**
 * Formatting shared by the two trace pages.
 *
 * Everything here is pure and synchronous so both pages stay server
 * components: the trace viewer ships no client JavaScript at all, and the only
 * interactive element on it is a native <details>. That is not minimalism for
 * its own sake — this is the page an operator opens when the agent is
 * misbehaving, and it should render from HTML alone.
 */

export const fmt = (n: number): string => n.toLocaleString("en-US");

export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * Wall-clock time of day, to the millisecond.
 *
 * Local, not UTC, and correct here without the correction lib/queries.ts needs:
 * `evestack.spans` uses `timestamptz`, so pg reads the offset off the value
 * instead of guessing it from the host. Milliseconds are shown because
 * neighbouring spans in a step routinely start in the same second.
 */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function ago(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * eve caps a single span attribute at 32 KB, so a payload is already bounded —
 * but a session with fifty tool calls would still put well over a megabyte of
 * text in one document. Clamping per payload keeps the page navigable, and the
 * clamp is always stated rather than silently swallowing the tail of a result.
 */
export const MAX_PAYLOAD_CHARS = 24_000;

export interface Payload {
  text: string;
  /** Total length before clamping, or null when nothing was dropped. */
  truncatedFrom: number | null;
  /** False when the value did not parse as JSON, so it is printed verbatim. */
  json: boolean;
}

export function payload(raw: string): Payload {
  let text = raw;
  let json = false;
  try {
    text = JSON.stringify(JSON.parse(raw), null, 2);
    json = true;
  } catch {
    // Not JSON, and that is expected for some of these: `ai.response.text` is a
    // bare string. A malformed tool argument object also lands here, and
    // printing it verbatim is the point — a payload that fails to parse is
    // exactly the one worth looking at.
  }
  if (text.length <= MAX_PAYLOAD_CHARS) return { text, truncatedFrom: null, json };
  return { text: text.slice(0, MAX_PAYLOAD_CHARS), truncatedFrom: text.length, json };
}

export interface ChatMessage {
  role: string;
  /** Prose pulled out of the message, or null when the shape was unreadable. */
  text: string | null;
  /** The message as recorded, for the fallback render and for tool payloads. */
  raw: string;
}

/**
 * Message history, out of either vocabulary's encoding.
 *
 * `ai.prompt.messages` (eve's local tracer) and `gen_ai.input.messages` (the AI
 * SDK exporter) are both JSON arrays of messages, and they disagree about where
 * the text lives: `content` as a string, `content` as an array of parts, or
 * `parts` as an array. Rather than pick one and render blank for the other,
 * this tries all three and hands back the raw message when none of them
 * produce text — an unrecognised shape has to stay inspectable.
 *
 * Returns null when the value is not an array at all, so the caller can fall
 * back to printing the whole attribute as JSON.
 */
export function parseMessages(raw: string): ChatMessage[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  return parsed.map((entry) => {
    const message = (entry ?? {}) as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "message";
    return { role, text: messageText(message), raw: JSON.stringify(entry, null, 2) };
  });
}

function messageText(message: Record<string, unknown>): string | null {
  const chunks: string[] = [];
  const take = (value: unknown) => {
    const text = partText(value);
    if (text) chunks.push(text);
  };

  const { content, parts } = message;
  if (typeof content === "string") take(content);
  else if (Array.isArray(content)) for (const part of content) take(part);
  if (Array.isArray(parts)) for (const part of parts) take(part);

  return chunks.length > 0 ? chunks.join("\n") : null;
}

function partText(part: unknown): string | null {
  if (typeof part === "string") return part.length > 0 ? part : null;
  if (!part || typeof part !== "object") return null;
  const value = part as Record<string, unknown>;

  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    const nested = value.content.map(partText).filter((t): t is string => t !== null);
    return nested.length > 0 ? nested.join("\n") : null;
  }
  // A tool-call or tool-result part carries a structured payload, not prose.
  // Printing it as JSON is the honest rendering: those parts are half the
  // reason a message history is worth reading in the first place.
  if (typeof value.type === "string" || value.toolName !== undefined) {
    return JSON.stringify(value, null, 2);
  }
  return null;
}

/**
 * A short label for a span, from its name.
 *
 * Both vocabularies are matched for the same reason every read in
 * lib/traces.ts matches both: which one arrives depends on whether the project
 * authors agent/instrumentation.ts, and evestack's template does.
 */
export function spanKind(name: string): string {
  if (name === "agent.session") return "session";
  if (name === "agent.turn") return "turn";
  if (name === "agent.turn.terminal") return "turn end";
  if (name === "agent.step") return "step";
  if (name === "agent.action") return "action";
  if (name === "ai.toolCall" || name.startsWith("execute_tool ")) return "tool";
  if (name === "ai.streamText.doStream" || name.startsWith("chat ")) return "model";
  if (name.startsWith("ai.")) return "ai sdk";
  if (name.startsWith("agent.")) return "agent";
  return "span";
}

export const isToolSpan = (name: string): boolean =>
  name === "ai.toolCall" || name.startsWith("execute_tool ");

export const isModelSpan = (name: string): boolean =>
  name === "ai.streamText.doStream" || name.startsWith("chat ");

/** OTel status codes: 0 unset, 1 ok, 2 error. Only the last one is news. */
export const spanFailed = (statusCode: number): boolean => statusCode === 2;
