#!/usr/bin/env node
/**
 * `create-evestack` — the JS-ecosystem front door.
 *
 *   npx create-evestack my-agent      scaffold a new agent
 *   npx create-evestack attach [dir]  wrap an eve project you already have
 *
 * This file is a router and nothing else. The scaffolder lives in create.mjs and
 * `attach` in attach.mjs, because `evestack create` and `evestack attach` — the
 * single command the CLI is converging on — import those same two modules
 * rather than shelling out to this bin. One implementation, two published names,
 * one place a bug gets fixed. See create.mjs's header for why the code lives on
 * this side of the dependency edge rather than in `@evestack/cli`.
 *
 * `create-evestack` keeps its own bin instead of being retired into an alias:
 * `npx create-<thing>` is the convention every JS developer already has, it is
 * what every doc and the README have said since 0.1.0, and it is published. A
 * name that is already in someone's shell history is not a name you break.
 *
 * `attach` is a subcommand here rather than a second bin on PATH. A package
 * called create-evestack that installs a general-purpose `evestack` command is a
 * surprise, and it would collide with the real `evestack` CLI. The one cost: a
 * project you actually want to name "attach" has to be written
 * `npx create-evestack ./attach`.
 */
import { C, dim, say } from "./shared.mjs";

const argv = process.argv.slice(2);

if (argv[0] === "attach") {
  const { attach } = await import("./attach.mjs");
  process.exitCode = (await attach(argv.slice(1))) ?? 0;
} else if (argv.includes("--help") || argv.includes("-h")) {
  usage();
} else {
  const { create } = await import("./create.mjs");
  process.exitCode = await create(argv);
}

function usage() {
  say();
  say(`${C.cyan}${C.bold}  evestack${C.reset} ${C.dim}— eve on your own machine, $0 infrastructure${C.reset}`);
  say();
  say(`  ${C.bold}npx create-evestack${C.reset} [name] ${C.dim}[--yes]${C.reset}`);
  dim("Scaffold a new self-hosted eve agent: Postgres sessions, Docker sandbox, memory,");
  dim("and a dashboard on :4000 that `docker compose --profile dashboard up -d` pulls.");
  say();
  say(`  ${C.bold}npx create-evestack attach${C.reset} [dir] ${C.dim}[--yes] [--dry-run]${C.reset}`);
  dim("Wrap an eve project you already have with evestack's control plane. Additive,");
  dim("never overwrites your files, and prints an undo line for everything it writes.");
  say();
  dim("To scaffold a project actually named `attach`, write `npx create-evestack ./attach`.");
  say();
  // Named here rather than left to be discovered. Both commands exist on the
  // `evestack` bin too, alongside `doctor`, and someone who reaches for --help
  // is exactly the person who wants to know that.
  dim("The same two commands, plus `doctor`, live on one binary: `npx evestack --help`.");
  say();
}
