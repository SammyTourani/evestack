import { DashboardClient, DashboardError } from "./dashboard.js";
import type { JsonSchema } from "./schema.js";
import { fitToolPayload, payloadBytes } from "./truncate.js";

/**
 * The tool surface.
 *
 * Every tool here is a projection of one or more routes the dashboard already
 * serves. The descriptions are written for a model, not for a changelog: they
 * say what the tool reads, what it costs, and — for the mutating half — exactly
 * what happens in the real world when it is called.
 *
 * READ-ONLY vs MUTATING is stated three ways, because clients surface different
 * ones: in the first word of the description, in `annotations.readOnlyHint`,
 * and by whether the tool is advertised at all (see `EVESTACK_MCP_ALLOW_CONTROL`
 * in server.ts).
 */

/** A failure the model should see and can act on — becomes `isError: true`. */
export class ToolFailure extends Error {
  readonly detail: Record<string, unknown> | undefined;

  constructor(message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "ToolFailure";
    this.detail = detail;
  }
}

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: ToolAnnotations;
  /** Advertised only when control is enabled. */
  readonly mutating: boolean;
  handle(args: Record<string, unknown>, client: DashboardClient): Promise<unknown>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const str = (args: Record<string, unknown>, key: string): string => String(args[key]);

const optionalStr = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const path = (sessionId: string, suffix: string): string =>
  `/api/control/sessions/${encodeURIComponent(sessionId)}${suffix}`;

/**
 * Only the shape a control route needs.
 *
 * `null` is dropped as well as `undefined`, because schema.ts:95-99 documents
 * them as the same thing: "`undefined` cannot survive a JSON round trip, so an
 * explicit null is the only way a client can spell 'present but empty' — and for
 * these tools it means the same thing as absent." The validator honours that;
 * this function did not, and the gap was reachable. `start_session({message,
 * mode: null})` put `{"message":"…","mode":null}` on the wire, and the control
 * route rejects that with 400 "Expected 'mode' to be 'conversation' or 'task'"
 * (app/api/control/sessions/route.ts:23) where the same call with `mode` omitted
 * succeeds. Same for `decision: null` on the approve route (route.ts:84). A
 * client spelling "no preference" the only way JSON lets it got an error for it.
 */
function body(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** The same "null means absent" rule for a query-string value. See `body` above. */
const absent = (value: unknown): boolean => value === undefined || value === null;

const SESSION_ID: JsonSchema = {
  type: "string",
  minLength: 1,
  description:
    "The eve session id, e.g. 'wrun_01KZ8CQ5012M1M9P6YE7YG3FJ3'. Get one from list_sessions.",
};

// ---------------------------------------------------------------------------
// Read-only
// ---------------------------------------------------------------------------

const listSessions: ToolDefinition = {
  name: "list_sessions",
  title: "List recent agent sessions",
  mutating: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description:
    "READ-ONLY. Lists the most recent eve agent sessions on this evestack deployment, with per-session " +
    "turn counts, token totals, computed USD cost and the models used, plus lifetime totals across every " +
    "session ever recorded.\n\n" +
    "LIMIT: the dashboard's /api/health/detail route returns a fixed five most-recent sessions, so this " +
    "tool cannot page or filter. `totals.sessions` tells you how many exist; `listed` tells you how many " +
    "came back. If you need an older session you must already know its id — pass it straight to " +
    "get_session.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  async handle(_args, client) {
    // /api/health/detail, not /api/health. The rollup used to live on
    // /api/health, which is the one unauthenticated route in the dashboard —
    // session ids, turn counts, token counts, cost and model names to anyone
    // who could reach the port. It was cut back to `{ ok, database }` and the
    // detail moved behind the session gate. This kept reading the old shape, so
    // `health.recentSessions` and `health.totals` were both undefined and three
    // tools returned confidently empty results instead of failing.
    const health = record(await client.get("/api/health/detail"));
    const sessions = arr(health.recentSessions);
    return {
      totals: health.totals,
      listed: sessions.length,
      sessions,
      database: health.database,
    };
  },
};

