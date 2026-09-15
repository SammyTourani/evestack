import { log } from "./stdio.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES_ENV,
  MIN_MAX_OUTPUT_BYTES,
} from "./truncate.js";

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
  /** Separate authority to answer decisions owned by a human. Requires control too. */
  readonly allowApprovals: boolean;
  /** Identity attached to approvals, or null to let the dashboard record `unidentified`. */
  readonly approver: string | null;
  /** Header the dashboard reads that identity from. */
  readonly approverHeader: string;
  /**
   * The `Authorization` header to send, ready to use.
   *
   * NOT always what the operator typed: a bare `user:password` is encoded into
   * `Basic …` on the way in, because that is the spelling the docs asked for and
   * the one the dashboard rejects. See `resolveAuthorization`.
   */
  readonly authorization: string | null;
  readonly timeoutMs: number;
  /** Ceiling on the pretty-printed JSON of one tool result. See truncate.ts. */
  readonly maxOutputBytes: number;
}

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

/**
 * `EVESTACK_MCP_DASHBOARD_AUTH`, and the 401 that documenting it wrongly caused.
 *
 * The value becomes the request's `Authorization` header. docs/mcp.mdx described
 * it as "`user:password` for the dashboard", and that is what people typed —
 * while this file handed the string to `headers.set("authorization", …)`
 * untouched (dashboard.ts). The dashboard's `verifyBasic` returns null for
 * anything not matching /^Basic /i (packages/dashboard/lib/auth.ts), so the
 * documented spelling authenticated nothing and every tool answered 401. The
 * package README said "verbatim" and was right; the docs page was the one that
 * was wrong, and the docs page is what a new user reads first.
 *
 * Correcting the documentation alone would have left the most natural thing to
 * type still broken, so both spellings are accepted:
 *
 *   user:password          encoded here as `Basic base64(user:password)`
 *   Basic dXNlcjpwYXNz     sent exactly as given
 *   Bearer <token>         sent exactly as given, likewise any other scheme
 *
 * HOW THEY ARE TOLD APART, and why this cannot break an install that works
 * today. A valid `Authorization` value is `<scheme> <credentials>`, and no
 * scheme token may contain a colon (RFC 9110 §11.1: it is a `token`, and ":" is
 * not a token character). So: if the value begins with a run of non-colon,
 * non-space characters followed by whitespace and something else, it already
 * carries a scheme and is passed through. Every value that works today matches
 * that, which is the whole safety argument — the only strings whose behaviour
 * changes are ones the dashboard was already rejecting.
 *
 * What is left is encoded when it contains a colon, and passed through when it
 * does not. A schemeless value with no colon (a bare proxy token, say) is not a
 * username and password, so guessing at one would be worse than leaving it
 * alone.
 *
 * EVESTACK_MCP_DASHBOARD_AUTH_VERBATIM=1 restores the old unconditional
 * pass-through, for the one case this rule reads wrong: a proxy that wants a
 * schemeless header value which happens to contain a colon. Nobody should need
 * it, and it exists so that "we changed what your config means" is never the
 * answer to a support question.
 */
