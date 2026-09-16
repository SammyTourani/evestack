import { open } from "node:fs/promises";
import { resolve } from "node:path";

export const HEARTBEAT_ACK = "<eve-empty-delivery/>";
const MAX_TASK_BYTES = 64 * 1024;
type Environment = Record<string, string | undefined>;

/** Checked at dispatch time, including catch-up. No missed quiet-hour work is queued. */
export function heartbeatQuietState(
  env: Environment = process.env,
  now = new Date(),
) {
  const hours = env.EVESTACK_HEARTBEAT_QUIET_HOURS?.trim() || null;
  const timeZone = env.EVESTACK_HEARTBEAT_QUIET_TIMEZONE?.trim() || "UTC";
  if (!Number.isFinite(now.getTime()))
    throw new Error("Use a valid preview time.");
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    throw new Error(
      "EVESTACK_HEARTBEAT_QUIET_TIMEZONE must be an IANA timezone, such as America/Toronto.",
    );
  }
  if (!hours) return { quiet: false, hours, timeZone };
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(hours);
  if (!match)
    throw new Error(
      "EVESTACK_HEARTBEAT_QUIET_HOURS must use HH:MM-HH:MM, for example 22:00-08:00.",
    );
  const values = match.slice(1).map(Number);
  if (values[0] > 23 || values[2] > 23 || values[1] > 59 || values[3] > 59)
    throw new Error("Quiet hours need hours 00–23 and minutes 00–59.");
  const start = values[0] * 60 + values[1],
    end = values[2] * 60 + values[3];
  if (start === end)
    throw new Error(
      "Quiet hours must have different start and end times. Disable the heartbeat to stop it all day.",
    );
  const minute =
    Number(parts.find((p) => p.type === "hour")!.value) * 60 +
    Number(parts.find((p) => p.type === "minute")!.value);
  const quiet =
    start < end
      ? minute >= start && minute < end
      : minute >= start || minute < end;
  return { quiet, hours, timeZone };
}

/** Read the same bounded file for preview and execution; permission/read errors remain failures. */
export async function readHeartbeatTasks(
  env: Environment = process.env,
  cwd = process.cwd(),
) {
  const path = resolve(
    cwd,
    env.EVESTACK_HEARTBEAT_FILE?.trim() || "HEARTBEAT.md",
  );
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      "Could not open HEARTBEAT.md. Check its path and read permissions.",
    );
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_TASK_BYTES)
      throw new Error(
        "HEARTBEAT.md must be a regular file no larger than 64 KiB.",
      );
    const bytes = Buffer.alloc(MAX_TASK_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        size,
        bytes.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_TASK_BYTES)
      throw new Error("HEARTBEAT.md grew beyond 64 KiB.");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, size),
      );
    } catch {
      throw new Error("HEARTBEAT.md must be valid UTF-8.");
    }
    // Commented examples do not become instructions merely because the channel was enabled.
    return text.replace(/<!--[\s\S]*?-->/g, "").trim() || null;
  } finally {
    await file.close();
  }
}

export function heartbeatTarget(
  env: Environment = process.env,
): Record<string, unknown> {
  const raw = env.EVESTACK_HEARTBEAT_TARGET;
  if (!raw)
    throw new Error(
      "EVESTACK_HEARTBEAT_CHANNEL is set but EVESTACK_HEARTBEAT_TARGET is not. Set the channel's recipient JSON before running it.",
    );
  if (Buffer.byteLength(raw) > 4096)
    throw new Error("Heartbeat target JSON must be at most 4 KiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("EVESTACK_HEARTBEAT_TARGET is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("EVESTACK_HEARTBEAT_TARGET must be a JSON object.");
  return parsed as Record<string, unknown>;
}

export function heartbeatPrompt(tasks: string) {
  return (
    `${tasks}\n\n---\n` +
    `You are running as a scheduled heartbeat, not in a conversation. Work through the ` +
    `checks above. If nothing needs the user's attention, reply with exactly ${HEARTBEAT_ACK} and ` +
    `nothing else at all — no greeting, no explanation, nothing before or after it, because ` +
    `eve only suppresses a reply that is that marker and nothing else. Only write a real ` +
    `message when there is something they would want to be interrupted for.`
  );
}
