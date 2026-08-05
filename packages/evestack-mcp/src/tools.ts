import { DashboardClient, DashboardError } from "./dashboard.js";
import type { JsonSchema } from "./schema.js";

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

/** Only the shape a control route needs; `undefined` keys are dropped by JSON.stringify. */
function body(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

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
    "LIMIT: the dashboard's /api/health route returns a fixed five most-recent sessions, so this tool " +
    "cannot page or filter. `totals.sessions` tells you how many exist; `listed` tells you how many came " +
    "back. If you need an older session you must already know its id — pass it straight to get_session.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  async handle(_args, client) {
    const health = record(await client.get("/api/health"));
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
    "(/api/control/sessions/:id/approve, /api/budget, /api/health) and each part is reported " +
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
      client.get("/api/health"),
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
      // Present only when the session is among the five /api/health returns.
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
    "says HOW that identity was established ('header' / 'forwarded-user' / 'basic' / 'unidentified'). " +
    "Treat `unidentified` rows as attributable to nobody.\n\n" +
    "REQUIRES a dashboard build that serves GET /api/approvals. As of dashboard 0.1.0 that route does " +
    "not exist — the data and the queries do (lib/approvals.ts) but only the /approvals HTML page reads " +
    "them. If this tool reports the route is missing, that is the reason, and the fix is one route file " +
    "in the dashboard, not a change here.",
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
        description: "Maximum rows to return. Defaults to the dashboard's own limit.",
      },
    },
  },
  async handle(args, client) {
    try {
      const response = record(
        await client.get("/api/approvals", {
          sessionId: optionalStr(args, "sessionId"),
          limit: args.limit === undefined ? undefined : String(args.limit),
        }),
      );
      const approvals = arr(response.approvals ?? response.rows);
      return { count: approvals.length, approvals };
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
      client.get("/api/health"),
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
    "name field.",
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
    return {
      sessionId,
      filename: generated.filename,
      source: generated.source,
      warnings: arr(generated.warnings),
      saveTo: `evals/${String(generated.filename ?? "")}`,
    };
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
