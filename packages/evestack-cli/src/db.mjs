/**
 * The one Postgres connection `evestack doctor` opens, pinned read-only.
 *
 * This tool exists to be pointed at production during an incident, so the
 * read-only promise is enforced by the server rather than by our own care:
 * `default_transaction_read_only = on` makes an UPDATE that slipped into a
 * query string fail with 25006 instead of corrupting a queue. The schema under
 * inspection is `@workflow/world-postgres`, which moved beta.31 -> beta.38 in
 * two days; a tool that writes to a schema moving that fast is a state
 * corrupter, so it does not write at all and prints SQL for a human instead.
 *
 * `statement_timeout` is the other half. The queue aggregates below scan
 * `_private_jobs` without an index to help them, and an unbounded seq scan on
 * someone's real queue is a denial of service we would have caused.
 */
import { setDefaultAutoSelectFamily } from "node:net";

/**
 * Connect to one address at a time instead of racing every address a hostname
 * resolves to.
 *
 * Ported from packages/dashboard/lib/db.ts, where it was measured: `localhost`
 * resolves to both ::1 and 127.0.0.1, and when every attempt is refused Node's
 * happy-eyeballs path can build its summary `AggregateError` from a list it has
 * already cleared, throwing `TypeError: object null is not iterable` out of
 * node:net on a socket callback where no `await` can catch it. The dashboard
 * measured 100 seconds and four uncaught exceptions for the single most likely
 * misconfiguration there is — Postgres not started — which is also the most
 * likely state of the world when someone reaches for a doctor command.
 */
setDefaultAutoSelectFamily(false);

/** pg's OID for `timestamp without time zone`. Hardcoded rather than imported
 *  so this module does not need pg loaded to be unit-testable. */
const NAIVE_TIMESTAMP_OID = 1114;

// Postgres ISO DateStyle, e.g. "2026-08-04 12:01:25.559334". Anything else it
// can emit here — `infinity`, `-infinity`, a ` BC` suffix — falls through to
// pg's own parser rather than being silently mangled.
const ISO_DATESTYLE = /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/**
 * eve's `workflow` tables record UTC in `timestamp without time zone` columns,
 * which carry no offset for pg to read, so pg parses them in the host's local
 * zone. The dashboard hit this and rendered runs as having started in the
 * future. Here it would be worse than cosmetic: every idle duration this tool
 * reports, and therefore the hour threshold that separates "a turn is running"
 * from "wedged", would be out by the host's offset. graphile's own columns are
 * timestamptz and unaffected, which is why the override is scoped to one OID.
 */
export function parseUtcTimestamp(value, fallback) {
  const parts = ISO_DATESTYLE.exec(value);
  if (!parts) return fallback(value);
  const [, year, month, day, hour, minute, second, fraction] = parts;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      // Postgres keeps microseconds; JS Date only holds milliseconds.
      fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0,
    ),
  );
}

/**
 * Schema names arrive from `--schema=` / `--workflow=` and are interpolated
 * into SQL, because a schema name cannot be a bind parameter. Anything that is
 * not a bare identifier is refused rather than quoted-and-hoped.
 */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function safeIdentifier(name, flag) {
  if (typeof name !== "string" || !BARE_IDENTIFIER.test(name) || name.length > 63) {
    throw new DoctorError(
      `${flag}=${String(name)} is not a plain Postgres identifier. ` +
        `Schema names are interpolated into SQL and cannot be bound, so only ` +
        `[A-Za-z_][A-Za-z0-9_$]* is accepted.`,
    );
  }
  return name;
}

/** Anything that should end the process with a message rather than a stack. */
export class DoctorError extends Error {
  constructor(message, { exitCode = 2, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DoctorError";
    this.exitCode = exitCode;
  }
}

/** Never print the password back at the user, in a terminal or in --json. */
export function redact(connectionString) {
  return String(connectionString).replace(/:\/\/([^:@/]*):[^@/]*@/, "://$1:***@");
}

/**
 * Open the session. Returns the client plus what we could actually enforce on
 * it — `readOnly: false` is reported rather than hidden, because a pooler in
 * transaction mode silently drops session-level SET and the operator deserves
 * to know the guarantee downgraded from "the server will refuse writes" to
 * "this tool only sends SELECTs".
 */
export async function connect({ connectionString, timeoutMs = 15_000 }) {
  let pg;
  try {
    ({ default: pg } = await import("pg"));
  } catch (cause) {
    throw new DoctorError(
      "evestack doctor needs the `pg` package and could not load it. " +
        "Install this CLI with its dependencies (`npm i -g @evestack/cli`), " +
        "or run it from a project that already has pg.",
      { cause },
    );
  }

  const client = new pg.Client({
    connectionString,
    application_name: "evestack-doctor",
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    // Scoped to this client on purpose: pg's `setTypeParser` mutates a
    // process-wide registry that every other pg consumer would inherit.
    types: {
      getTypeParser: (id, format) =>
        id === NAIVE_TIMESTAMP_OID && (format ?? "text") === "text"
          ? (value) => parseUtcTimestamp(value, pg.types.getTypeParser(id, format))
          : pg.types.getTypeParser(id, format),
    },
  });

  try {
    await client.connect();
  } catch (cause) {
    throw new DoctorError(
      `Cannot reach Postgres at ${redact(connectionString)}\n  ${cause.message}\n\n` +
        `Set WORKFLOW_POSTGRES_URL, or start one:  docker compose up -d postgres`,
      { cause },
    );
  }

  let readOnly = false;
  try {
    await client.query(`set statement_timeout = ${Number(timeoutMs)}`);
    await client.query(`set idle_in_transaction_session_timeout = ${Number(timeoutMs)}`);
    await client.query("set default_transaction_read_only = on");
    // Trust the server's answer, not the fact that the SET returned.
    const { rows } = await client.query("show default_transaction_read_only");
    readOnly = rows[0]?.default_transaction_read_only === "on";
  } catch {
    readOnly = false;
  }

  return { client, readOnly, timeoutMs };
}

/** Server/connection facts worth printing in the header of a report. */
export async function describeServer(client) {
  const { rows } = await client.query(
    `select current_database() as database,
            current_user      as "user",
            inet_server_addr()::text as address,
            inet_server_port() as port,
            current_setting('server_version') as version`,
  );
  return rows[0] ?? {};
}
