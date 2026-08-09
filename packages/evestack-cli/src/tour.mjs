/**
 * `evestack tour` — the first two minutes, guided.
 *
 * The scaffolder could finish successfully and leave someone with no idea what
 * they had. Four parts come up, and the thing that makes evestack worth running
 * over plain eve — a dashboard that reads your own Postgres and drives the
 * agent — was reachable only by knowing to open a URL and click around. Nothing
 * demonstrated it.
 *
 * So this sends one real message and follows it through all three surfaces: the
 * terminal it was typed in, the database it landed in, and the dashboard that
 * can see it. Four steps, one model call.
 *
 * WHAT IT COSTS, said before it runs: step 2 is a real turn against whatever
 * provider is configured. On gpt-5-mini it is a fraction of a cent; on a local
 * Ollama it is free and slow. Nothing else here calls a model.
 *
 * The API surface used is the one the agent actually exposes, read out of eve's
 * compiled channel rather than guessed at:
 *   POST /eve/v1/session               -> 202 { ok, sessionId, continuationToken }
 *   GET  /eve/v1/session/:id/stream    -> NDJSON of { type, data }
 * with `message.appended` carrying `data.messageDelta` and `turn.completed` /
 * `turn.failed` ending it.
 */
import { spawn } from "node:child_process";

import { blank, c, forHumans, g, heading, fix, rule, row, say } from "create-evestack/ui";

import { findProjectEnv, notAProject, projectEnv, wantsHelp } from "./project.mjs";
import { probeAll } from "./status.mjs";

/** A first turn on a cold agent has to compile the workflow and reach a
 *  provider. Ollama on a laptop is the slow end of this, not the fast one. */
const TURN_TIMEOUT_MS = 120_000;

const DEFAULT_MESSAGE = "In one short sentence: what are you running on?";

export const TOUR_USAGE = `evestack tour — a guided first run, on a stack that is already up

  evestack tour [--yes] [--message=TEXT] [--no-open]

Four steps, about two minutes. It checks that all four parts are answering,
sends ONE real message to your agent, streams the reply here, then shows you
the same turn in the dashboard.

That one message is a real model call — a fraction of a cent on gpt-5-mini,
free and slower on Ollama. Nothing else in the tour calls a model.

Options
  --yes, -y         do not ask before sending the message
  --message=TEXT    send something other than the default question
  --no-open         never launch a browser
  -h, --help        this

Exit codes
  0  the tour finished
  1  the stack is not up, or the turn failed — it printed which
  2  not an evestack project
`;

/* -------------------------------------------------------------------------- */

const STEPS = [
  ["the stack", "confirm all four parts are answering"],
  ["a turn", "send one message, and watch the reply come back"],
  ["where it went", "the same turn, in the dashboard"],
  ["what is next", "memory, approvals, schedules, and doctor"],
];

