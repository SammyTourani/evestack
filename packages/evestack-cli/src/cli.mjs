/**
 * Argument parsing and process wiring, kept out of bin/ so it can be tested
 * without spawning anything.
 *
 * `evestack` is the one command, and COMMANDS below is the list it answers to.
 * There used to be two CLIs — a published `create-evestack` that scaffolds, and
 * this one, which only knew `doctor` and was never published. Two names is fine; two
 * implementations is not, so `create` and `attach` are routed straight into
 * `create-evestack`'s own modules (src/scaffold.mjs explains the direction of
 * the dependency). `npx create-evestack` still works and always will — it is
 * the convention, it is in every doc, and it is in people's shell history.
 *
 * Exit codes follow the repro scripts in contract/runtime/repro, because an
 * operator who has run those already knows what they mean:
 *
 *   0  looked, found nothing that is costing a run right now
 *   1  at least one fault — a stranded run, a wedged job, a wedged session
 *   2  could not look (no database, wrong schema, bad arguments)
 *
 * `create` and `attach` follow the same shape: 0 is a project you can run, 1 is
 * one you cannot.
 */
import { DoctorError } from "./db.mjs";
import { diagnose } from "./doctor.mjs";
import { renderText, renderJson, renderVerbose } from "./render.mjs";

/**
 * Handed to `create-evestack` verbatim, argument for argument.
 *
 * These commands are routed BEFORE parseArgs runs, because parseArgs is
 * doctor's parser and refuses unknown flags — `evestack create x --yes` would
 * die on "Unknown option --yes" before the scaffolder ever saw it. Routing
 * first is also what keeps the two front doors identical: whatever
 * `npx create-evestack --whatever` accepts, `evestack create --whatever`
 * accepts, without this file having to know what that is.
 */
const SCAFFOLD_COMMANDS = new Set(["create", "attach"]);

/**
 * Routed before parseArgs for the same reason the scaffolder is: these own
 * their own flags. `evestack verify --json` must reach the checker, not die on
 * doctor's parser calling --json unknown for a command it does not handle.
 */
const PROJECT_COMMANDS = new Set(["status", "verify", "open", "tour"]);

/**
 * Which scaffolder command this argv is, or null for everything else.
 *
 * Exported so the routing decision can be asserted without running a wizard
 * that writes files and shells out to a package manager.
 */
export function scaffoldCommand(argv) {
  return SCAFFOLD_COMMANDS.has(argv[0]) ? argv[0] : null;
}

/** Which project-scoped command this argv is, or null. Exported to be asserted
 *  without shelling out to a checker that talks to Docker and Postgres. */
export function projectCommand(argv) {
  return PROJECT_COMMANDS.has(argv[0]) ? argv[0] : null;
}

/**
 * The command list, and nothing else.
 *
 * This used to be thirty-eight lines: five commands, then a six-line quickstart
 * that repeated what `create` prints when it finishes, then a paragraph about
 * `doctor` being read-only. All of it true, none of it what someone typing
 * `evestack --help` is looking for — they want the verb. The quickstart is now
 * printed by the thing that owns it (`create`, at the moment it finishes), and
 * every command's own `--help` carries its own detail.
 *
 * Ordered by when you need them, not alphabetically.
 */
export const USAGE = `evestack — the whole eve stack, on your own machine

  evestack create [name]     scaffold an agent, a database and a dashboard
  evestack status            is it up? what do I run?
  evestack tour              a guided first run, on a stack that is already up
  evestack open              the dashboard URL and its password, in a browser
  evestack verify            check every part and name the fix for anything broken
  evestack attach [dir]      add evestack to an eve project you already have
  evestack doctor            a run stopped moving — read-only forensics

  -h, --help                 this, or COMMAND --help for one command's options
  -V, --version              print the version

  Asking for help never writes, starts or opens anything.
  \`npx create-evestack [name]\` is \`evestack create\` under npm's create-*
  convention — same code, same flags, either one.
`;

