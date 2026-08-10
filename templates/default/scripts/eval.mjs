#!/usr/bin/env node
/**
 * `npm run eval` — run the evals in this project, against the agent in it.
 *
 * `npx eve eval` is what the eve docs tell you to type, and on a scaffolded
 * project it does not work in the state the quickstart leaves you in. Two
 * reasons, both measured on a clean scaffold:
 *
 * 1. IT REFUSES TO RUN WHILE THE AGENT IS RUNNING. `eve eval` boots its own dev
 *    server, and eve rejects a second dev server for an app root that already
 *    has one:
 *
 *      A dev server is already running for this eve agent.
 *      To connect to the existing instance, run: npm exec -- eve dev http://127.0.0.1:2001/
 *
 *    exit 1, nothing run. The last step of every getting-started path here is
 *    `npm run dev`, so a running agent is the ORDINARY state of a working
 *    project, and the advice printed is about attaching a dev UI rather than
 *    about running evals. The fix is one flag, `--url`, and this project has
 *    already written down the answer: EVESTACK_AGENT_PORT.
 *
 * 2. IT HAS NO PREFLIGHT. `npm run dev` checks Postgres, the schema and the
 *    model before it starts anything, because those three produce the worst
 *    error messages in the project. `eve eval` goes straight to eve, so the
 *    same project with Postgres down reports
 *
 *      [env-runner] worker init failed: connect ECONNREFUSED 127.0.0.1:5435
 *
 *    and one whose schema was never created reports a 300-character SELECT
 *    against workflow.workflow_runs — the two messages scripts/dev.mjs exists
 *    to prevent, from the one command that skipped it.
 *
 * Both are eve behaviours rather than evestack ones, and neither can be changed
 * from here: nothing in this repo can make `eve eval` boot a second dev server,
 * and nothing can add a preflight to it. What a wrapper CAN do is answer the
 * question eve is asking with the value this project already recorded, and run
 * the checks `npm run dev` already runs.
 *
 *   npm run eval                        the whole suite
 *   npm run eval -- smoke               one eval, or a directory prefix
 *   npm run eval -- --list              what would run: no agent, no model
 *   npm run eval -- --url http://host/  a target you name; nothing is added
 *   EVESTACK_SKIP_PREFLIGHT=1 npm run eval
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  C,
  agentBaseUrl,
  envValue,
  evalArgsWithTarget,
  eveBinary,
  preflight,
  probeJson,
  readEnvFile,
  stop,
} from "./checks.mjs";

const passthrough = process.argv.slice(2);

/**
 * The URL of an agent already serving this project, or null.
 *
 * /eve/v1/info rather than /eve/v1/health, because info is what the eval runner
 * itself demands of a --url target: it polls health, then reads info and
 * refuses anything that is not an eve agent. So a port that answers health and
 * 401s info — a BUILT server, where the HTTP Basic policy applies and the eval
 * client has no credential to send — is correctly read as no target, and eve
 * boots its own dev server rather than being pointed at a door it cannot open.
 *
 * The recorded port and only the recorded port, for the reason findAgent gives
 * at length: scanning adopts whichever project happens to hold 2000. Even the
 * recorded one is checked by NAME before it is used — a second project can be
 * squatting on it, and eve itself refuses a target whose /eve/v1/info reports
 * an agent it was not sent to look for. Observed on this machine, mid-test:
 *
 *   Expected eval target "my-agent" at http://127.0.0.1:2001/, but
 *   "plain-agent" is responding there.
 *
 * That is a safe failure, and it is still the wrong one: nothing was wrong with
 * the project, so the run should quietly use a private dev server instead.
 */
async function runningAgent(port) {
  const pinned = port?.trim();
  if (!pinned) return null;
  const url = `http://127.0.0.1:${pinned}/`;
  const base = agentBaseUrl(url);
  if (!base) return null;
  const info = await probeJson(new URL("/eve/v1/info", base), {}, 2000);
  if (!info.ok || info.body?.kind !== "eve-agent-info") return null;
  const serving = info.body.agent?.name;
  const mine = projectAgentName();
  if (mine && serving && !matchesAgentName(mine, serving)) {
    console.warn(
      `${C.yellow}  !${C.reset} ${url} is serving "${serving}", not "${mine}" — another project ` +
        "holds the port this one recorded. Using a private dev server instead.",
    );
    return null;
  }
  return url;
}

/** This agent is named after its package, which is what eve reports at /eve/v1/info. */
function projectAgentName() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name ?? null;
  } catch {
    return null;
  }
}

/** eve compares the scoped name and its unscoped tail; so does this. */
function matchesAgentName(expected, actual) {
  return actual === expected || actual === expected.replace(/^@[^/]+\//, "");
}

const fileEnv = readEnvFile();

// `--list` reads the eval files and prints them: no agent, no database, no
// model. Demanding Postgres and a pulled model before answering a question that
// needs neither would make the cheapest command in the suite the fussiest, and
// it is the one worth running in CI, where none of that exists.
const listingOnly = passthrough.includes("--list");

if (!listingOnly && !process.env.EVESTACK_SKIP_PREFLIGHT) {
  // requireEmbedModel here and not in `npm run dev`: the agent boots without an
  // embedding model, and evals/memory.eval.ts is five of the thirteen gates.
  await preflight({ label: "npm run eval", requireEmbedModel: true });
}

const target = listingOnly ? null : await runningAgent(envValue(fileEnv, "EVESTACK_AGENT_PORT"));
const args = evalArgsWithTarget(passthrough, target);

// Said out loud, because which agent an eval ran against is the first thing you
// want to know about a red result — and pointing at a running one is a decision
// this script made rather than something the reader typed.
if (target && args.at(-1) === target) {
  console.log(`${C.dim}  target ${target} — the agent already running for this project${C.reset}`);
}

const child = spawn(eveBinary(import.meta.url), args, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});
child.on("error", (error) => {
  if (error.code === "ENOENT") {
    stop("eve is not installed in this project.", [`Run ${C.bold}npm install${C.reset} first.`]);
  }
  throw error;
});
// Ctrl-C must reach eve, not just this wrapper, or a half-finished eval run
// leaves its dev server holding a port.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