export async function tour(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (wantsHelp(argv)) {
    stdout.write(TOUR_USAGE);
    return 0;
  }

  const found = findProjectEnv();
  if (!found) return notAProject(stderr);
  const env = projectEnv(found);

  const yes = argv.includes("--yes") || argv.includes("-y") || !process.stdin.isTTY;
  const noOpen = argv.includes("--no-open") || !process.stdout.isTTY;
  const custom = argv.find((a) => a.startsWith("--message="))?.slice("--message=".length);
  const message = custom || DEFAULT_MESSAGE;

  blank();
  heading("tour", "a guided first run");
  blank();
  STEPS.forEach(([title, detail], i) => {
    say(`    ${c.dim(`${i + 1}`)}  ${c.bold(title.padEnd(15))}${c.dim(detail)}`);
  });
  blank();

  /* -- 1. is it up ---------------------------------------------------------- */

  rule("1 · the stack");
  blank();
  const probes = await probeAll(env);
  const needed = [probes.agent, probes.postgres, probes.model];
  for (const p of [...needed, probes.dashboard]) {
    const glyph = p.state === "ok" ? g.OK : p.state === "warn" ? g.WARN : g.FAIL;
    row(glyph, p.part, p.state === "fail" ? c.red(p.detail) : c.dim(p.detail), "", { indent: 4 });
    if (p.fix) fix(p.fix, { indent: 6 });
  }
  blank();

  // The dashboard is step 3, not a prerequisite: a turn is a turn whether or not
  // anything is watching, and refusing to demonstrate the agent because the
  // container is down would be the tour failing at the thing it teaches.
  const blocked = needed.filter((p) => p.state === "fail");
  if (blocked.length > 0) {
    say(`  ${c.redBold("The tour needs the agent, Postgres and a model key.")}`);
    say(`  ${c.dim("Run the lines above, then `evestack tour` again.")}`);
    blank();
    return 1;
  }
  if (probes.dashboard.state === "fail") {
    say(`  ${c.yellow("The dashboard is down, so step 3 will only print the link.")}`);
    blank();
  }

  /* -- 2. a turn ------------------------------------------------------------ */

  rule("2 · a turn");
  blank();
  say(`  ${c.dim("Sending to your agent — one real model call:")}`);
  say(`      ${c.bold(message)}`);
  blank();

  if (!yes && !(await confirm("Send it?"))) {
    say(`  ${c.dim("Nothing sent.")}`);
    blank();
    return 0;
  }

  const agentBase = agentOrigin(env);
  const started = Date.now();
  let session;
  try {
    session = await startSession(agentBase, message, env);
  } catch (error) {
    say(`  ${c.redBold("The agent refused the message.")}  ${c.dim(error.message)}`);
    blank();
    fix("evestack verify", { indent: 4, note: "checks the model key and the schema" });
    blank();
    return 1;
  }

  say(`  ${c.dim("session")}  ${c.bold(session.sessionId)}`);
  blank();

  const reply = await streamReply(agentBase, session.sessionId, env, stdout);
  blank();

  if (reply.failed) {
    say(`  ${c.redBold("The turn failed.")} ${c.dim(reply.failed)}`);
    blank();
    say(`  ${c.dim("This is exactly what the dashboard and `evestack doctor` are for:")}`);
    fix("evestack doctor", { indent: 4, note: "read-only — it never writes to your database" });
    blank();
    return 1;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  say(`  ${c.dim(`${g.ok} that was a durable turn — ${seconds}s, and it is a row in your Postgres`)}`);
  say(`  ${c.dim("   now, not a log line that scrolls away.")}`);
  blank();

  /* -- 3. where it went ------------------------------------------------------ */

  rule("3 · where it went");
  blank();
  const dashboard = forHumans(probes.dashboard.url ?? "http://localhost:4000");
  const link = `${dashboard}/sessions/${encodeURIComponent(session.sessionId)}`;
  say(`  ${c.dim("The same turn, from the other side:")}`);
  say(`      ${c.brandBold(link)}`);
  blank();
  say(`  ${c.dim("Nothing shipped that turn anywhere. The dashboard is reading the")}`);
  say(`  ${c.dim("Postgres on your machine — the tokens, the cost, the trace spans and")}`);
  say(`  ${c.dim("the tool calls are all rows you can SELECT yourself.")}`);
  blank();
  if (!noOpen && probes.dashboard.state === "ok" && (yes || (await confirm("Open it?")))) {
    openBrowser(link);
    say(`  ${c.dim(`opened ${link}`)}`);
    blank();
  }

  /* -- 4. next --------------------------------------------------------------- */

  rule("4 · what is next");
  blank();
  const password = env("EVESTACK_AUTH_PASSWORD");
  const tips = [
    ["memory", `ask it to remember something, then ask again in a new session`],
    ["approvals", `a gated tool parks the run and waits for you in the dashboard`],
    ["schedules", `durable cron, with a history of every fire and a pause switch`],
    ["cost", `priced per turn from token counts — never a silent $0.00`],
  ];
  for (const [what, why] of tips) row(c.dim(g.skip), what, c.dim(why), "", { indent: 4, labelWidth: 12 });
  blank();
  say(`  ${c.bold("Dashboard")}  ${c.brand(dashboard)}`);
  if (password) say(`  ${c.bold("Sign in")}    ${env("EVESTACK_AUTH_USER") ?? "evestack"} ${c.dim("/")} ${password}`);
  blank();
  say(`  ${c.dim("`evestack status` any time · `evestack doctor` if a run stops moving")}`);
  blank();
  return 0;
}

/* -------------------------------------------------------------------------- */
/* talking to the agent                                                        */
/* -------------------------------------------------------------------------- */

function agentOrigin(env) {
  const explicit = env("EVESTACK_AGENT_URL");
  const port = env("EVESTACK_AGENT_PORT") || "2000";
  try {
    return new URL(explicit || `http://127.0.0.1:${port}`).origin;
  } catch {
    return `http://127.0.0.1:${port}`;
  }
}

/**
 * Basic credentials, always sent when the project has them.
 *
 * `eve dev` grants through `localDev()` and would not need these, but a built
 * server refuses loopback too — from eve 0.30 `localDev()` grants only inside
 * `eve dev` — so the same tour run against `npm run start` is a 401 without
 * them. Sending them when they are not needed costs nothing.
 */
function authHeaders(env) {
  const user = env("EVESTACK_AUTH_USER");
  const password = env("EVESTACK_AUTH_PASSWORD");
  if (!user || !password) return {};
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` };
}

/** Exported for test/tour.test.mjs, which drives it against a stub agent — the
 *  real one needs Postgres, Docker and a model key, and a parser this deep in a
 *  paid code path should not be tested only by running it. */
export async function startSession(base, message, env) {
  const response = await fetch(new URL("/eve/v1/session", base), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(env) },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.sessionId) {
    throw new Error(
      response.status === 401
        ? "401 — the agent rejected these credentials. Check EVESTACK_AUTH_* in .env.local."
        : `HTTP ${response.status}${body?.error ? ` — ${body.error}` : ""}`,
    );
  }
  return body;
}

/**
 * Follow the NDJSON event stream and print the assistant's text as it arrives.
 *
 * Tolerant on purpose. The event vocabulary is eve's, it moves upstream, and a
 * tour that throws on an event shape it has not seen would be worse than one
 * that prints a little less: anything unrecognised is ignored, and the reply is
 * in the dashboard either way. Only `turn.failed` / `session.failed` are treated
 * as an outcome, because those are the ones the reader must not miss.
 */
export async function streamReply(base, sessionId, env, stdout) {
  const out = { text: "", failed: null };
  let response;
  try {
    response = await fetch(new URL(`/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, base), {
      headers: authHeaders(env),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
  } catch {
    say(`  ${c.dim("(could not attach to the stream — the reply is in the dashboard)")}`);
    return out;
  }
  if (!response.ok || !response.body) {
    say(`  ${c.dim("(no stream for this session — the reply is in the dashboard)")}`);
    return out;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let printedPrefix = false;

  const write = (text) => {
    if (!printedPrefix) {
      stdout.write(`  ${c.dim("agent")}  `);
      printedPrefix = true;
    }
    // Keep the reply inside the same left margin as everything else.
    stdout.write(text.replace(/\n/g, "\n         "));
  };

  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "message.appended" && typeof event.data?.messageDelta === "string") {
          out.text += event.data.messageDelta;
          write(event.data.messageDelta);
        } else if (event.type === "turn.failed" || event.type === "session.failed") {
          out.failed = event.data?.error?.message ?? event.data?.reason ?? "no reason given";
          return out;
        } else if (event.type === "turn.completed" || event.type === "session.completed") {
          if (printedPrefix) stdout.write("\n");
          return out;
        }
      }
    }
  } catch (error) {
    if (printedPrefix) stdout.write("\n");
    if (error?.name === "TimeoutError") {
      say(`  ${c.yellow("The turn is still running after two minutes.")}`);
      say(`  ${c.dim("A local model on a laptop can take this long. It is durable — it will")}`);
      say(`  ${c.dim("finish, and the dashboard will have it.")}`);
    }
    return out;
  }
  if (printedPrefix) stdout.write("\n");
  return out;
}

/* -------------------------------------------------------------------------- */

async function confirm(question) {
  if (!process.stdin.isTTY) return true;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Raced against close for the same reason shared.mjs races it: after stdin
  // hits EOF, question() never settles and the process exits having done
  // nothing, which reads as success.
  const answer = await Promise.race([
    rl.question(`  ${g.ASK} ${question} ${c.dim("(Y/n)")} `),
    new Promise((resolve) => rl.once("close", () => resolve(null))),
  ]);
  rl.close();
  blank();
  return answer === null || !answer.trim().toLowerCase().startsWith("n");
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is already on screen.
  }
}
