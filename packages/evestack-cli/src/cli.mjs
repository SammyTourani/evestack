/**
 * Argument parsing and process wiring, kept out of bin/ so it can be tested
 * without spawning anything.
 *
 * `evestack` is the one command: `create`, `attach`, `doctor`. There used to be
 * two CLIs — a published `create-evestack` that scaffolds, and this one, which
 * only knew `doctor` and was never published. Two names is fine; two
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
 * Which scaffolder command this argv is, or null for everything else.
 *
 * Exported so the routing decision can be asserted without running a wizard
 * that writes files and shells out to a package manager.
 */
export function scaffoldCommand(argv) {
  return SCAFFOLD_COMMANDS.has(argv[0]) ? argv[0] : null;
}

export const USAGE = `evestack — the whole eve stack, on your own machine

  evestack create [name]        scaffold an agent + dashboard into a new directory
  evestack attach [dir]         add evestack to an eve project you already have
  evestack doctor               explain why a durable job is dead

  \`npx create-evestack [name]\` is the same scaffolder under the name npm's
  create-* convention expects. Same code, same flags, either one.

Getting started

  npx evestack create my-agent
  cd my-agent
  docker compose up -d postgres
  npm run db:bootstrap
  npm run dev
  docker compose --profile dashboard up -d     # the dashboard on :4000

Options

  -h, --help                    this, or the options for a command
  -V, --version                 print the version

\`evestack doctor\` is read-only: it never writes to your database, and when
there is something to fix it prints the SQL and lets you decide. Run
\`evestack doctor --help\` for its options.
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

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  // Before parseArgs, and before anything is imported: `create` and `attach`
  // own every argument after their own name. See SCAFFOLD_COMMANDS.
  const routed = scaffoldCommand(argv);
  if (routed) {
    const scaffold = await import("./scaffold.mjs");
    try {
      return await scaffold[routed](argv.slice(1));
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

  if (options.help || (options.command === null && !options.version)) {
    // `evestack doctor --help` gets doctor's flags; a bare `--help` gets the
    // command list. Printing the 30-line doctor block to someone who typed
    // `evestack --help` buries the two commands they are more likely to want.
    stdout.write(options.command === "doctor" ? DOCTOR_USAGE : USAGE);
    return options.help ? 0 : 2;
  }
  if (options.version) {
    const { readFileSync } = await import("node:fs");
    const url = new URL("../package.json", import.meta.url);
    stdout.write(`${JSON.parse(readFileSync(url, "utf8")).version}\n`);
    return 0;
  }
  if (options.command !== "doctor") {
    stderr.write(
      `Unknown command "${options.command}". Try create, attach or doctor.\n\n${USAGE}`,
    );
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
