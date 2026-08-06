/**
 * Argument parsing and process wiring, kept out of bin/ so it can be tested
 * without spawning anything.
 *
 * Exit codes follow the repro scripts in contract/runtime/repro, because an
 * operator who has run those already knows what they mean:
 *
 *   0  looked, found nothing that is costing a run right now
 *   1  at least one fault — a stranded run, a wedged job, a wedged session
 *   2  could not look (no database, wrong schema, bad arguments)
 */
import { DoctorError } from "./db.mjs";
import { diagnose } from "./doctor.mjs";
import { renderText, renderJson, renderVerbose } from "./render.mjs";

export const USAGE = `evestack doctor — explain why a durable job is dead

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
        throw new DoctorError(`Unknown option --${name}\n\n${USAGE}`);
      }
      if (rest.length === 0) {
        // Refused rather than guessed: `--limit 50` would otherwise silently
        // become `--limit` plus a stray positional and run with the default.
        throw new DoctorError(`--${name} needs a value, as --${name}=VALUE\n\n${USAGE}`);
      }
      options[name] = rest.join("=");
    } else if (options.command === null) options.command = arg;
    else throw new DoctorError(`Unexpected argument "${arg}"\n\n${USAGE}`);
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
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }

  if (options.help || (options.command === null && !options.version)) {
    stdout.write(USAGE);
    return options.help ? 0 : 2;
  }
  if (options.version) {
    const { readFileSync } = await import("node:fs");
    const url = new URL("../package.json", import.meta.url);
    stdout.write(`${JSON.parse(readFileSync(url, "utf8")).version}\n`);
    return 0;
  }
  if (options.command !== "doctor") {
    stderr.write(`Unknown command "${options.command}". Only \`doctor\` exists so far.\n\n${USAGE}`);
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
