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

import { blank, c, fixLine, forHumans, forStream, g, headingLine, rowLine, ruleLine } from "create-evestack/ui";

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

It asks before sending. With no terminal to ask — CI, a pipe, a wrapper — it
refuses and exits 3 rather than assuming yes; pass --yes to accept the charge
up front.

Options
  --yes, -y         do not ask before sending the message
  --message=TEXT    send something other than the default question
  --no-open         never launch a browser
  -h, --help        this

Exit codes
  0  the tour finished
  1  the stack is not up, or the turn failed — it printed which
  2  not an evestack project
  3  it would have sent a paid message with nobody to ask — pass --yes
`;

/* -------------------------------------------------------------------------- */

const STEPS = [
  ["the stack", "confirm all four parts are answering"],
  ["a turn", "send one message, and watch the reply come back"],
  ["where it went", "the same turn, in the dashboard"],
  ["what is next", "memory, approvals, schedules, and doctor"],
];

export async function tour(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  /*
   * Every line this command prints goes through the `stdout` it was handed.
   *
   * THE BUG, and it was the worst instance of it in this package: `tour()` took
   * a stream and used it for exactly two things — the usage text above, and the
   * agent's streamed reply, which it forwards into `streamReply`. The other
   * sixty-odd writes — the heading, the four step rules, the probe rows, the fix
   * lines, every sentence of the narration — went through ui.mjs's `say()` /
   * `blank()` / `heading()` / `row()` / `rule()` / `fix()`, all of which write
   * to the real `process.stdout` (ui.mjs:256-257).
   *
   * So a caller that supplied a stream got the model's reply with none of the
   * frame around it, and the frame appeared on the terminal instead — the two
   * halves of one report split across two destinations, and not even in order,
   * since they are separate write sequences. test/tour.test.mjs had to grow a
   * whole `AsyncLocalStorage`-based `captureStdout` helper to read the half that
   * escaped, and that helper's own docblock records what the workaround cost:
   * an earlier version of it ate the test runner's result lines and this file
   * silently reported 9 of its 14 tests.
   *
   * ui.mjs:259-269 states the rule — "`xLine(...)` returns the string and
   * `x(...)` prints it" — and names this exact failure, which `status` had and
   * had fixed (status.mjs:442-446). This is now the same shape.
   *
   * `forStream` is what stops a message bound for a different stream inheriting
   * a colour decision made from `process.stdout` (ui.mjs:216-233). It changes
   * nothing for a human: on a terminal it returns its input untouched, and when
   * the real stdout is not a TTY ui.mjs's `color` is already false so there is
   * no escape to strip. `out()` with no argument is `blank()` — `forStream`
   * of "" is "", and the newline is added below either way.
   */
  const out = (text = "") => stdout.write(`${forStream(stdout, text)}\n`);

  if (wantsHelp(argv)) {
    stdout.write(TOUR_USAGE);
    return 0;
  }

  const found = findProjectEnv();
  if (!found) return notAProject(stderr);
  const env = projectEnv(found);

  /**
   * Not a terminal is NOT consent.
   *
   * This read `|| !process.stdin.isTTY`, so every non-interactive run — CI, a
   * wrapper script, `evestack tour < /dev/null` — was treated as if the operator
   * had typed `--yes`, and the confirmation at step 2 was skipped twice over
   * (`confirm()` also returned true off a TTY). The tour then sent a real,
   * billable model call that nobody had agreed to, and no help text or doc said
   * it would.
   *
   * The sibling default below is the same test pointing the other way and stays:
   * `--no-open` defaults on without a terminal because NOT launching a browser
   * is the harmless direction. Spending money is not.
   */
  const yes = argv.includes("--yes") || argv.includes("-y");
  const noOpen = argv.includes("--no-open") || !process.stdout.isTTY;

  if (!yes && !process.stdin.isTTY) {
    stderr.write(
      forStream(
        stderr,
        `\n  ${g.FAIL} ${c.bold("evestack tour sends a real model call, and there is nobody here to ask.")}\n` +
          `      Re-run it in a terminal, or pass --yes to accept the charge up front.\n\n`,
      ),
    );
    // 3, not 1: nothing is broken and nothing needs fixing. A CI step that gets
    // this back asked for a paid action without saying so, and the distinct code
    // is what lets a caller tell that apart from "the stack is down".
    return 3;
  }
  const custom = argv.find((a) => a.startsWith("--message="))?.slice("--message=".length);
  const message = custom || DEFAULT_MESSAGE;

  out();
  out(headingLine("tour", "a guided first run"));
  out();
  STEPS.forEach(([title, detail], i) => {
    out(`    ${c.dim(`${i + 1}`)}  ${c.bold(title.padEnd(15))}${c.dim(detail)}`);
  });
  out();

  /* -- 1. is it up ---------------------------------------------------------- */

  out(ruleLine("1 · the stack"));
  out();
  const probes = await probeAll(env);
  const needed = [probes.agent, probes.postgres, probes.model];
  for (const p of [...needed, probes.dashboard]) {
    const glyph = p.state === "ok" ? g.OK : p.state === "warn" ? g.WARN : g.FAIL;
    out(rowLine(glyph, p.part, p.state === "fail" ? c.red(p.detail) : c.dim(p.detail), "", { indent: 4 }));
    if (p.fix) out(fixLine(p.fix, { indent: 6 }));
  }
  out();

  // The dashboard is step 3, not a prerequisite: a turn is a turn whether or not
  // anything is watching, and refusing to demonstrate the agent because the
  // container is down would be the tour failing at the thing it teaches.
  const blocked = needed.filter((p) => p.state === "fail");
  if (blocked.length > 0) {
    out(`  ${c.redBold("The tour needs the agent, Postgres and a model key.")}`);
    out(`  ${c.dim("Run the lines above, then `evestack tour` again.")}`);
    out();
    return 1;
  }
  if (probes.dashboard.state === "fail") {
    out(`  ${c.yellow("The dashboard is down, so step 3 will only print the link.")}`);
    out();
  }

  /* -- 2. a turn ------------------------------------------------------------ */

  out(ruleLine("2 · a turn"));
  out();
  out(`  ${c.dim("Sending to your agent — one real model call:")}`);
  out(`      ${c.bold(message)}`);
  out();

  if (!yes && !(await confirm("Send it?"))) {
    out(`  ${c.dim("Nothing sent.")}`);
    out();
    return 0;
  }

  const agentBase = agentOrigin(env);
  const started = Date.now();
  let session;
  try {
    session = await startSession(agentBase, message, env);
  } catch (error) {
    out(`  ${c.redBold("The agent refused the message.")}  ${c.dim(error.message)}`);
    out();
    out(fixLine("evestack verify", { indent: 4, note: "checks the model key and the schema" }));
    out();
    return 1;
  }

  out(`  ${c.dim("session")}  ${c.bold(session.sessionId)}`);
  out();

  const reply = await streamReply(agentBase, session.sessionId, env, stdout);
  out();

  if (reply.failed) {
    out(`  ${c.redBold("The turn failed.")} ${c.dim(reply.failed)}`);
    out();
    out(`  ${c.dim("This is exactly what the dashboard and `evestack doctor` are for:")}`);
    out(fixLine("evestack doctor", { indent: 4, note: "read-only — it never writes to your database" }));
    out();
    return 1;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  out(`  ${c.dim(`${g.ok} that was a durable turn — ${seconds}s, and it is a row in your Postgres`)}`);
  out(`  ${c.dim("   now, not a log line that scrolls away.")}`);
  out();

  /* -- 3. where it went ------------------------------------------------------ */

  out(ruleLine("3 · where it went"));
  out();
  const dashboard = forHumans(probes.dashboard.url ?? "http://localhost:4000");
  const link = `${dashboard}/sessions/${encodeURIComponent(session.sessionId)}`;
  out(`  ${c.dim("The same turn, from the other side:")}`);
  out(`      ${c.brandBold(link)}`);
  out();
  out(`  ${c.dim("Nothing shipped that turn anywhere. The dashboard is reading the")}`);
  out(`  ${c.dim("Postgres on your machine — the tokens, the cost, the trace spans and")}`);
  out(`  ${c.dim("the tool calls are all rows you can SELECT yourself.")}`);
  out();
  if (!noOpen && probes.dashboard.state === "ok" && (yes || (await confirm("Open it?")))) {
    openBrowser(link);
    out(`  ${c.dim(`opened ${link}`)}`);
    out();
  }

  /* -- 4. next --------------------------------------------------------------- */

  out(ruleLine("4 · what is next"));
  out();
  const password = env("EVESTACK_AUTH_PASSWORD");
  const tips = [
    ["memory", `ask it to remember something, then ask again in a new session`],
    ["approvals", `a gated tool parks the run and waits for you in the dashboard`],
    ["schedules", `durable cron, with a history of every fire and a pause switch`],
    ["cost", `priced per turn from token counts — never a silent $0.00`],
  ];
  for (const [what, why] of tips) out(rowLine(c.dim(g.skip), what, c.dim(why), "", { indent: 4, labelWidth: 12 }));
  out();
  out(`  ${c.bold("Dashboard")}  ${c.brand(dashboard)}`);
  if (password) out(`  ${c.bold("Sign in")}    ${env("EVESTACK_AUTH_USER") ?? "evestack"} ${c.dim("/")} ${password}`);
  out();
  out(`  ${c.dim("`evestack status` any time · `evestack doctor` if a run stops moving")}`);
  out();
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

  /* The three degradation notices below used ui.mjs's `say()`, which writes to
     the real `process.stdout` — inside the one function in this file that has
     always taken a stream and used it. So the agent's reply went to the caller's
     stream and "(could not attach to the stream…)" went to the terminal: the
     text explaining why the reply is missing arrived somewhere other than the
     place the reply was supposed to be. `note` is the string-form equivalent,
     aimed at the stream this function was given. `write` below is deliberately
     left alone — it was already correct, and running the model's own deltas
     through `plain()` would strip escape-shaped bytes out of the reply text. */
  const note = (text) => stdout.write(`${forStream(stdout, text)}\n`);
  let response;
  try {
    response = await fetch(new URL(`/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, base), {
      headers: authHeaders(env),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
  } catch {
    note(`  ${c.dim("(could not attach to the stream — the reply is in the dashboard)")}`);
    return out;
  }
  if (!response.ok || !response.body) {
    note(`  ${c.dim("(no stream for this session — the reply is in the dashboard)")}`);
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
      note(`  ${c.yellow("The turn is still running after two minutes.")}`);
      note(`  ${c.dim("A local model on a laptop can take this long. It is durable — it will")}`);
      note(`  ${c.dim("finish, and the dashboard will have it.")}`);
    }
    return out;
  }
  if (printedPrefix) stdout.write("\n");
  return out;
}

/* -------------------------------------------------------------------------- */

async function confirm(question) {
  // No terminal, no answer, so take the side that does nothing. This returned
  // `true` — an unattended run answering yes on the operator's behalf, which is
  // the wrong default for a prompt and was one of the two ways step 2 sent a
  // paid turn nobody approved. `tour()` now refuses earlier, so the send path
  // no longer reaches this; "Open it?" still can, and declining is right there.
  if (!process.stdin.isTTY) return false;
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
  // The one place in this file that still prints to `process.stdout` on
  // purpose, and it is not the same defect as the one fixed above. readline is
  // wired to `process.stdout` two lines up because a prompt has to appear on
  // the terminal the answer is typed at — routing this trailing newline to a
  // caller's stream would tear one interactive exchange in half, which is the
  // very thing being fixed everywhere else. Guarded by `process.stdin.isTTY`,
  // so it is unreachable whenever there is no terminal to write to.
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