export const DOCTOR_USAGE = `evestack doctor — explain why a durable job is dead

  evestack doctor [options]

Read-only. It never writes to your database; when there is something to fix it
prints the SQL and lets you decide. Safe to point at production.

Options
  --schema=NAME       graphile-worker's schema            (default: graphile_worker)
  --workflow=NAME     eve's workflow schema               (default: workflow)
  --url=URL           Postgres connection string          (default: $WORKFLOW_POSTGRES_URL,
                                                           then $DATABASE_URL)
  --agent-url=URL     the eve agent, for session health   (default: $EVESTACK_AGENT_URL,
                                                           then http://127.0.0.1:2000)
  --limit=N           max rows listed per section         (default: 50; counts are never capped)
  --probes=N          max sessions probed, 0 to skip      (default: 25)
  --idle=MINUTES      how long a session must be quiet    (default: 30)
                      before it is worth probing
  --timeout=MS        statement_timeout and HTTP timeout  (default: 15000)
  --sql               print only the remediation SQL, nothing else
  --json              print the whole diagnosis as JSON
  --verbose           add the raw rows behind each finding
  -h, --help          this
  -V, --version       print the version

Exit codes
  0  nothing is costing you a run
  1  at least one fault
  2  could not look (no database, wrong schema, bad arguments)
`;

const FLAGS_WITH_VALUES = new Set([
  "schema",
  "workflow",
  "url",
  "agent-url",
  "limit",
  "probes",
  "idle",
  "timeout",
]);

export function parseArgs(argv) {
  const options = { command: null };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-V" || arg === "--version") options.version = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--sql") options.sql = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg.startsWith("--")) {
      const [name, ...rest] = arg.slice(2).split("=");
      if (!FLAGS_WITH_VALUES.has(name)) {
        throw new DoctorError(`Unknown option --${name}\n\n${DOCTOR_USAGE}`);
      }
      if (rest.length === 0) {
        // Refused rather than guessed: `--limit 50` would otherwise silently
        // become `--limit` plus a stray positional and run with the default.
        throw new DoctorError(`--${name} needs a value, as --${name}=VALUE\n\n${DOCTOR_USAGE}`);
      }
      options[name] = rest.join("=");
    } else if (options.command === null) options.command = arg;
    else throw new DoctorError(`Unexpected argument "${arg}"\n\n${DOCTOR_USAGE}`);
  }
  return options;
}

function numeric(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new DoctorError(`--${name}=${value} is not a number`);
  return n;
}

/**
 * The Node this CLI is tested on, and the floor its manifest already declares.
 *
 * A local copy of what create-evestack's shared.mjs does, deliberately not an
 * import: `evestack doctor` is the command someone runs when a production queue
 * is wedged, and it must not pull the scaffolder and its template into the
 * process to find out how old Node is. Both floors move together or the engines
 * field is a lie in one package.
 */
const MIN_NODE_MAJOR = 24;

export function nodeVersionProblem(version = process.versions.node) {
  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return (
    `evestack needs Node ${MIN_NODE_MAJOR} or newer — this is Node ${version}.\n` +
    `  package.json declares "engines": { "node": ">=${MIN_NODE_MAJOR}" }, and npm only warns\n` +
    "  about that. Install Node 24 from https://nodejs.org, or `nvm install 24`.\n"
  );
}

/**
 * Did the caller ask for a version, ignoring anything after `--`?
 *
 * Help is NOT handled here: every command owns its own help text and prints it
 * itself, which is what keeps `evestack create --help` and `npx create-evestack
 * --help` from drifting apart. Version is central because there is one version to
 * print — this package's.
 */
function wantsVersion(argv) {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "-V" || arg === "--version") return true;
  }
  return false;
}

async function printVersion(stdout) {
  const { readFileSync } = await import("node:fs");
  const url = new URL("../package.json", import.meta.url);
  stdout.write(`${JSON.parse(readFileSync(url, "utf8")).version}\n`);
  return 0;
}

/** Every verb this binary answers to, for the router and for did-you-mean. */
export const COMMANDS = ["create", "status", "tour", "open", "verify", "attach", "doctor"];

/**
 * Edit distance, capped at 2.
 *
 * Two is the whole point: it catches a transposition and a slip
 * (`verfiy`, `statsu`, `docter`) and refuses to guess at `deploy`. A suggestion
 * that fires on anything vaguely similar teaches people to ignore suggestions.
 */
function near(input, candidate) {
  const a = input.toLowerCase();
  const b = candidate;
  if (Math.abs(a.length - b.length) > 2) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length][b.length] <= 2;
}