const getSession: ToolDefinition = {
  name: "get_session",
  title: "Inspect one agent session",
  mutating: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description:
    "READ-ONLY. Everything the control plane can say about one session: whether its turn is still running " +
    "or parked waiting on a human, what it is waiting FOR (the pending tool-approval requests, with tool " +
    "names), its token/cost usage, and — the useful part when a run ended badly — any budget stop that " +
    "killed it, with the reason string verbatim.\n\n" +
    "Use this to answer 'what happened to this run'. Three routes are merged here " +
    "(/api/control/sessions/:id/approve, /api/budget, /api/health/detail) and each part is reported " +
    "independently: a section comes back null with a `reason` rather than failing the whole call, because " +
    "a session whose event stream has aged out can still have cost data and vice versa.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: { sessionId: SESSION_ID },
  },
  async handle(args, client) {
    const sessionId = str(args, "sessionId");

    const [liveResult, budgetResult, healthResult] = await Promise.allSettled([
      client.get(path(sessionId, "/approve")),
      client.get("/api/budget", { sessionId }),
      client.get("/api/health/detail"),
    ]);

    const live =
      liveResult.status === "fulfilled"
        ? (() => {
            const value = record(liveResult.value);
            return {
              waiting: value.waiting,
              terminal: value.terminal,
              turnId: value.turnId,
              pendingRequests: value.pendingRequests,
              eventCount: typeof value.tailIndex === "number" ? value.tailIndex + 1 : null,
            };
          })()
        : null;
    const liveReason = liveResult.status === "rejected" ? describe(liveResult.reason) : null;

    const budget = budgetResult.status === "fulfilled" ? record(budgetResult.value) : null;
    const budgetReason = budgetResult.status === "rejected" ? describe(budgetResult.reason) : null;

    // /api/budget filters `events` by session but never filters `stops` — that
    // list is global. Narrowing it here is what makes "why did THIS run stop"
    // answerable without handing the model somebody else's stop row.
    const stops = arr(budget?.stops).filter((row) => record(row).session_id === sessionId);

    const rollup =
      healthResult.status === "fulfilled"
        ? (arr(record(healthResult.value).recentSessions).find((row) => record(row).id === sessionId) ??
          null)
        : null;

    if (live === null && budget?.session === undefined && rollup === null) {
      throw new ToolFailure(
        `No session '${sessionId}' is known to this evestack deployment. ` +
          `The control plane said: ${liveReason ?? "no detail"}. Check the id with list_sessions.`,
        { sessionId },
      );
    }

    return {
      sessionId,
      live,
      ...(liveReason ? { liveUnavailableReason: liveReason } : {}),
      // Present only when the session is among the five /api/health/detail returns.
      rollup,
      usage: budget?.session ?? null,
      ...(budgetReason ? { usageUnavailableReason: budgetReason } : {}),
      budgetStops: stops,
      budgetEvents: arr(budget?.events),
      limits: budget?.limits ?? null,
    };
  },
};

