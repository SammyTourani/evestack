/**
 * Server-side client for the eve agent's HTTP surface.
 *
 * The dashboard's read path goes straight to Postgres. This is the write path,
 * and it lives in one module because every control route needs the same four
 * things — base URL resolution, credentials, a timeout, and errors that already
 * know what HTTP status to return — and because the agent's wire contract is
 * worth stating once in types instead of being re-derived in five route files.
 *
 * Routes below were read out of eve 0.29.5 rather than guessed;
 * `templates/default/node_modules/eve/dist/src/protocol/routes.js` declares:
 *
 *   POST /eve/v1/session                      create a session, 202
 *   POST /eve/v1/session/:sessionId           follow-up message and/or HITL answers, 200
 *   POST /eve/v1/session/:sessionId/cancel    cooperative turn cancellation, 202
 *   GET  /eve/v1/session/:sessionId/stream    durable event stream (NDJSON, not SSE)
 *
 * There is no approve/deny route. HITL answers ride the follow-up route as
 * `inputResponses`; see `answerInput` below.
 */

const DEFAULT_AGENT_URL = "http://127.0.0.1:2000";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Newline-delimited JSON. eve's stream is NOT text/event-stream. */
export const EVE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
export const EVE_STREAM_TAIL_INDEX_HEADER = "x-eve-stream-tail-index";

/* -------------------------------------------------------------------------- */
/* wire types                                                                  */
/* -------------------------------------------------------------------------- */

/** A text or file part, when a message is richer than a plain string. */
export type UserContentPart = Record<string, unknown>;
export type UserMessage = string | UserContentPart[];

export type InputRequestKind = "question" | "session-limit" | "tool-approval";

export interface InputOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly style?: "danger" | "default" | "primary";
}

/**
 * A parked request for a human decision. Tool approvals always carry
 * `options: [{id:"approve"}, {id:"deny"}]` and `allowFreeform: false` — see
 * eve/dist/src/harness/input-extraction.js.
 */
export interface InputRequest {
  readonly requestId: string;
  readonly kind: InputRequestKind;
  readonly prompt: string;
  readonly options?: readonly InputOption[];
  readonly allowFreeform?: boolean;
  readonly display?: "confirmation" | "select" | "text";
  readonly action?: {
    readonly callId: string;
    readonly kind: "tool-call";
    readonly toolName: string;
    readonly input: Record<string, unknown>;
  };
}

/** The answer shape eve accepts: `{requestId, optionId?, text?}`, strictly. */
export interface InputResponse {
  readonly requestId: string;
  readonly optionId?: string;
  readonly text?: string;
}

export interface EveStreamEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly meta?: { readonly id?: string; readonly at?: string };
}

/** Both statuses mean the request succeeded; only the outcome differs. */
export type CancelTurnStatus = "accepted" | "no_active_turn";

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AgentErrorCode =
  | "agent_unreachable"
  | "agent_timeout"
  | "agent_unauthorized"
  | "agent_error"
  | "invalid_response"
  | "session_not_found"
  | "bad_request";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  /** Status this route should return to its own caller. */
  readonly status: number;
  /** Status the agent returned, when there was one. */
  readonly upstreamStatus?: number;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: { status: number; upstreamStatus?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentError";
    this.code = code;
    this.status = options.status;
    if (options.upstreamStatus !== undefined) this.upstreamStatus = options.upstreamStatus;
  }

  toResponse(): Response {
    const body: Record<string, unknown> = { ok: false, error: this.message, code: this.code };
    if (this.upstreamStatus !== undefined) body.upstreamStatus = this.upstreamStatus;
    return Response.json(body, { status: this.status, headers: { "cache-control": "no-store" } });
  }
}

/**
 * A 401 from the agent means *our* credentials are wrong, not the browser's, so
 * it must not surface as a 401 to the browser — that would ask the wrong party
 * to authenticate.
 */
function statusForUpstream(upstream: number): number {
  if (upstream === 401 || upstream === 403) return 502;
  if (upstream >= 500) return 502;
  return upstream;
}