export function unknownCommand(input) {
  const suggestion = COMMANDS.find((name) => near(input, name));
  const head = `Unknown command ${JSON.stringify(input)}.`;
  return suggestion
    ? `${head} Did you mean \`evestack ${suggestion}\`?\n\n${USAGE}`
    : `${head}\n\n${USAGE}`;
}

/**
 * The project-scoped commands, each in its own module so that `doctor` — the
 * one someone runs against a wedged production queue — never loads a checker
 * that talks to Docker, nor a tour that wants to spend tokens.
 */
async function runProjectCommand(name, argv, { stdout, stderr }) {
  const MODULES = {
    status: () => import("./status.mjs"),
    tour: () => import("./tour.mjs"),
    verify: () => import("./project.mjs"),
    open: () => import("./project.mjs"),
  };
  try {
    const module = await MODULES[name]();
    return await module[name](argv, { stdout, stderr });
  } catch (error) {
    stderr.write(`${error?.message ?? error}\n`);
    return 1;
  }
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  // Before everything, including the router: a runtime this CLI does not support
  // should be one sentence, not a failure inside pg or a scaffolded project.
  const tooOld = nodeVersionProblem();
  if (tooOld) {
    stderr.write(tooOld);
    return 1;
  }

  // Before parseArgs, and before anything is imported: `create` and `attach`
  // own every argument after their own name. See SCAFFOLD_COMMANDS.
  const project = projectCommand(argv);
  const scaffold = scaffoldCommand(argv);
  // `evestack create --version` and `evestack verify -V` reached neither parser:
  // create/attach/verify/open are routed before parseArgs, and none of the four
  // knew the flag — so `create --version` scaffolded a project called `my-agent`
  // and ran an install. One version, printed here, for every command.
  if ((project || scaffold) && wantsVersion(argv.slice(1))) {
    return printVersion(stdout);
  }
  if (project) return runProjectCommand(project, argv.slice(1), { stdout, stderr });

  if (scaffold) {
    const scaffolder = await import("./scaffold.mjs");
    try {
      return await scaffolder[scaffold](argv.slice(1));
    } catch (error) {
      // The scaffolder writes its own output to the real stdout — it is an
      // interactive wizard, not a renderer — so only the failure comes back
      // through here.
      stderr.write(`${error?.message ?? error}\n`);
      return 1;
    }
  }

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }

  if (options.help) {
    // `evestack doctor --help` gets doctor's flags; a bare `--help` gets the
    // command list. Printing the 30-line doctor block to someone who typed
    // `evestack --help` buries the commands they are more likely to want.
    stdout.write(options.command === "doctor" ? DOCTOR_USAGE : USAGE);
    return 0;
  }
  if (options.version) {
    return printVersion(stdout);
  }

  // A bare `evestack` printed the whole usage block and exited 2 — an error code
  // for typing the program's name. Inside a project the question it is standing
  // in for has an answer, so answer it; outside one, the command list IS the
  // answer, and it is not a failure.
  if (options.command === null) {
    const { findProject } = await import("./project.mjs");
    if (findProject()) return runProjectCommand("status", [], { stdout, stderr });
    stdout.write(USAGE);
    return 0;
  }

  if (options.command !== "doctor") {
    stderr.write(unknownCommand(options.command));
    return 2;
  }

  try {
    const report = await diagnose({
      schema: options.schema,
      workflow: options.workflow,
      connectionString: options.url,
      agentUrl: options["agent-url"],
      limit: numeric(options.limit, "limit"),
      probes: numeric(options.probes, "probes"),
      idleMs: options.idle === undefined ? undefined : numeric(options.idle, "idle") * 60_000,
      timeoutMs: numeric(options.timeout, "timeout"),
    });

    if (options.sql) {
      // Pipe-friendly: SQL on stdout and nothing else, so `--sql | psql` is a
      // decision the operator makes rather than one this tool makes for them.
      if (report.remediation) stdout.write(report.remediation);
      else stderr.write("Nothing to remediate: no job is both dead and blocking a live run.\n");
      return report.exitCode;
    }
    if (options.json) {
      stdout.write(renderJson(report));
      return report.exitCode;
    }
    stdout.write(renderText(report));
    if (options.verbose) stdout.write(renderVerbose(report));
    return report.exitCode;
  } catch (error) {
    if (error instanceof DoctorError) {
      stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    stderr.write(`evestack doctor failed: ${error?.stack ?? error}\n`);
    return 2;
  }
}
