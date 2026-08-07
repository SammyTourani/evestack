import type { Config } from "./config.js";
import { VERSION } from "./version.js";
import { DashboardClient, DashboardError, DashboardUnreachableError } from "./dashboard.js";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  RpcError,
  paramsObject,
  type JsonRpcRequest,
} from "./jsonrpc.js";
import { assertSupported, validateArguments } from "./schema.js";
import { log } from "./stdio.js";
import { TOOLS, ToolFailure, type ToolDefinition } from "./tools.js";

/**
 * MCP method dispatch.
 *
 * TARGET SPEC REVISION: 2025-11-25 (the latest initialization-based revision),
 * negotiating down to 2025-06-18, 2025-03-26 and 2024-11-05. Verified against
 * https://modelcontextprotocol.io/specification/2025-11-25/ on 2026-08-05.
 *
 * WHY NOT 2026-07-28. The current revision drops the `initialize` handshake in
 * favour of per-request `_meta` and a mandatory `server/discover`. Every client
 * that ships today — Claude Code, Claude Desktop, the Inspector — still opens
 * with `initialize`, and the spec's own compatibility matrix says a modern
 * client detects a legacy server by probing `server/discover` and falling back
 * on any error that is not a recognized modern error. This server therefore
 * answers `server/discover` with a plain -32601, which is exactly the signal
 * that triggers that fallback. Going dual-era is a real option later; claiming
 * it before it is tested would be worse than not claiming it.
 */

const PREFERRED_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const SERVER_INFO = {
  name: "evestack",
  title: "evestack control plane",
  version: VERSION,
} as const;

const INSTRUCTIONS = [
  "This server is the control plane for a self-hosted evestack/eve agent fleet — the same data the",
  "evestack dashboard shows, reachable as tools.",
  "",
  "Start with list_sessions to find a run, then get_session for what happened to it (including the",
  "verbatim reason a budget stopped it, and what a parked turn is waiting on). get_costs answers spend",
  "questions. promote_session_to_eval turns a real session into a regression test.",
  "",
  "Tools whose description starts with MUTATING act on a live agent: they spend money, execute tools in",
  "the agent's sandbox, or answer an approval prompt a human was supposed to answer. Confirm with the",
  "person you are working with before calling one — especially approve_or_deny, which is the gate.",
].join("\n");

interface HandlerResult {
  /** Absent for notifications, which must never be answered. */
  readonly response?: unknown;
}

export class McpServer {
  readonly #config: Config;
  readonly #client: DashboardClient;
  readonly #tools: Map<string, ToolDefinition>;
  #negotiatedVersion = PREFERRED_PROTOCOL_VERSION;
  #initialized = false;