const listApprovals: ToolDefinition = {
  name: "list_approvals",
  title: "Read the approval audit log",
  mutating: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description:
    "READ-ONLY. Who approved or denied what, and when — the evestack.approvals audit log. Each row names " +
    "the session, the tool that was gated, the decision, the recorded approver and `approverVia`, which " +
    "says HOW that identity was established: 'session' (signed in to the dashboard) and 'basic' both " +
    "prove possession of the one shared deployment credential, so they name an installation rather than " +
    "a person; 'header', 'forwarded-user' and 'forwarded-email' name a person, but only as well as the " +
    "proxy in front of the dashboard does. Treat 'unidentified' rows as attributable to nobody.\n\n" +
    "TWO different truncations can shorten this answer and they are reported separately. " +
    "`moreRowsMayExist: true` means the DASHBOARD returned a full page against its own LIMIT, so there " +
    "are probably older decisions it did not send — raise `limit` or narrow with `sessionId`. A " +
    "`_truncated` object means THIS server's byte cap cut the page it did send. Either one makes the " +
    "list partial; say so rather than reporting it as the whole log.\n\n" +
    "REQUIRES a dashboard build that serves GET /api/approvals. If this tool reports the route is " +
    "missing, the deployment is older than that route and the fix is upgrading the dashboard, not a " +
    "change here.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: {
        type: "string",
        minLength: 1,
        description: "Restrict to one session. Omit for the whole log, newest first.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description:
          "Maximum rows to return. Omit it for the dashboard's own default, which is 200 rows for the " +
          "whole log but EVERY decision in the session (up to 1000) when sessionId is set — that is the " +
          "largest result this server can be asked for, and it will be capped and marked truncated.",
      },
    },
  },
  async handle(args, client) {
    try {
      const response = record(
        await client.get("/api/approvals", {
          sessionId: optionalStr(args, "sessionId"),
          // `absent`, not `=== undefined`: an explicit `limit: null` used to
          // become the literal query string `?limit=null`, which the route reads
          // as `Number("null")` — NaN — and answers 400 "'limit' must be an
          // integer between 1 and 1000" (app/api/approvals/route.ts:34). Omitting
          // `limit` is the documented way to get the route's own default, and
          // schema.ts:95-99 says null means omitted.
          limit: absent(args.limit) ? undefined : String(args.limit),
        }),
      );
      const approvals = arr(response.approvals ?? response.rows);
      return {
        count: approvals.length,
        // The DASHBOARD's truncation, which is a different thing from this
        // server's byte cap and was being thrown away. /api/approvals returns
        // `truncated: rows.length >= limit` (route.ts:71) — "a full page came
        // back, so there may be more" — and dropping it meant a 200-row answer
        // off an audit log with 40,000 rows in it arrived looking complete. That
        // is the same defect the `_truncated` notice exists to prevent, one layer
        // down, and an audit log is the worst place to have it: "who approved
        // this?" answered from a silently capped page reads as "nobody did".
        //
        // Absent rather than `false` when the dashboard did not say, because an
        // older build that predates the flag has told us nothing, and reporting
        // "not truncated" on its behalf would be inventing the reassurance.
        ...(typeof response.truncated === "boolean" ? { moreRowsMayExist: response.truncated } : {}),
        approvals,
      };
    } catch (error) {
      if (error instanceof DashboardError && (error.failure.status === 404 || error.failure.code === "not_json")) {
        throw new ToolFailure(
          `This dashboard (${client.baseUrl}) does not serve GET /api/approvals, so the approval audit ` +
            `log is not reachable over HTTP. The rows exist in Postgres (schema evestack, table approvals) ` +
            `and packages/dashboard/lib/approvals.ts already exports listApprovals() / ` +
            `listApprovalsForSession(); what is missing is a route handler at ` +
            `packages/dashboard/app/api/approvals/route.ts that calls them. Until it exists, read the ` +
            `audit log at ${client.baseUrl}/approvals in a browser. For what a session is waiting on ` +
            `RIGHT NOW (as opposed to what was already decided), use get_session instead.`,
          { route: "/api/approvals", status: error.failure.status },
        );
      }
      throw error;
    }
  },
};

const getCosts: ToolDefinition = {
  name: "get_costs",
  title: "Cost and budget rollups",
  mutating: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description:
    "READ-ONLY. Spend rollups from @evestack/budget plus lifetime totals: today's configured caps, " +
    "per-principal spend for the current budget day, every recorded budget stop with its reason string, " +
    "and the recent budget events. Pass `sessionId` to add that session's own running total.\n\n" +
    "Costs are computed by the dashboard from token counts and a local price table — a self-hosted agent " +
    "calls its provider directly, so no upstream service reports a price. Cost for a model missing from " +
    "that table shows up as `unpricedSteps`, not as zero dollars. If the budget hook has never run on " +
    "this deployment the tables do not exist yet and this tool says so.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: {
        type: "string",
        minLength: 1,
        description: "Add running totals for one session, and scope the event list to it.",
      },
    },
  },
  async handle(args, client) {
    const sessionId = optionalStr(args, "sessionId");
    const [budgetResult, healthResult] = await Promise.allSettled([
      client.get("/api/budget", { sessionId }),
      client.get("/api/health/detail"),
    ]);

    if (budgetResult.status === "rejected") {
      throw new ToolFailure(
        `The dashboard could not report budget data: ${describe(budgetResult.reason)}`,
        { sessionId: sessionId ?? null },
      );
    }

    const budget = record(budgetResult.value);
    return {
      budgetDay: budget.day,
      limits: budget.limits,
      session: budget.session ?? null,
      principals: arr(budget.principals),
      stops: arr(budget.stops),
      events: arr(budget.events),
      lifetimeTotals:
        healthResult.status === "fulfilled" ? record(healthResult.value).totals : null,
    };
  },
};

