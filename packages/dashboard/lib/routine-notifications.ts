import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "./db";
import {
  postNotificationBody,
  resolveSinks,
  sinkKey,
  type SinkKind,
} from "./alert-delivery";
import type { RoutineRun } from "./routines";

interface Notice {
  source: "evestack";
  type: "routine";
  runId: string;
  routineId: string;
  name: string;
  outcome: string;
  revision: number;
  sessionId: string | null;
  href: string;
}
export interface RoutineNotification {
  id: string;
  run_id: string;
  routine_id: string;
  sink_key: string;
  sink_kind: SinkKind;
  payload: Notice;
  state: "pending" | "sending" | "sent" | "failed" | "retired";
  attempts: number;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
}
export type RoutineNotificationSummary = Omit<RoutineNotification, "sink_key" | "payload">;

/** Called in the transaction that records the run state, so a crash cannot lose the notification. */
export async function queueRoutineNotification(
  client: PoolClient,
  run: RoutineRun,
  requestIds: string[] = [],
) {
  if (
    !["completed", "failed", "unknown", "awaiting_approval"].includes(run.state)
  )
    return;
  const sinks = resolveSinks(process.env).sinks;
  const decisionKey = createHash("sha256")
    .update(JSON.stringify([...requestIds].sort()))
    .digest("hex")
    .slice(0, 24);
  const eventKey = `${run.state}:${run.state === "awaiting_approval" ? decisionKey : "final"}`;
  const payload: Notice = {
    source: "evestack",
    type: "routine",
    runId: run.id,
    routineId: run.routine_id,
    name: run.snapshot.name,
    outcome: run.state,
    revision: run.revision,
    sessionId: run.session_id,
    href: run.session_id
      ? `/chat?session=${encodeURIComponent(run.session_id)}`
      : `/routines?routine=${run.routine_id}`,
  };
  for (const sink of sinks)
    await client.query(
      `INSERT INTO evestack.routine_notifications(id,run_id,routine_id,event_key,sink_key,sink_kind,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(run_id,event_key,sink_key) DO NOTHING`,
      [
        randomUUID(),
        run.id,
        run.routine_id,
        eventKey,
        sinkKey(sink.url),
        sink.kind,
        JSON.stringify(payload),
      ],
    );
}

export function routineNotificationBody(
  notice: Notice,
  kind: SinkKind,
  id: string,
  publicUrl = process.env.EVESTACK_PUBLIC_URL,
) {
  let url: string | null = null;
  try {
    const parsed = new URL(notice.href, publicUrl);
    if (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    )
      url = parsed.href;
  } catch {
    /* Relative link remains in the webhook payload. */
  }
  const text = `Eve Stack · ${notice.name}: ${notice.outcome.replaceAll("_", " ")}\nRevision ${notice.revision}. ${url ?? `Open ${notice.href} in your dashboard.`}`;
  if (kind === "slack")
    return JSON.stringify({
      text: text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
      unfurl_links: false,
      unfurl_media: false,
    });
  if (kind === "discord")
    return JSON.stringify({
      content: text.slice(0, 1900),
      allowed_mentions: { parse: [] },
    });
  return JSON.stringify({ ...notice, notificationId: id, url });
}

/** Successful destinations are never resent; ambiguous retries carry the same receiver deduplication ID. */
export async function deliverRoutineNotifications(limit = 4) {
  const sinks = new Map(
    resolveSinks(process.env).sinks.map((sink) => [sinkKey(sink.url), sink]),
  );
  const holder = randomUUID();
  await getPool().query(
    "UPDATE evestack.routine_notifications SET state='failed',error='Delivery remained unconfirmed after the final attempt. Check the destination before retrying.' WHERE state='sending' AND claimed_at < now()-interval '2 minutes' AND attempts >= 5",
  );
  const claimed = (
    await getPool().query<RoutineNotification>(
      `WITH next AS (
    SELECT id FROM evestack.routine_notifications
    WHERE (state='pending' AND next_attempt <= now()) OR (state='sending' AND claimed_at < now()-interval '2 minutes')
    ORDER BY next_attempt FOR UPDATE SKIP LOCKED LIMIT $1
  ) UPDATE evestack.routine_notifications n SET state='sending',holder=$2,claimed_at=now(),attempts=attempts+1
    FROM next WHERE n.id=next.id RETURNING n.*`,
      [Math.min(4, Math.max(1, limit)), holder],
    )
  ).rows;
  for (const notice of claimed) {
    const sink = sinks.get(notice.sink_key);
    if (!sink) {
      await getPool().query(
        "UPDATE evestack.routine_notifications SET state='retired',error='The configured destination was removed or changed.' WHERE id=$1 AND holder=$2",
        [notice.id, holder],
      );
      continue;
    }
    const result = await postNotificationBody(
      sink,
      routineNotificationBody(notice.payload, sink.kind, notice.id),
      notice.id,
    );
    await getPool().query(
      `UPDATE evestack.routine_notifications SET state=$3,error=$4,
      sent_at=CASE WHEN $3='sent' THEN now() ELSE NULL END,next_attempt=now()+($5 * interval '1 second')
      WHERE id=$1 AND holder=$2`,
      [
        notice.id,
        holder,
        result.ok ? "sent" : notice.attempts >= 5 ? "failed" : "pending",
        result.error,
        Math.min(300, 15 * 2 ** Math.min(5, notice.attempts)),
      ],
    );
  }
  return claimed.length;
}

export async function routineNotificationHistory(routineId: string) {
  return (
    await getPool().query<RoutineNotificationSummary>(
      "SELECT id,run_id,routine_id,sink_kind,state,attempts,error,created_at,sent_at FROM evestack.routine_notifications WHERE routine_id=$1 ORDER BY created_at DESC LIMIT 50",
      [routineId],
    )
  ).rows;
}

export function notificationTargetConfigured(key: string) {
  return resolveSinks(process.env).sinks.some(
    (sink) => sinkKey(sink.url) === key,
  );
}
