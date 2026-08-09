import type { Config } from "./config.js";
import { VERSION } from "./version.js";

/**
 * A thin client over the dashboard's HTTP routes. Nothing here knows SQL.
 *
 * That is the whole architectural rule of this package: the dashboard already
 * owns the queries, the pricing table, the approval audit and the eve protocol
 * plumbing, and a second implementation of any of it would drift within a week.
 * If a capability has no route, this package does not get to invent one — see
 * the "Missing routes" section of the README for the ones that are still owed.
 */

export interface DashboardFailure {
  readonly status: number;
  /** The `code` field the control routes attach, when there is one. */
  readonly code: string | null;
  readonly message: string;
  readonly body: unknown;
}

export class DashboardError extends Error {
  readonly failure: DashboardFailure;

  constructor(failure: DashboardFailure) {
    super(failure.message);
    this.name = "DashboardError";
    this.failure = failure;
  }
}

/** Raised when the dashboard cannot be reached at all, which is a different fix. */
export class DashboardUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not reach the evestack dashboard at ${url} (${detail}). Start it with ` +
        `\`pnpm --filter @evestack/dashboard dev\`, or set EVESTACK_MCP_DASHBOARD_URL to where it runs.`,
    );
    this.name = "DashboardUnreachableError";
  }
}

export class DashboardClient {
  readonly #config: Config;
  /** Set from the MCP `initialize` handshake so audit rows name the real caller. */
  #clientLabel = "unknown-client";

  constructor(config: Config) {
    this.#config = config;
  }

  get baseUrl(): string {
    return this.#config.dashboardUrl;
  }

  /**
   * The tool-result cap server.ts will apply to whatever a handler returns.
   *
   * Exposed because one handler has to know it. promote_session_to_eval returns
   * a TypeScript file the caller is told to save, and a file clipped to fit a
   * byte cap does not compile — so that tool refuses when its result would be
   * cut rather than handing back source that cannot be used. It needs the same
   * number `#toolResult` will measure against, not a guess at it. See
   * tools.ts:promoteSessionToEval.
   */
  get maxOutputBytes(): number {
    return this.#config.maxOutputBytes;
  }

  identifyClient(name: string, version: string): void {
    const clean = (value: string) => value.replace(/[^\w.\-/ ]/g, "").slice(0, 64) || "unknown";
    this.#clientLabel = `${clean(name)}/${clean(version)}`;
  }

  async get(path: string, query?: Record<string, string | undefined>): Promise<unknown> {
    return this.#request("GET", path, query, undefined);
  }

  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.#request("POST", path, undefined, body);
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string | undefined> | undefined,
    body: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const url = new URL(this.#config.dashboardUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers = new Headers({
      accept: "application/json",
      // The dashboard writes this into evestack.approvals.user_agent. Recording
      // *which* MCP client drove a decision is the one piece of provenance this
      // server can always supply honestly, even when nobody configured an
      // approver identity — see the README on identity vs. provenance.
      "user-agent": `evestack-mcp/${VERSION} (${this.#clientLabel})`,
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (this.#config.authorization) headers.set("authorization", this.#config.authorization);
    if (this.#config.approver) headers.set(this.#config.approverHeader, this.#config.approver);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#config.timeoutMs),
      });
    } catch (cause) {
      throw new DashboardUnreachableError(url.toString(), cause);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      // Next serves an HTML error page for an unmatched route, so a body that is
      // not JSON is itself the diagnosis: the route does not exist on this build.
      parsed = undefined;
    }

    const record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};

    if (!response.ok) {
      throw new DashboardError({
        status: response.status,
        code: typeof record.code === "string" ? record.code : null,
        message:
          typeof record.error === "string"
            ? record.error
            : `${method} ${url.pathname} failed with HTTP ${response.status}.`,
        body: parsed,
      });
    }

    // `/api/budget` answers a missing-tables condition with HTTP 200 and
    // `ok: false`, because "the budget hook has never run" is not a server
    // fault. Treating the envelope as authoritative rather than the status code
    // is what keeps that distinction intact.
    if (record.ok === false) {
      throw new DashboardError({
        status: response.status,
        code: typeof record.code === "string" ? record.code : null,
        message: typeof record.error === "string" ? record.error : "The dashboard reported ok:false.",
        body: parsed,
      });
    }

    if (parsed === undefined) {
      throw new DashboardError({
        status: response.status,
        code: "not_json",
        message:
          `${method} ${url.pathname} returned ${response.status} but the body was not JSON. ` +
          `That usually means this dashboard build does not serve that route.`,
        body: text.slice(0, 400),
      });
    }

    return parsed;
  }
}