  constructor(config: Config) {
    this.#config = config;
    this.#client = new DashboardClient(config);
    this.#tools = new Map();
    for (const tool of TOOLS) {
      if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool name '${tool.name}'.`);
      // Fail at startup, not at call time, if a schema uses a keyword the
      // hand-rolled validator does not enforce — an unenforced constraint that
      // still appears in tools/list is a lie to the model.
      assertSupported(tool.inputSchema, `tool ${tool.name} inputSchema`);
      this.#tools.set(tool.name, tool);
    }
  }

  /** Tools an MCP client is allowed to see. The safety gate lives here. */
  get advertisedTools(): ToolDefinition[] {
    return TOOLS.filter((tool) => !tool.mutating || this.#config.allowControl);
  }

  async handle(request: JsonRpcRequest): Promise<HandlerResult> {
    const isNotification = request.id === undefined;

    if (isNotification) {
      // Notifications get no response, not even for an unknown method. That
      // includes `notifications/initialized`: there is nothing to record, because
      // the gate below is the initialize *request* — see #assertInitialized.
      return {};
    }

    switch (request.method) {
      case "initialize": {
        const response = this.#initialize(request.params);
        // After, not before: a malformed handshake must not count as one.
        this.#initialized = true;
        return { response };
      }
      case "ping":
        // Utilities/ping: an empty result is the entire contract, and the spec
        // exempts it from the handshake ordering rule.
        return { response: {} };
      case "tools/list":
        this.#assertInitialized(request.method);
        return { response: this.#listTools(request.params) };
      case "tools/call":
        this.#assertInitialized(request.method);
        return { response: await this.#callTool(request.params) };
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${request.method}`, {
          supported: ["initialize", "ping", "tools/list", "tools/call"],
        });
    }
  }

  /**
   * The handshake is a precondition, not bookkeeping.
   *
   * `#initialized` was written and never read, so `tools/call` worked before
   * `initialize` ever arrived. That is forbidden by the lifecycle spec ("the
   * client SHOULD NOT send requests other than pings before the server has
   * responded to the initialize request"), and here it costs something concrete:
   * the client's name and version arrive in that handshake and become the
   * `User-Agent` the dashboard writes into `evestack.approvals.user_agent`. An
   * `approve_or_deny` accepted before it would record a real tool approval
   * against "unknown-client" — and provenance is the one thing this server can
   * always supply honestly, even when nobody configured an approver.
   *
   * The gate is the initialize REQUEST, not `notifications/initialized`. The spec
   * ties the client's constraint to the initialize *response*, and a client may
   * legitimately pipeline its first real request behind that response without
   * having sent the notification yet; gating on the notification would reject
   * well-behaved clients.
   *
   * -32600 rather than a bespoke code, because MCP adds none below -32000 (see
   * jsonrpc.ts). The request is well formed; it is the state that makes it
   * invalid.
   */
  #assertInitialized(method: string): void {
    if (this.#initialized) return;
    throw new RpcError(
      INVALID_REQUEST,
      `Received '${method}' before 'initialize'. MCP requires the initialize handshake first, ` +
        `and it is also where this server learns which client to name in the approval audit log.`,
      { reason: "not_initialized", method },
    );
  }

  #initialize(params: unknown): unknown {
    const parsed = paramsObject(params);
    const requested = typeof parsed.protocolVersion === "string" ? parsed.protocolVersion : null;

    // Spec: echo the client's version when we support it, otherwise answer with
    // ours and let the client decide whether to disconnect. Not an error case.
    this.#negotiatedVersion =
      requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : PREFERRED_PROTOCOL_VERSION;

    const clientInfo = paramsObject(parsed.clientInfo);
    const name = typeof clientInfo.name === "string" ? clientInfo.name : "unknown-client";
    const version = typeof clientInfo.version === "string" ? clientInfo.version : "0";
    this.#client.identifyClient(name, version);

    log(
      `initialize from ${name}/${version} — protocol ${this.#negotiatedVersion}, ` +
        `${this.advertisedTools.length} tools, control ${this.#config.allowControl ? "ENABLED" : "disabled"}`,
    );

    return {
      protocolVersion: this.#negotiatedVersion,
      // listChanged: false is the honest value — the tool set is fixed by the
      // environment at launch, so there is nothing to notify about.
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    };
  }

  #listTools(params: unknown): unknown {
    const parsed = paramsObject(params);
    if (parsed.cursor !== undefined && parsed.cursor !== null) {
      // The whole list fits in one page, so this server never issues a cursor.
      // Per the pagination spec an unrecognized one is -32602, not an empty page.
      throw new RpcError(INVALID_PARAMS, "Invalid cursor: this server returns all tools in one page.");
    }

    return {
      tools: this.advertisedTools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      })),
    };
  }

  async #callTool(params: unknown): Promise<unknown> {
    const parsed = paramsObject(params);
    const name = parsed.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new RpcError(INVALID_PARAMS, "Expected 'name' to be a non-empty tool name.");
    }

    const tool = this.#tools.get(name);
    if (!tool) {
      throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`, {
        reason: "unknown_tool",
        available: this.advertisedTools.map((entry) => entry.name),
      });
    }

    if (tool.mutating && !this.#config.allowControl) {
      // A protocol error rather than `isError: true`, deliberately. isError is
      // for failures a model should reason about and retry; this one is a
      // deployment policy the model cannot satisfy by trying again, and the
      // person who can fix it is the operator reading the client's logs.
      //
      // -32602 rather than -32601 because the JSON-RPC method (`tools/call`)
      // does exist — it is the `name` parameter that is not acceptable, which is
      // the same code the spec uses for an unknown tool.
      throw new RpcError(
        INVALID_PARAMS,
        `Tool '${name}' is disabled: this evestack MCP server is running read-only. It mutates a live ` +
          `agent (spending money, executing tools, or answering an approval a human owns), so the ` +
          `mutating tools are withheld unless the operator opts in with EVESTACK_MCP_ALLOW_CONTROL=1 ` +
          `in the MCP client's server config. Ask the operator; you cannot enable it yourself.`,
        {
          reason: "control_disabled",
          tool: name,
          enableWith: "EVESTACK_MCP_ALLOW_CONTROL=1",
          available: this.advertisedTools.map((entry) => entry.name),
        },
      );
    }

    const args = validateArguments(name, parsed.arguments, tool.inputSchema);

    try {
      const value = await tool.handle(args, this.#client);
      return toolResult(value, false);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (
        error instanceof ToolFailure ||
        error instanceof DashboardError ||
        error instanceof DashboardUnreachableError
      ) {
        // Everything the dashboard rejects is business logic the model can act
        // on — a stale session id, a turn that already ended, an ambiguous
        // approval. Those belong in the result so the model sees them, per the
        // spec's split between protocol errors and tool execution errors.
        return toolResult(
          {
            error: error.message,
            ...(error instanceof DashboardError
              ? { code: error.failure.code, status: error.failure.status }
              : {}),
            ...(error instanceof ToolFailure && error.detail ? { detail: error.detail } : {}),
          },
          true,
        );
      }
      log(`tool ${name} threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      throw new RpcError(INTERNAL_ERROR, `Tool '${name}' failed unexpectedly.`);
    }
  }
}

/**
 * Both shapes, always.
 *
 * `structuredContent` is what a client should read; the serialized copy in a
 * text block is what the spec asks for so a pre-2025-06-18 client — or a model
 * whose client drops unknown fields — still sees the data.
 */
function toolResult(value: unknown, isError: boolean): unknown {
  const structured =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError,
  };
}
