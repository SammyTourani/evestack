import { spawn } from "node:child_process";

/**
 * `/dashboard` — open the control plane from inside `npm run dev`.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT A REAL SLASH COMMAND ─────────────
 *
 * eve's terminal UI has a slash-command registry, and it is a module-level
 * constant: `PROMPT_COMMAND_DEFINITIONS` in
 * `eve/dist/src/cli/dev/tui/prompt-commands.js`. `parsePromptCommand` walks that
 * array and nothing else. There is no registration function, no config key, and
 * no plugin point — verified by searching the whole of `dist/src/cli/dev` for
 * one. So `/dashboard` cannot be added to that list without forking eve, and
 * evestack does not fork eve.
 *
 * What the registry does instead is the opening we use: an unrecognised `/word`
 * is NOT an error. `parsePromptCommand` returns null and the UI sends the text
 * on as an ordinary message. That message arrives at this agent's own HTTP
 * channel, and `eveChannel({ onMessage })` is a documented pre-dispatch hook —
 * "runs after route auth and body parsing, before runtime dispatch"
 * (`eve/dist/src/eve-channel/types.d.ts`). It runs in the agent process, on the
 * host, with a real filesystem and a real browser.
 *
 * So the ACTION is deterministic and immediate: by the time the model is even
 * asked, the browser is already opening. What the hook cannot do is suppress
 * the turn — `EveMessageResult` has `auth`, `context` and `title` and no
 * `dispatch: false` — so the model still answers. That is why this returns a
 * `context` line telling it exactly what to say. The cost is one short turn;
 * the browser does not wait for it, and does not depend on it.
 *
 * ── WHERE ELSE THE DASHBOARD IS REACHABLE ────────────────────────────────────
 *
 * This is the fourth of five routes, and deliberately not the only one:
 *   1. `evestack create` opens it for you when it brings the stack up.
 *   2. `npx evestack dashboard` from any terminal, anywhere in the project.
 *   3. `npm run dashboard`, which sits next to `npm run dev` in package.json.
 *   4. `/dashboard` here, for when you are already typing in the agent.
 *   5. The URL is printed as a clickable link every time the agent boots.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────────────
 *
 * Only the eve HTTP channel gets this hook, so Telegram, Slack and Discord
 * messages never reach it — a stranger cannot make a window open on your
 * machine by typing a slash command at your bot. The remaining caller is the
 * dashboard's own chat page, which is already behind the deployment credential;
 * the interactivity gate below covers it anyway.
 */

/** Recognised spellings. `/dash` because people abbreviate, and it costs a line. */
const COMMANDS = new Set(["/dashboard", "/dash"]);

/**
 * Repeats inside this window do not open a second window.
 *
 * A held Enter key, or a client that retries a delivery, would otherwise put one
 * browser tab on screen per attempt. The command is idempotent for the length of
 * a human's patience; that is the whole requirement.
 */
const REOPEN_COOLDOWN_MS = 3000;
let lastOpenedAt = 0;

/** How long to wait for the dashboard to say it is up before answering. */
const HEALTH_TIMEOUT_MS = 1200;

export interface SlashCommandOutcome {
  /** True when this message was a command and must not be read as conversation. */
  readonly handled: boolean;
  /** Runtime-authored user messages prepended to the turn. */
  readonly context?: readonly string[];
  /** Replaces the workflow run title, so the session list does not fill with "/dashboard". */
  readonly title?: string;
}

const NOT_A_COMMAND: SlashCommandOutcome = { handled: false };

/**
 * Where the dashboard is, as a human would type it.
 *
 * `EVESTACK_DASHBOARD_URL` is the ingest endpoint — a full path — and its origin
 * is the only place a scaffolded project records which port the dashboard got.
 * The scaffolder picks a free port rather than assuming 4000, so reading it back
 * is not optional. `127.0.0.1` is rewritten because this string is going in front
 * of a person, and `localhost` is what they recognise.
 */
export function dashboardUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.EVESTACK_DASHBOARD_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin.replace("127.0.0.1", "localhost");
    } catch {
      // A malformed value is not worth failing a command over.
    }
  }
  return "http://localhost:4000";
}

/**
 * Whether opening a browser here is a reasonable thing to do.
 *
 * Two independent reasons it might not be. `EVESTACK_NO_BROWSER` is the explicit
 * opt-out, for anyone who wants the command to answer without a window. And a
 * process with no TTY is a service — `npm run start` under systemd or launchd,
 * or the built server in a container — where there is no screen to put a window
 * on and no person sitting at it. `EVE_DEV` is eve's own marker for an
 * interactive dev process and is accepted as sufficient, because a TTY can be
 * absent from a dev process whose stdout is being piped.
 */
function canOpenBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.EVESTACK_NO_BROWSER) return false;
  return env.EVE_DEV === "1" || process.stdout.isTTY === true;
}

/**
 * Fire-and-forget browser launch.
 *
 * Detached and unref'd so the agent is never the parent of a browser that
 * outlives it, and every failure is swallowed: a stack trace about `xdg-open`
 * in the middle of a chat transcript would be worse than no window. The same
 * three-platform shape `evestack open` uses, kept identical on purpose.
 */
function launchBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Deliberately silent; the context line still names the URL.
  }
}

/** Is the dashboard actually up? A short probe, because the answer changes what we say. */
async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/health", url), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Flatten what the channel hands us to the text a person typed.
 *
 * `onMessage` receives `string | UserContent`, and the array form is a list of
 * parts. A slash command is only ever the whole of a plain text message, so
 * anything with an attachment or more than one text part is conversation.
 */
function plainText(message: unknown): string | null {
  if (typeof message === "string") return message.trim();
  if (!Array.isArray(message)) return null;
  const parts = message.filter((part): part is Record<string, unknown> =>
    typeof part === "object" && part !== null,
  );
  if (parts.length !== 1) return null;
  const only = parts[0]!;
  return only.type === "text" && typeof only.text === "string" ? only.text.trim() : null;
}

/**
 * Handle `/dashboard`, or say this was not one.
 *
 * Returns synchronously-shaped data but is async for one reason: the health
 * probe. Everything that is not a command returns before any work happens, so
 * an ordinary message pays a `Set.has` and nothing else.
 */
export async function handleSlashCommand(
  message: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SlashCommandOutcome> {
  const text = plainText(message);
  if (!text || !COMMANDS.has(text.toLowerCase())) return NOT_A_COMMAND;

  const url = dashboardUrl(env);
  const healthy = await isHealthy(url);

  let opened = false;
  if (healthy && canOpenBrowser(env)) {
    const now = Date.now();
    if (now - lastOpenedAt > REOPEN_COOLDOWN_MS) {
      lastOpenedAt = now;
      launchBrowser(url);
      opened = true;
    }
  }

  // The instruction is explicit about the exact words, because the point of a
  // command is that its output is the same every time. The model is being used
  // as a printer here, not as a judge.
  const line = healthy
    ? opened
      ? `Opening the evestack dashboard at ${url} — it should be in your browser now.`
      : `The evestack dashboard is running at ${url}.`
    : `The evestack dashboard is not running. Start it with: docker compose --profile dashboard up -d — then it is at ${url}.`;

  return {
    handled: true,
    context: [
      `[runtime] The user ran the /dashboard command. This was handled by the runtime, ` +
        `not by you, and no tool call is needed. Reply with exactly this line and nothing ` +
        `else, no preamble and no follow-up question:\n${line}`,
    ],
    title: "/dashboard",
  };
}
