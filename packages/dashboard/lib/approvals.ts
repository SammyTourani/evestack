import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authenticate, trustsForwardedIdentity } from "./auth";
import { query } from "./db";

/**
 * Who approved what, and when.
 *
 * eve's protocol for human-in-the-loop carries no identity: a resumed turn
 * records that request X was answered with option Y, because that is all eve
 * needs to continue. Nothing anywhere says which human decided. That is fine
 * for a framework and unacceptable for a control plane — the whole objection to
 * a browser button that can approve a shell command is "approved by whom?", and
 * the honest answer has to be a row in a table, not a shrug.
 *
 * WHAT THIS DOES AND DOES NOT CLAIM. evestack does not ship an identity
 * provider and should not: the dashboard is meant to sit behind whatever the
 * deployment already trusts (a reverse proxy doing OAuth, Cloudflare Access,
 * Tailscale). So we read identity from the request and always record HOW we
 * learned it. An unidentified approval is still recorded, marked
 * `unidentified`, because a silent gap in an audit log is worse than a visible
 * one. Set EVESTACK_REQUIRE_APPROVER=1 to refuse those outright.
 */

export interface ApproverIdentity {
  readonly approver: string | null;
  /**
   * How the identity was established. Ordered here by how much it proves:
   *
   *   session          a signed cookie this deployment issued
   *   basic            HTTP Basic whose password this deployment verified
   *   forwarded-user   X-Forwarded-User, believed only behind EVESTACK_TRUSTED_PROXY
   *   forwarded-email  X-Forwarded-Email, same condition
   *   header           EVESTACK_APPROVER_HEADER, same condition
   *   unidentified     nothing proved anything
   *
   * `session` and `basic` prove possession of the one shared deployment
   * credential — they name an installation, not a person. The three forwarded
   * values name a person, but only as well as the proxy in front of us does.
   * Nothing here is allowed to read as more than it is.
   */
  readonly via:
    | "session"
    | "basic"
    | "forwarded-user"
    | "forwarded-email"
    | "header"
    | "unidentified";
}

export interface ApprovalRecord {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly requestId: string;
  readonly requestKind: string | null;
  readonly toolName: string | null;
  readonly optionId: string | null;
  readonly answerText: string | null;
  readonly identity: ApproverIdentity;
  readonly remoteAddr: string | null;
  readonly userAgent: string | null;
}

export interface ApprovalRow extends Omit<ApprovalRecord, "identity"> {
  readonly id: string;
  readonly decidedAt: string;
  readonly approver: string | null;
  readonly approverVia: string;
}

/**
 * Read the caller's identity off the request.
 *
 * WHAT WAS WRONG. This function used to take `X-Forwarded-User`,
 * `X-Forwarded-Email` and the Authorization username straight off the socket
 * with nothing in front of them. Every one of those is attacker-controlled:
 *
 *   curl -X POST .../approve -d '{"decision":"approve"}' \
 *        -H 'X-Forwarded-User: someone.else@example.com'
 *
 * approved a shell command and stamped a colleague's name on the row. The
 * Basic branch was no better — it read the username out of the header without
 * ever checking the password, so any name at all could be spelled into the
 * audit log. A forgeable audit log is worse than no audit log, because it
 * invites people to rely on it.
 *
 * WHAT IT DOES NOW. Forwarded identity is believed only when
 * EVESTACK_TRUSTED_PROXY says a proxy in front of us sets it and strips the
 * client's own copy (see trustsForwardedIdentity in lib/auth.ts). With that
 * unset the three header sources are not read at all — not read and downgraded,
 * not read and marked untrusted: ignored, so there is no path by which a
 * request can name someone it has not proved.
 *
 * Order still runs strongest-claim-about-a-person first. A trusted proxy names
 * an actual human, which is more informative than the shared deployment
 * credential underneath it; `session` and `basic` name the installation and are
 * recorded as such.
 */
