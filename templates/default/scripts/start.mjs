#!/usr/bin/env node
/**
 * `npm run start` — run the BUILT agent on the port this project recorded.
 *
 * This existed as `"start": "eve start"` and that was wrong in a way nothing
 * caught, because nothing had ever run it.
 *
 * `eve start` takes its port from `--port`, then `$PORT`, then 3000. The
 * scaffolder writes EVESTACK_AGENT_PORT into .env.local and everything else in
 * the project treats that as the answer to "where is the agent":
 * `npm run verify` probes it, and the generated docker-compose.yml points the
 * dashboard's EVESTACK_AGENT_URL at it. `npm run dev` passed it through as
 * `--port`. `start` passed nothing, so in production the agent listened
 * somewhere none of them were looking.
 *
 * Measured on a real build before this file existed: `npm run start` bound 3000,
 * which on that machine was an unrelated Next app, so the built agent served
 * nothing and reported that nowhere. `verify` meanwhile said "nothing is
 * answering at http://127.0.0.1:2041, the port this project records" — a true
 * sentence about the wrong port, which is the most expensive kind.
 *
 * 3000 is a bad number to land on by accident: it is the default for Next, CRA
 * and Vite, so on a developer machine it is usually taken, and in a container it
 * is usually not the port that was published.
 *
 * Deliberately thinner than scripts/dev.mjs. That one preflights Postgres, the
 * schema and the model, because a person is standing there and a clear message
 * beats a stack trace. This runs under an orchestrator: exiting fast and letting
 * the restart policy handle it is the right behaviour, and a preflight that
 * refuses to boot while the database finishes starting would be a liveness bug.
 */
import { spawn } from "node:child_process";

import { C, eveArgsWithPort } from "./checks.mjs";

const passthrough = process.argv.slice(2);
const args = eveArgsWithPort("start", passthrough, process.env.EVESTACK_AGENT_PORT);

// `eve` from the local install rather than a global one, so the version the
// project pinned is the version that runs.
const child = spawn("eve", args, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error(
      `\n${C.red}${C.bold}  eve is not installed in this project.${C.reset}\n\n` +
        `  Run ${C.bold}npm install${C.reset}, then ${C.bold}npm run build${C.reset} before ${C.bold}npm run start${C.reset}.\n`,
    );
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

// Exit with the child's own code so an orchestrator sees what eve saw. Signals
// are re-reported as 128+n, which is what a shell would have done.
child.on("exit", (code, signal) => {
  process.exit(signal ? 128 + (signal === "SIGTERM" ? 15 : 2) : (code ?? 0));
});
