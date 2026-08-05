import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * Tailscale, HTTP Basic). So we read identity from the request and always
 * record HOW we learned it. An unidentified approval is still recorded, marked
 * `unidentified`, because a silent gap in an audit log is worse than a visible
 * one. Set EVESTACK_REQUIRE_APPROVER=1 to refuse those outright.
 */

export interface ApproverIdentity {
  readonly approver: string | null;
  /** How the identity was established — never let a proxy header look proven. */
  readonly via: "basic" | "forwarded-user" | "forwarded-email" | "header" | "unidentified";
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
 * Order matters: an explicitly configured header wins, then the two headers
 * standard proxies set, then Basic. Basic is last because it is the weakest —
 * evestack generates a single shared credential, so it identifies a deployment
 * rather than a person, and calling that an approver identity would overstate
 * it. It is still better than nothing and is recorded as `basic` so a reader
 * knows exactly how much to trust it.
 */
export function identifyApprover(request: Request): ApproverIdentity {
  const configured = process.env.EVESTACK_APPROVER_HEADER;
  if (configured) {
    const value = request.headers.get(configured)?.trim();
    if (value) return { approver: value, via: "header" };
  }

  const forwardedUser = request.headers.get("x-forwarded-user")?.trim();
  if (forwardedUser) return { approver: forwardedUser, via: "forwarded-user" };

  const forwardedEmail = request.headers.get("x-forwarded-email")?.trim();
  if (forwardedEmail) return { approver: forwardedEmail, via: "forwarded-email" };

  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const user = decoded.slice(0, decoded.indexOf(":"));
      if (user) return { approver: user, via: "basic" };
    } catch {
      // A malformed header is not an identity. Fall through.
    }
  }

  return { approver: null, via: "unidentified" };
}

/** True when the deployment insists every decision names a human. */
export function requiresApprover(): boolean {
  const value = process.env.EVESTACK_REQUIRE_APPROVER;
  return value === "1" || value?.toLowerCase() === "true";
}

let schemaReady: Promise<void> | null = null;

export function ensureApprovalSchema(): Promise<void> {
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
