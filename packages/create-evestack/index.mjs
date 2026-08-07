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
import {
  C, dim, hasFlag, HELP_FLAGS, nodeVersionProblem, packageVersion, say, VERSION_FLAGS,
} from "./shared.mjs";

const argv = process.argv.slice(2);

/**
 * Both wizards run inside this, and the reason is a difference nobody would
 * predict from the code.
 *
 * `attach` refuses six ordinary situations by throwing — no such directory, no
 * package.json, no `eve` dependency, no `agent/`, and so on — each with a
 * multi-line message naming the next command to run. Through `evestack attach`
 * those arrive as prose, because src/cli.mjs wraps the call. Through
 * `npx create-evestack attach` they arrived as an uncaught exception:
 *
 *     file:///…/create-evestack/attach.mjs:214
 *         throw new Error(
 *               ^
 *     Error: /path/package.json lists no "eve" dependency.
 *       …the good message, buried…
 *         at detectEveProject (file:///…/attach.mjs:214:11)
 *         at attach (file:///…/attach.mjs:94:19)
 *     Node.js v26.0.0
 *
 * Same code, same message, and the front door that needs no global install —
 * the one a first-timer uses — was the one showing a stack trace for pointing at
 * the wrong directory. Every other entry point in this repo goes out of its way
 * not to do that: scripts/bootstrap.mjs, scripts/verify.mjs and `evestack
 * doctor` all have long notes about it.
 *
 * The exit code was already 1. Only the presentation was wrong, which is exactly
 * the kind of thing that survives a code review and does not survive being run.
 */
async function main() {
  // Before the router, and before either wizard is even imported.
  //
  // `--help` was checked AFTER `attach` was routed, so `npx create-evestack
  // attach --help` ran real detection on a real project, printed a plan, and
  // asked "Write these changes? (Y/n)" — defaulting to yes. One Enter and
  // --help had written files. Nothing about asking for help should be able to
  // do that, so it is answered here, where nothing has been looked at yet.
  //
  // The Node check is in the same place for the same reason: a runtime this
  // package does not support should be a sentence, not a failure five commands
  // into a project that now exists.
  const tooOld = nodeVersionProblem();
  if (tooOld) {
    process.stderr.write(`\n${C.red}${tooOld}${C.reset}\n\n`);
    return 1;
  }
  const help = hasFlag(argv, HELP_FLAGS);
  if (hasFlag(argv, VERSION_FLAGS)) {
    say(packageVersion());
    return 0;
  }
  if (argv[0] === "attach") {
    const { attach, ATTACH_USAGE } = await import("./attach.mjs");
    if (help) {
      say(ATTACH_USAGE);
      return 0;
    }
    return (await attach(argv.slice(1))) ?? 0;
  }
  if (help) {
    usage();
    return 0;
  }
  const { create } = await import("./create.mjs");
  return await create(argv);
}

try {
  process.exitCode = await main();
} catch (error) {
  // The wizards print their own progress to stdout as they go, so only the
  // failure comes through here. Message only, on stderr, and the same shape the
  // `evestack` CLI has always produced for the identical error.
  process.stderr.write(`\n${C.red}${error?.message ?? error}${C.reset}\n\n`);
  process.exitCode = 1;
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
  dim("Anything else starting with a dash is refused, not guessed at: `--port 5000` used to");
  dim("create a directory called `5000`. End the options with `--` to name one on purpose.");
  say();
  say(`  ${C.dim}-h, --help${C.reset}     this, or ${C.bold}attach --help${C.reset} for that command's options`);
  say(`  ${C.dim}-V, --version${C.reset}  print create-evestack's version`);
  say();
  // Named here rather than left to be discovered. Both commands exist on the
  // `evestack` bin too, alongside `doctor`, and someone who reaches for --help
  // is exactly the person who wants to know that.
  dim("The same two commands, plus `doctor`, live on one binary: `npx evestack --help`.");
  say();
}