function codeForUpstream(upstream: number): AgentErrorCode {
  if (upstream === 401 || upstream === 403) return "agent_unauthorized";
  if (upstream === 404) return "session_not_found";
  if (upstream === 400) return "bad_request";
  return "agent_error";
}

/* -------------------------------------------------------------------------- */
/* transport                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The agent's URL as a HUMAN should type it, for display only.
 *
 * `agentBaseUrl()` is the address THIS PROCESS uses, and inside the shipped
 * container that is `http://host.docker.internal:2001` — correct for a fetch
 * from in here, and completely useless pasted into a terminal on the host,
 * where that name does not resolve. Printing it is worse than printing a wrong
 * port, because a wrong port fails immediately and a name that does not resolve
 * reads as a network problem.
 *
 * Only the host is rewritten. The port is the one thing that was actually wrong
 * before, and it stays exactly as configured.
 */
export function agentUrlForHumans(): string {
  return agentBaseUrl().replace(/\/\/(host\.docker\.internal|0\.0\.0\.0)(?=[:/]|$)/, "//localhost");
}

export function agentBaseUrl(): string {
  const raw = process.env.EVESTACK_AGENT_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_AGENT_URL).replace(/\/+$/, "");
}

/**
 * `localDev()` in the agent's channel config waves through loopback with no
 * credentials, so Basic auth is only attached when both vars are set — sending
 * an empty Basic header would be worse than sending none.
 */
function authHeader(): string | undefined {
  const user = process.env.EVESTACK_AUTH_USER;
  const password = process.env.EVESTACK_AUTH_PASSWORD;
  if (!user || !password) return undefined;
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

export interface AgentFetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** `null` disables the timeout — required for the long-lived event stream. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

export async function agentFetch(path: string, options: AgentFetchOptions = {}): Promise<Response> {
  const { method = "GET", body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  const url = `${agentBaseUrl()}${path}`;

  const requestHeaders: Record<string, string> = { accept: "application/json", ...headers };
  const auth = authHeader();
  if (auth) requestHeaders.authorization = auth;
  if (body !== undefined) requestHeaders["content-type"] = "application/json";

  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs !== null) signals.push(AbortSignal.timeout(timeoutMs));

  try {
    return await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signals.length === 0 ? undefined : AbortSignal.any(signals),
      // Route handlers are dynamic, but be explicit: never serve a cached turn.
      cache: "no-store",
      redirect: "manual",
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new AgentError("agent_timeout", `The agent at ${agentBaseUrl()} did not respond in time.`, {
        status: 504,
        cause,
      });
    }
    // `npm run dev`, not `pnpm exec eve dev --no-ui`. A scaffolded project is an
    // npm project with that script defined, and this string is shown at the one
    // moment the reader is looking for something to type — handing them a
    // package manager they may not have installed, running a binary they have
    // not heard of, with a flag whose meaning is not obvious, was the worst
    // possible answer to "how do I start the agent". `pnpm` remains correct
    // inside this repository and nowhere a dashboard user will ever be.
    throw new AgentError(
      "agent_unreachable",
      `Cannot reach the eve agent at ${agentBaseUrl()}. Start it with \`npm run dev\` in your ` +
        `project directory, or set EVESTACK_AGENT_URL to where it is listening.`,
      { status: 502, cause },
    );
  }
}

async function agentJson<T>(path: string, options: AgentFetchOptions): Promise<T> {
  const response = await agentFetch(path, options);
  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch (cause) {
    if (response.ok) {
      throw new AgentError("invalid_response", "The agent returned a non-JSON response.", {
        status: 502,
        upstreamStatus: response.status,
        cause,
      });
    }
    parsed = {};
  }

  if (!response.ok) {
    const message =
      (typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : undefined) ?? `The agent returned ${response.status}.`;
    throw new AgentError(codeForUpstream(response.status), message, {
      status: statusForUpstream(response.status),
      upstreamStatus: response.status,
    });
  }

  return parsed as T;
}