const promoteSessionToEval: ToolDefinition = {
  name: "promote_session_to_eval",
  title: "Turn a session into an eve eval",
  mutating: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description:
    "READ-ONLY (it generates source and returns it; it writes nothing anywhere). Replays a real session's " +
    "durable event log and generates an eve eval file from it — the user's actual messages become " +
    "`t.send(...)`, the tools the agent actually called become `calledTool(...)` assertions, and denials " +
    "become denial assertions.\n\n" +
    "The result is a DRAFT for a human to sharpen: the event log records what the agent did, never what " +
    "it should have done, so intent assertions come back commented out with the observed value inlined. " +
    "`warnings` lists what could not be recovered. Save `source` to evals/<filename> in the agent project " +
    "— eve derives eval identity from the file path, which is why the generated source carries no id or " +
    "name field.\n\n" +
    "ALL OR NOTHING. Unlike every other tool here, this one FAILS rather than return a shortened result: " +
    "a session long enough that its eval would not fit inside EVESTACK_MCP_MAX_OUTPUT_BYTES gets an error " +
    "naming the size and the two ways to get the file anyway. Half a TypeScript file does not compile, and " +
    "`source` is meant to be written to disk, not read.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: { sessionId: SESSION_ID },
  },
  async handle(args, client) {
    const sessionId = str(args, "sessionId");
    const generated = record(
      await client.get(`/api/evals/promote/${encodeURIComponent(sessionId)}`, { format: "json" }),
    );
    const result = {
      sessionId,
      filename: generated.filename,
      source: generated.source,
      warnings: arr(generated.warnings),
      saveTo: `evals/${String(generated.filename ?? "")}`,
    };

    // WHY THIS TOOL REFUSES WHERE THE OTHERS TRUNCATE.
    //
    // Everything else here returns data a model READS, and a shortened list that
    // says it is shortened is a worse answer but still an answer. This returns a
    // file a human is told to SAVE — this tool's own description says "Save
    // `source` to evals/<filename>". Run through the cap, a 72,080-character
    // eval came back clipped at 61,636 characters, and the last line of the file
    // the caller was told to save was:
    //
    //     await t.send("turn 352: please run the migration and repor
    //     …[10444 characters dropped by EVESTACK_MCP_MAX_OUTPUT_BYTES; see _truncated]
    //
    // — an unterminated string literal inside an unclosed function body. It does
    // not parse, let alone run. The truncation notice is honest about the bytes
    // and still leaves the caller holding something that cannot be used, and its
    // standing advice ("narrow the question") has no meaning for a tool whose
    // only argument is a session id. So: nothing, plus how to get the file.
    //
    // Measured with the same function server.ts will measure with, not an
    // estimate of it, so this can never refuse a result that would have fitted
    // or pass one that would not.
    const cap = client.maxOutputBytes;
    const resultBytes = payloadBytes(result);
    if (resultBytes > cap && fitToolPayload(result, cap).notice?.cuts.some((cut) => cut.path === "source")) {
      // Only when `source` itself is what gets cut. A pathological `warnings`
      // list is ordinary data and can be shortened like any other array.
      const sourceCharacters = typeof result.source === "string" ? result.source.length : 0;
      const download = `${client.baseUrl}/api/evals/promote/${encodeURIComponent(sessionId)}`;
      throw new ToolFailure(
        `The eval generated from session ${sessionId} is ${sourceCharacters} characters, and the whole ` +
          `result is ${resultBytes} bytes against this server's ${cap}-byte cap ` +
          `(EVESTACK_MCP_MAX_OUTPUT_BYTES). Nothing was returned, deliberately: the only thing that ` +
          `fits is a fragment of a TypeScript file, and a fragment does not compile. Two ways to get ` +
          `it: raise EVESTACK_MCP_MAX_OUTPUT_BYTES to at least ${resultBytes} in this server's entry ` +
          `in the MCP client config and call again, or download the file directly from ${download} ` +
          `(served as an attachment named ${String(result.filename ?? "the generated eval")}), which ` +
          `does not pass through this cap at all.`,
        {
          sessionId,
          filename: result.filename ?? null,
          sourceCharacters,
          resultBytes,
          maxOutputBytes: cap,
          raiseCapTo: resultBytes,
          downloadUrl: download,
          warnings: result.warnings,
        },
      );
    }

    return result;
  },
};