export function identifyApprover(request: Request): ApproverIdentity {
  if (trustsForwardedIdentity(request)) {
    const configured = process.env.EVESTACK_APPROVER_HEADER;
    if (configured) {
      const value = request.headers.get(configured)?.trim();
      if (value) return { approver: value, via: "header" };
    }

    const forwardedUser = request.headers.get("x-forwarded-user")?.trim();
    if (forwardedUser) return { approver: forwardedUser, via: "forwarded-user" };

    const forwardedEmail = request.headers.get("x-forwarded-email")?.trim();
    if (forwardedEmail) return { approver: forwardedEmail, via: "forwarded-email" };
  }

  // A cookie this deployment signed, or Basic credentials it verified. Both are
  // proven; neither is a person. `authenticate` is the same function the proxy
  // gate uses, so an identity recorded here is one that was actually allowed in.
  const authenticated = authenticate(request);
  if (authenticated) return { approver: authenticated.user, via: authenticated.via };

  return { approver: null, via: "unidentified" };
}

/**
 * True when the deployment insists every decision names someone.
 *
 * Unchanged, and strictly stricter than it was: the identities that satisfy it
 * can no longer be invented by the caller. Worth knowing what it now buys you —
 * with route auth on, a decision that reaches the approve route has already
 * proved the deployment credential, so this flag only bites when that
 * credential names nobody. If you need per-person attribution, set
 * EVESTACK_TRUSTED_PROXY and put a proxy that authenticates people in front;
 * then `approver_via` reads `forwarded-user` rather than `session`.
 */
export function requiresApprover(): boolean {
  const value = process.env.EVESTACK_REQUIRE_APPROVER;
  return value === "1" || value?.toLowerCase() === "true";
}

let schemaReady: Promise<void> | null = null;

function ensureApprovalSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = query(readSchemaSql())
      .then(() => undefined)
      // Never cache a failed bootstrap, or a database that was briefly
      // unreachable stays "broken" for the life of the process.
      .catch((error: unknown) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

function readSchemaSql(): string {
  let dir = process.cwd();
  for (let up = 0; up < 5; up += 1) {
    try {
      return readFileSync(join(dir, "sql", "approvals.sql"), "utf8");
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `Could not find sql/approvals.sql above ${process.cwd()}. ` +
      "Run the dashboard from packages/dashboard, or apply the file by hand.",
  );
}

/**
 * Record a decision.
 *
 * Called AFTER eve accepts the answer, deliberately. Logging first would record
 * approvals that never took effect, and an audit log that overstates what
 * happened is worse than one that is a moment behind.
 */
export async function recordApproval(record: ApprovalRecord): Promise<void> {
  await ensureApprovalSchema();
  await query(
    `INSERT INTO evestack.approvals
       (session_id, turn_id, request_id, request_kind, tool_name,
        option_id, answer_text, approver, approver_via, remote_addr, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      record.sessionId,
      record.turnId,
      record.requestId,
      record.requestKind,
      record.toolName,
      record.optionId,
      record.answerText,
      record.identity.approver,
      record.identity.via,
      record.remoteAddr,
      record.userAgent,
    ],
  );
}

const SELECT = `
  SELECT id, decided_at, session_id, turn_id, request_id, request_kind, tool_name,
         option_id, answer_text, approver, approver_via, remote_addr, user_agent
  FROM evestack.approvals
`;

export async function listApprovals(limit = 200): Promise<ApprovalRow[]> {
  await ensureApprovalSchema();
  const rows = await query<Record<string, unknown>>(
    `${SELECT} ORDER BY decided_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows.map(toRow);
}

export async function listApprovalsForSession(sessionId: string): Promise<ApprovalRow[]> {
  await ensureApprovalSchema();
  const rows = await query<Record<string, unknown>>(
    `${SELECT} WHERE session_id = $1 ORDER BY decided_at ASC, id ASC`,
    [sessionId],
  );
  return rows.map(toRow);
}

function toRow(raw: Record<string, unknown>): ApprovalRow {
  return {
    id: String(raw.id),
    decidedAt: new Date(raw.decided_at as string | Date).toISOString(),
    sessionId: String(raw.session_id),
    turnId: (raw.turn_id as string) ?? null,
    requestId: String(raw.request_id),
    requestKind: (raw.request_kind as string) ?? null,
    toolName: (raw.tool_name as string) ?? null,
    optionId: (raw.option_id as string) ?? null,
    answerText: (raw.answer_text as string) ?? null,
    approver: (raw.approver as string) ?? null,
    approverVia: String(raw.approver_via ?? "unidentified"),
    remoteAddr: (raw.remote_addr as string) ?? null,
    userAgent: (raw.user_agent as string) ?? null,
  };
}