function sessionPath(sessionId: string): string {
  return `/eve/v1/session/${encodeURIComponent(sessionId)}`;
}

/* -------------------------------------------------------------------------- */
/* commands                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateSessionInput {
  message: UserMessage;
  /** `task` runs to completion and terminates; `conversation` parks for follow-ups. */
  mode?: "conversation" | "task";
  clientContext?: unknown;
  signal?: AbortSignal;
}

export interface CreateSessionResult {
  sessionId: string;
  continuationToken: string;
}

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  const body: Record<string, unknown> = { message: input.message };
  if (input.mode !== undefined) body.mode = input.mode;
  if (input.clientContext !== undefined) body.clientContext = input.clientContext;

  const result = await agentJson<{ sessionId?: string; continuationToken?: string }>("/eve/v1/session", {
    method: "POST",
    body,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!result.sessionId || !result.continuationToken) {
    throw new AgentError("invalid_response", "The agent accepted the session but returned no handles.", {
      status: 502,
    });
  }
  return { sessionId: result.sessionId, continuationToken: result.continuationToken };
}

export interface ContinueSessionInput {
  continuationToken: string;
  message?: UserMessage;
  inputResponses?: readonly InputResponse[];
  clientContext?: unknown;
  signal?: AbortSignal;
}

/**
 * Follow-up turn. eve requires a non-empty `message`, a non-empty
 * `inputResponses`, or both; sending neither is a 400 from the agent.
 */