// ---------------------------------------------------------------------------
// Mutating — advertised only when EVESTACK_MCP_ALLOW_CONTROL is set
// ---------------------------------------------------------------------------

const startSession: ToolDefinition = {
  name: "start_session",
  title: "Start a new agent session",
  mutating: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description:
    "MUTATING. Starts a NEW eve agent run on this deployment and returns its session id. The agent will " +
    "call models, spend real money against the configured budget, and may execute tools in its sandbox. " +
    "There is no undo; the closest thing is cancel_run.\n\n" +
    "Returns as soon as the turn is accepted, not when it finishes. Poll get_session to see whether it " +
    "completed, failed, or parked waiting on a human decision.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      message: {
        type: "string",
        minLength: 1,
        description: "The first user message. Plain text.",
      },
      mode: {
        type: "string",
        enum: ["conversation", "task"],
        description:
          "'conversation' expects follow-ups; 'task' is one-shot. Omit to take the agent's default.",
      },
    },
  },
  async handle(args, client) {
    const response = record(
      await client.post("/api/control/sessions", body({ message: str(args, "message"), mode: args.mode })),
    );
    return {
      sessionId: response.sessionId,
      streamUrl: response.streamUrl,
      next: "Poll get_session with this sessionId to see how the turn settles.",
    };
  },
};

const sendMessage: ToolDefinition = {
  name: "send_message",
  title: "Send a follow-up to a live session",
  mutating: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description:
    "MUTATING. Sends a follow-up message to an existing session, which starts another turn: more model " +
    "calls, more spend, possibly more tool execution. Not for answering an approval prompt — use " +
    "approve_or_deny for that.\n\n" +
    "The continuation token rotates every turn and the dashboard resolves the current one for you, so " +
    "you normally omit it. Fails with `session_terminal` if the session has already ended (start a new " +
    "one) and with `session_busy` if a turn is still mid-flight.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "message"],
    properties: {
      sessionId: SESSION_ID,
      message: { type: "string", minLength: 1, description: "The follow-up user message." },
      continuationToken: {
        type: "string",
        minLength: 1,
        description: "Rarely needed. Omit and the dashboard reads the current one off the durable stream.",
      },
    },
  },
  async handle(args, client) {
    const sessionId = str(args, "sessionId");
    const response = record(
      await client.post(
        path(sessionId, "/message"),
        body({
          message: str(args, "message"),
          continuationToken: optionalStr(args, "continuationToken"),
        }),
      ),
    );
    return {
      sessionId: response.sessionId,
      resolvedContinuationToken: response.resolvedContinuationToken,
      next: "Poll get_session with this sessionId to see how the turn settles.",
    };
  },
};