function resolveAuthorization(env: NodeJS.ProcessEnv): string | null {
  const raw = env.EVESTACK_MCP_DASHBOARD_AUTH?.trim();
  if (!raw) return null;
  if (truthy(env.EVESTACK_MCP_DASHBOARD_AUTH_VERBATIM)) return raw;

  const carriesScheme = /^[^\s:]+\s+\S/u.test(raw);
  if (carriesScheme || !raw.includes(":")) return raw;

  // Said out loud once at startup, without the value. An operator who typed one
  // thing and sees another on the wire should be able to find out why from this
  // server's own log rather than from a packet capture.
  log(
    "EVESTACK_MCP_DASHBOARD_AUTH has no auth scheme and contains a colon, so it is being read " +
      "as user:password and sent as HTTP Basic. Set EVESTACK_MCP_DASHBOARD_AUTH_VERBATIM=1 to " +
      "send it exactly as written instead.",
  );
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // NOT `EVESTACK_DASHBOARD_URL`. That name is already taken by the agent's
  // OTLP exporter and holds a full path to the ingest endpoint
  // (`http://localhost:4000/api/ingest/v1/traces`), so a user with both set in
  // one .env would silently point this server at the trace collector.
  const raw = env.EVESTACK_MCP_DASHBOARD_URL?.trim() || "http://localhost:4000";
  let dashboardUrl: string;
  try {
    dashboardUrl =
      new URL(raw).origin + new URL(raw).pathname.replace(/\/+$/, "");
  } catch {
    throw new Error(
      `EVESTACK_MCP_DASHBOARD_URL is not a valid URL: ${JSON.stringify(raw)}. ` +
        `Expected something like http://localhost:4000`,
    );
  }

  const timeoutRaw = env.EVESTACK_MCP_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `EVESTACK_MCP_TIMEOUT_MS must be a positive number of milliseconds, got ${timeoutRaw}.`,
    );
  }

  // The one knob that costs money when it is wrong in either direction: too low
  // and every answer arrives shortened, too high and one `list_approvals` puts
  // 140k tokens of audit log into the context window (measured — see the table
  // in truncate.ts). Rejected rather than clamped, for the same reason
  // EVESTACK_MCP_TIMEOUT_MS above is: an operator who typed a number meant it,
  // and silently substituting another one is how a cap gets blamed for
  // truncating at a size nobody configured.
  // Read by its literal name, not through MAX_OUTPUT_BYTES_ENV, and not as a
  // style preference: contract 19 greps the workspace for each documented
  // variable at a READ site, so an indirected lookup is invisible to it and the
  // variable reads as documented-but-dead. That contract exists because
  // EVESTACK_DAILY_BUDGET_USD was a two-word transposition nothing read, and
  // the spend monitor answered "no cap is configured" on every install for the
  // life of the file. The constant stays for the messages below, where the name
  // is being reported rather than looked up.
  const maxOutputRaw = env.EVESTACK_MCP_MAX_OUTPUT_BYTES?.trim();
  const maxOutputBytes = maxOutputRaw
    ? Number(maxOutputRaw)
    : DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < MIN_MAX_OUTPUT_BYTES
  ) {
    throw new Error(
      `${MAX_OUTPUT_BYTES_ENV} must be a whole number of bytes >= ${MIN_MAX_OUTPUT_BYTES}, got ` +
        `${JSON.stringify(maxOutputRaw)}. Below ${MIN_MAX_OUTPUT_BYTES} the truncation notice itself ` +
        `stops fitting, and a cap that cannot say it truncated is worse than no cap. ` +
        `The default is ${DEFAULT_MAX_OUTPUT_BYTES} (64 KiB, roughly 16k tokens).`,
    );
  }

  const approver = env.EVESTACK_MCP_APPROVER?.trim() || null;
  // Deliberately the same variable the dashboard reads, so one line in a shared
  // .env configures both ends of the same handshake. Default matches the header
  // lib/approvals.ts falls back to.
  const approverHeader =
    env.EVESTACK_APPROVER_HEADER?.trim() || "x-forwarded-user";

  const config: Config = {
    dashboardUrl,
    allowControl: truthy(env.EVESTACK_MCP_ALLOW_CONTROL),
    allowApprovals: truthy(env.EVESTACK_MCP_ALLOW_APPROVALS),
    approver,
    approverHeader,
    authorization: resolveAuthorization(env),
    timeoutMs,
    maxOutputBytes,
  };

  if (
    config.allowControl &&
    config.allowApprovals &&
    config.approver === null
  ) {
    // Worth saying out loud at startup rather than at the moment a decision is
    // recorded with nobody's name on it.
    log(
      "control tools are ENABLED but EVESTACK_MCP_APPROVER is unset — approvals made through " +
        "this server will be recorded as 'unidentified'.",
    );
  }

  return config;
}