export async function continueSession(
  sessionId: string,
  input: ContinueSessionInput,
): Promise<{ sessionId: string }> {
  const body: Record<string, unknown> = { continuationToken: input.continuationToken };
  if (input.message !== undefined) body.message = input.message;
  if (input.inputResponses !== undefined) body.inputResponses = input.inputResponses;
  if (input.clientContext !== undefined) body.clientContext = input.clientContext;

  const result = await agentJson<{ sessionId?: string }>(sessionPath(sessionId), {
    method: "POST",
    body,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { sessionId: result.sessionId ?? sessionId };
}

/**
 * Cooperative cancellation of the in-flight turn. `turnId` scopes the request to
 * the turn the caller actually observed, so a late click cannot kill the turn
 * that started after it.
 */
export async function cancelTurn(
  sessionId: string,
  options: { turnId?: string; signal?: AbortSignal } = {},
): Promise<{ sessionId: string; status: CancelTurnStatus }> {
  const result = await agentJson<{ sessionId?: string; status?: CancelTurnStatus }>(
    `${sessionPath(sessionId)}/cancel`,
    {
      method: "POST",
      body: options.turnId === undefined ? {} : { turnId: options.turnId },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return { sessionId: result.sessionId ?? sessionId, status: result.status ?? "accepted" };
}

/** Answers one or more parked HITL requests. This is eve's only approval path. */
export async function answerInput(
  sessionId: string,
  input: {
    continuationToken: string;
    inputResponses: readonly InputResponse[];
    message?: UserMessage;
    signal?: AbortSignal;
  },
): Promise<{ sessionId: string }> {
  return continueSession(sessionId, input);
}

/* -------------------------------------------------------------------------- */
/* event stream                                                                */
/* -------------------------------------------------------------------------- */

export interface OpenStreamOptions {
  /** Non-negative is absolute; negative reads back from the tail (-1 = latest). */
  startIndex?: number;
  includeTailIndex?: boolean;
  signal?: AbortSignal;
}

/**
 * Opens the durable event stream. No timeout: a parked session legitimately
 * emits nothing for hours, and the caller's abort signal is the only correct
 * way to end it.
 */
export async function openEventStream(
  sessionId: string,
  options: OpenStreamOptions = {},
): Promise<Response> {
  const params = new URLSearchParams();
  if (options.startIndex !== undefined) params.set("startIndex", String(options.startIndex));
  if (options.includeTailIndex) params.set("includeTailIndex", "1");
  const query = params.size === 0 ? "" : `?${params}`;

  const response = await agentFetch(`${sessionPath(sessionId)}/stream${query}`, {
    headers: { accept: EVE_STREAM_CONTENT_TYPE },
    timeoutMs: null,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = `The agent returned ${response.status} for the event stream.`;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string") {
        message = (parsed as { error: string }).error;
      }
    } catch {
      /* keep the generic message */
    }
    throw new AgentError(codeForUpstream(response.status), message, {
      status: statusForUpstream(response.status),
      upstreamStatus: response.status,
    });
  }
  return response;
}

export function parseTailIndex(response: Response): number {
  const raw = response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER);
  const value = raw === null ? Number.NaN : Number(raw);
  // eve reports -1 for a stream with no events yet.
  return Number.isSafeInteger(value) ? value : -1;
}

export interface RecentEvents {
  events: EveStreamEvent[];
  /** Absolute index of `events[0]`. */
  startIndex: number;
  /** Index of the last durable event at the moment of the read; -1 if none. */
  tailIndex: number;
}

/**
 * Reads the tail of the durable stream and stops, instead of following it live.
 *
 * The stream never ends on its own, so the bound has to come from somewhere:
 * `includeTailIndex=1` returns the index of the last recorded event, which turns
 * "read the recent history" into a read of an exactly known number of lines.
 */
export async function readRecentEvents(
  sessionId: string,
  options: { lookback?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RecentEvents> {
  const lookback = Math.max(1, Math.trunc(options.lookback ?? 1024));
  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  options.signal?.addEventListener("abort", abortUpstream, { once: true });
  const timer = setTimeout(abortUpstream, options.timeoutMs ?? 15_000);

  try {
    const response = await openEventStream(sessionId, {
      startIndex: -lookback,
      includeTailIndex: true,
      signal: controller.signal,
    });

    const tailIndex = parseTailIndex(response);
    const available = tailIndex + 1;
    const count = Math.min(lookback, Math.max(0, available));
    if (count === 0 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return { events: [], startIndex: 0, tailIndex };
    }

    const events = await readNdjson(response.body, count);
    return { events, startIndex: available - count, tailIndex };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortUpstream);
    // Always hang up: a successful bounded read still leaves the socket open.
    controller.abort();
  }
}

async function readNdjson(body: ReadableStream<Uint8Array>, limit: number): Promise<EveStreamEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: EveStreamEvent[] = [];
  let buffered = "";

  try {
    while (events.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      let newline = buffered.indexOf("\n");
      while (newline !== -1 && events.length < limit) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        // eve primes the stream with a bare newline to flush response headers.
        if (line.length > 0) {
          const event = parseEventLine(line);
          if (event) events.push(event);
        }
        newline = buffered.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

function parseEventLine(line: string): EveStreamEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as { type?: unknown; data?: unknown };
    if (typeof candidate.type !== "string") return undefined;
    return {
      type: candidate.type,
      data: (typeof candidate.data === "object" && candidate.data !== null
        ? candidate.data
        : {}) as Record<string, unknown>,
      meta: (parsed as EveStreamEvent).meta,
    };
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* snapshot                                                                    */
/* -------------------------------------------------------------------------- */

export interface SessionSnapshot {
  sessionId: string;
  /**
   * The token published on the latest `session.waiting`.
   *
   * Do NOT use a change in this value to detect a new turn boundary. On eve
   * 0.30.8 over @workflow/world-postgres it is the session's command-hook
   * token and it is CONSTANT for the life of the session: measured across a
   * two-turn session, all three `session.waiting` events carried one value,
   * equal to the one `POST /eve/v1/session` returned at creation.
   * `parkedSince` below is the boundary test that survives that.
   */
  continuationToken?: string;
  /** True when the last boundary event was `session.waiting`. */
  waiting: boolean;
  terminal: boolean;
  /** Turn id from the most recent `turn.started`, for scoped cancellation. */
  turnId?: string;
  pendingRequests: InputRequest[];
  lastEventType?: string;
  tailIndex: number;
}

/**
 * "Has this session parked at a boundary NEWER than the one I already spent?"
 *
 * The question any caller that drives several turns in a row has to answer,
 * and the one a continuation-token comparison answers wrongly — see the note
 * on `SessionSnapshot.continuationToken`. Two conditions, both load-bearing:
 *
 *  - `waiting` — the session is parked. `turn.started` clears it and
 *    `session.waiting` sets it, so on its own this says "parked", not
 *    "parked again".
 *  - `tailIndex > sinceTailIndex` — the park is a new one. eve answers a
 *    follow-up POST before `turn.started` reaches the durable stream, so for a
 *    moment after sending, `waiting` still describes the PREVIOUS park. The
 *    tail index comes off eve's own `x-eve-stream-tail-index` header rather
 *    than from the events in the lookback window, so it stays monotonic even
 *    when that window slides past the events that produced it.
 */
export function parkedSince(snapshot: SessionSnapshot, sinceTailIndex: number): boolean {
  return (
    snapshot.waiting &&
    snapshot.continuationToken !== undefined &&
    snapshot.tailIndex > sinceTailIndex
  );
}

/**
 * Recovers everything a control caller needs but should not have to carry.
 *
 * The continuation token is published on `session.waiting`, so read it back
 * off the durable stream rather than making the browser carry it: an operator
 * clicking "approve" three hours later has no idea what it is.
 */
export async function getSessionSnapshot(
  sessionId: string,
  options: { lookback?: number; signal?: AbortSignal } = {},
): Promise<SessionSnapshot> {
  const { events, tailIndex } = await readRecentEvents(sessionId, options);

  const snapshot: SessionSnapshot = {
    sessionId,
    waiting: false,
    terminal: false,
    pendingRequests: [],
    tailIndex,
  };

  // Keyed by requestId so a re-emitted request updates rather than duplicates.
  const pending = new Map<string, InputRequest>();

  for (const event of events) {
    switch (event.type) {
      case "turn.started": {
        const turnId = event.data.turnId;
        if (typeof turnId === "string") snapshot.turnId = turnId;
        snapshot.waiting = false;
        // Two orderings, both verified against eve 0.29.5, force this to be the
        // clearing signal. A HITL pause emits `turn.completed` BEFORE
        // `session.waiting`, so turn completion cannot mean "answered". And
        // answering an `ask_question` emits no `action.result` at all — the
        // resumed turn just starts. A new turn is the one thing that reliably
        // means the parked one moved on. eve re-emits `input.requested` for
        // anything still outstanding, so clearing here cannot strand a live
        // request; the reverse mistake would show an operator a decision that
        // has already been made.
        pending.clear();
        break;
      }
      case "input.requested": {
        for (const entry of toInputRequests(event.data.requests)) pending.set(entry.requestId, entry);
        break;
      }
      case "action.result": {
        // Real tool approvals do execute the tool once approved, and that
        // result retires the request ahead of the next turn boundary.
        const callId = actionResultCallId(event.data);
        if (callId !== undefined) {
          for (const [requestId, entry] of pending) {
            if (requestId === callId || entry.action?.callId === callId) pending.delete(requestId);
          }
        }
        break;
      }
      case "session.waiting": {
        const token = event.data.continuationToken;
        if (typeof token === "string") snapshot.continuationToken = token;
        snapshot.waiting = true;
        snapshot.terminal = false;
        break;
      }
      case "session.completed":
      case "session.failed": {
        snapshot.waiting = false;
        snapshot.terminal = true;
        pending.clear();
        break;
      }
      default:
        break;
    }
    snapshot.lastEventType = event.type;
  }

  snapshot.pendingRequests = [...pending.values()];
  return snapshot;
}

function actionResultCallId(data: Record<string, unknown>): string | undefined {
  const result = data.result;
  if (typeof result !== "object" || result === null) return undefined;
  const callId = (result as { callId?: unknown }).callId;
  return typeof callId === "string" ? callId : undefined;
}

function toInputRequests(value: unknown): InputRequest[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is InputRequest =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as InputRequest).requestId === "string" &&
      typeof (entry as InputRequest).kind === "string",
  );
}