const approveOrDeny: ToolDefinition = {
  name: "approve_or_deny",
  title: "Answer a parked human-in-the-loop request",
  mutating: true,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  description:
    "MUTATING, AND THE MOST CONSEQUENTIAL TOOL HERE. Answers a request that another agent's turn is " +
    "parked on, and resumes that turn. Approving a tool-approval request causes the gated tool to " +
    "actually execute — this is the gate a human was asked to stand at, so do not answer one on your own " +
    "initiative. Ask the person you are working with, and quote them the tool name and arguments from " +
    "get_session's `pendingRequests` before you do.\n\n" +
    "The decision is written to the evestack.approvals audit log under whatever identity this MCP server " +
    "was configured with (EVESTACK_MCP_APPROVER). The response echoes `approver` and `approverVia` so you " +
    "can see what was recorded; if `approver` is null the row says nobody. `audited: false` means the " +
    "decision took effect but the audit write failed.\n\n" +
    "Tool approvals take `decision`. Questions the agent asked take `optionId` or `text`. If the turn is " +
    "waiting on more than one request you must name one with `requestId`.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: {
      sessionId: SESSION_ID,
      decision: {
        type: "string",
        enum: ["approve", "deny"],
        description: "For a tool-approval request. 'approve' runs the gated tool for real.",
      },
      requestId: {
        type: "string",
        minLength: 1,
        description:
          "Which pending request to answer. Required when more than one is outstanding; get the ids from get_session.",
      },
      optionId: {
        type: "string",
        minLength: 1,
        description: "For a question: the id of the model-authored option to pick.",
      },
      text: { type: "string", description: "For a question that accepts freeform text." },
      message: {
        type: "string",
        minLength: 1,
        description: "An extra user message to deliver alongside the decision.",
      },
    },
  },
  async handle(args, client) {
    const sessionId = str(args, "sessionId");
    const response = record(
      await client.post(
        path(sessionId, "/approve"),
        body({
          decision: args.decision,
          requestId: optionalStr(args, "requestId"),
          optionId: optionalStr(args, "optionId"),
          text: typeof args.text === "string" ? args.text : undefined,
          message: optionalStr(args, "message"),
        }),
      ),
    );
    return {
      sessionId: response.sessionId,
      answered: response.answered,
      approver: response.approver ?? null,
      approverVia: response.approverVia ?? null,
      audited: response.audited,
      ...(response.approver
        ? {}
        : {
            attributionWarning:
              "This decision was recorded with no approver. Set EVESTACK_MCP_APPROVER on this MCP " +
              "server (and EVESTACK_REQUIRE_APPROVER=1 on the dashboard to refuse unattributed ones).",
          }),
    };
  },
};

const cancelRun: ToolDefinition = {
  name: "cancel_run",
  title: "Stop the in-flight turn",
  mutating: true,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  description:
    "MUTATING. Signals the session's in-flight turn to stop. Cancellation is cooperative and takes effect " +
    "between steps: a model call already in flight finishes and still bills. The session survives and can " +
    "still take follow-ups — this is a stop button, not a kill.\n\n" +
    "`status: 'no_active_turn'` is a success, not a failure: the turn had already settled, which is the " +
    "state you were trying to reach. Pass `turnId` (from get_session) to scope the cancel, so a late call " +
    "cannot kill a turn that started after you looked.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId"],
    properties: {
      sessionId: SESSION_ID,
      turnId: {
        type: "string",
        minLength: 1,
        description: "Only cancel if this is still the active turn. Strongly recommended.",
      },
    },
  },
  async handle(args, client) {
    const sessionId = str(args, "sessionId");
    const response = record(
      await client.post(path(sessionId, "/cancel"), body({ turnId: optionalStr(args, "turnId") })),
    );
    return { sessionId: response.sessionId, status: response.status };
  },
};

function describe(error: unknown): string {
  if (error instanceof DashboardError) {
    return error.failure.code ? `${error.failure.message} (${error.failure.code})` : error.failure.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export const TOOLS: readonly ToolDefinition[] = [
  listSessions,
  getSession,
  listApprovals,
  getCosts,
  promoteSessionToEval,
  startSession,
  sendMessage,
  approveOrDeny,
  cancelRun,
];
