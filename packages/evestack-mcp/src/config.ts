import { log } from "./stdio.js";

/**
 * Everything this server reads from the environment.
 *
 * An MCP client launches this process with no arguments and no shell, so the
 * environment block in the client's config file is the entire configuration
 * surface. That makes each name part of the public API — hence the comments on
 * why each one is called what it is called.
 */

export interface Config {
  /** Origin of the evestack dashboard, no trailing slash. */
  readonly dashboardUrl: string;
  /** When false, the mutating tools are not advertised and cannot be called. */
  readonly allowControl: boolean;
  /** Identity attached to approvals, or null to let the dashboard record `unidentified`. */
  readonly approver: string | null;
  /** Header the dashboard reads that identity from. */
  readonly approverHeader: string;
  /** Verbatim `Authorization` value, for a dashboard behind a proxy that wants one. */
  readonly authorization: string | null;
  readonly timeoutMs: number;
}

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // NOT `EVESTACK_DASHBOARD_URL`. That name is already taken by the agent's
  // OTLP exporter and holds a full path to the ingest endpoint
  // (`http://localhost:4000/api/ingest/v1/traces`), so a user with both set in
  // one .env would silently point this server at the trace collector.
  const raw = env.EVESTACK_MCP_DASHBOARD_URL?.trim() || "http://localhost:4000";
  let dashboardUrl: string;
  try {
    dashboardUrl = new URL(raw).origin + new URL(raw).pathname.replace(/\/+$/, "");
  } catch {
    throw new Error(
      `EVESTACK_MCP_DASHBOARD_URL is not a valid URL: ${JSON.stringify(raw)}. ` +
        `Expected something like http://localhost:4000`,
    );
  }

  const timeoutRaw = env.EVESTACK_MCP_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`EVESTACK_MCP_TIMEOUT_MS must be a positive number of milliseconds, got ${timeoutRaw}.`);
  }

  const approver = env.EVESTACK_MCP_APPROVER?.trim() || null;
  // Deliberately the same variable the dashboard reads, so one line in a shared
  // .env configures both ends of the same handshake. Default matches the header
  // lib/approvals.ts falls back to.
  const approverHeader = env.EVESTACK_APPROVER_HEADER?.trim() || "x-forwarded-user";

  const config: Config = {
    dashboardUrl,
    allowControl: truthy(env.EVESTACK_MCP_ALLOW_CONTROL),
    approver,
    approverHeader,
    authorization: env.EVESTACK_MCP_DASHBOARD_AUTH?.trim() || null,
    timeoutMs,
  };

  if (config.allowControl && config.approver === null) {
    // Worth saying out loud at startup rather than at the moment a decision is
    // recorded with nobody's name on it.
    log(
      "control tools are ENABLED but EVESTACK_MCP_APPROVER is unset — approvals made through " +
        "this server will be recorded as 'unidentified'.",
    );
  }

  return config;
}
