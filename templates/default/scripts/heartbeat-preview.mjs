#!/usr/bin/env node
import {
  heartbeatQuietState,
  heartbeatPrompt,
  heartbeatTarget,
  readHeartbeatTasks,
} from "../lib/heartbeat.ts";
import { nextFire, parseCron } from "@evestack/schedules/cron";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "npm run heartbeat:preview -- [--at=ISO_TIMESTAMP] [--json]\nReads the exact prompt and quiet-hour gate without contacting an agent or channel.\nThe three cron times use this process's timezone; check the deployed host separately.",
  );
} else {
  try {
    if (
      args.some((arg) => arg !== "--json" && !arg.startsWith("--at=")) ||
      args.filter((arg) => arg.startsWith("--at=")).length > 1
    )
      throw new Error("Use --at=ISO_TIMESTAMP, --json or --help.");
    const rawTime = args.find((arg) => arg.startsWith("--at="))?.slice(5);
    if (
      rawTime !== undefined &&
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(rawTime)
    )
      throw new Error(
        "The preview timestamp needs an explicit timezone (Z or ±HH:MM).",
      );
    const now = rawTime ? new Date(rawTime) : new Date();
    const channel = process.env.EVESTACK_HEARTBEAT_CHANNEL?.trim() || null;
    if (channel && !["telegram", "slack", "discord"].includes(channel))
      throw new Error(
        "The heartbeat channel must be telegram, slack or discord.",
      );
    const cron = process.env.EVESTACK_HEARTBEAT_CRON?.trim() || "0 * * * *";
    parseCron(cron);
    const quiet = heartbeatQuietState(process.env, now);
    const tasks = await readHeartbeatTasks();
    const target = channel ? heartbeatTarget() : null;
    const next = [];
    let after = now;
    for (let i = 0; i < 3; i++) {
      const time = nextFire(cron, after);
      if (!time) break;
      next.push({
        at: time.toISOString(),
        quiet: heartbeatQuietState(process.env, time).quiet,
      });
      after = time;
    }
    const result = {
      enabled: !!channel,
      channel,
      target,
      cron,
      cronTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      checkedAt: now.toISOString(),
      quiet,
      next,
      wouldDispatchNow: !!channel && !!tasks && !quiet.quiet,
      prompt: tasks ? heartbeatPrompt(tasks) : null,
      note: "Preview only. No model call, channel send, credential check or schedule activation. Quiet hours skip new dispatches; they do not cancel work already running. File and environment changes can change the next fire. The agent uses the channel/cron from its startup environment.",
    };
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `Heartbeat: ${channel ? "enabled in this environment" : "off"}\nChannel: ${channel ?? "none"}\nTarget: ${target ? JSON.stringify(target) : "none"}\nCron: ${cron} (${result.cronTimeZone})\nQuiet hours: ${quiet.hours ?? "none"} (${quiet.timeZone})\nAt preview time: ${result.wouldDispatchNow ? "would dispatch if fired" : "would not dispatch"}`,
      );
      for (const occurrence of next)
        console.log(
          `  ${occurrence.at}${occurrence.quiet ? " — skipped for quiet hours" : ""}`,
        );
      console.log(
        `\n${result.note}\n\n${result.prompt ? "Prompt:\n" + result.prompt : "No active checks. Add your checks outside HTML comments in HEARTBEAT.md."}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Preview failed.";
    if (args.includes("--json"))
      console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exitCode = 1;
  }
}
