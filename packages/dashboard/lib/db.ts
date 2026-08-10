import { Pool, types as pgTypes, type CustomTypesConfig } from "pg";

/**
 * Connection to the same Postgres that stores durable workflow state.
 *
 * The dashboard is read-mostly and reads eve's own tables directly. That is
 * deliberate: eve tags every run with framework-owned `$eve.*` attributes, and
 * world-postgres persists them to `workflow.workflow_runs.attributes` as JSONB.
 * Those tags are what power Vercel's Agent Runs, so querying them gives us the
 * same source of truth with plain SQL — no ingest pipeline, no trace spool, and
 * nothing to keep in sync.
 */
declare global {
  // eslint-disable-next-line no-var
  var __evestackPool: Pool | undefined;
}

/*
 * ─ There used to be a `setDefaultAutoSelectFamily(false)` here ───────────────
 *
 * It turned off Node's happy-eyeballs race so that a hostname resolving to both
 * ::1 and 127.0.0.1 produced one connection attempt instead of two. The reason
 * was a Node bug: when every attempt was refused, node:net built its summary
 * `AggregateError` from a list it had already cleared and threw
 * `TypeError: object null is not iterable` out of a socket callback, past every
 * `try/catch`, as `uncaughtException` plus a 100-second hang.
 *
 * It is gone because it cost more than it bought, and because what it bought is
 * no longer for sale:
 *
 *   - THE COST. It is a PROCESS-WIDE setting, and with the race off Node tries
 *     only the FIRST address a name resolves to. On macOS `localhost` is ::1
 *     first, and Docker Desktop and Colima publish on IPv4 only — so the
 *     scaffolder's own `…@localhost:5433` reached nothing. `evestack doctor`,
 *     which imports the sibling copy of this line, answered "Cannot reach
 *     Postgres … docker compose up -d postgres" against a healthy, running,
 *     already-connected database. A diagnostic tool that misdiagnoses the
 *     default setup is worse than no diagnostic tool.
 *
 *   - THE BENEFIT IS GONE. Measured on 24.11.1, 24.15.0 and 26.0.0 — the whole
 *     range `engines.node: >=24` allows — a refused `…@localhost:5999` now
 *     rejects with a well-formed `AggregateError` (`errors.length === 2`) in
 *     7 ms, caught by the ordinary `await`. No uncaught exception, no hang.
 *
 * The two defences that remain are the ones that should have been carrying this
 * all along and are not version-dependent: `connectionTimeoutMillis` below
 * bounds the hang, and `describeDbError` below flattens an `AggregateError`
 * whose `errors` is null rather than iterating it blind.
 *
 * If this ever needs to come back, scope it to one connection — never to the
 * process — and never in a module a CLI also imports.
 */

const NAIVE_TIMESTAMP = pgTypes.builtins.TIMESTAMP;

// Postgres ISO DateStyle, e.g. "2026-08-04 12:01:25.559334". Anything else it
// can emit here — `infinity`, `-infinity`, a ` BC` suffix — falls through to
// pg's own parser rather than being silently mangled.
const ISO_DATESTYLE = /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/**
 * eve's `workflow` tables record UTC in `timestamp without time zone` columns,
 * which carry no offset for pg to read. pg therefore parses them in the Node
 * process's local zone, so on any machine not set to UTC every run came back
 * shifted by that offset — far enough that the dashboard rendered runs as
 * having started in the future. Our own `evestack` tables use timestamptz and
 * were never affected, so this override is scoped to the one OID that is wrong.
 */
function parseUtcTimestamp(value: string): Date | number {
  const parts = ISO_DATESTYLE.exec(value);
  if (!parts) return pgTypes.getTypeParser(NAIVE_TIMESTAMP, "text")(value);
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

// Scoped to this pool on purpose: pg's `setTypeParser` mutates a process-wide
// registry that every other pg consumer in the process would inherit.
const utcTimestamps: CustomTypesConfig = {
  getTypeParser: (id, format) =>
    id === NAIVE_TIMESTAMP && (format ?? "text") === "text"
      ? parseUtcTimestamp
      : pgTypes.getTypeParser(id, format),
};

function connectionString(): string {
  const url = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "WORKFLOW_POSTGRES_URL is not set. The dashboard reads the same Postgres " +
        "that stores eve's durable sessions — point it at that database.",
    );
  }
  return url;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_POOL_MAX = 8;

/**
 * A number read from the environment, or the documented default and a warning.
 *
 * `Number(process.env.X ?? fallback)` reads as equivalent to this and is not: it
 * hands pg whatever `Number()` made of the string, and both ways that can go
 * wrong produce a FALSY value. `Number("5s")` is NaN, and `Number("")` — what a
 * docker-compose `environment:` entry passes for a variable that is listed but
 * unset on the host — is 0.
 *
 * A blank value is treated as unset rather than as a typo, because that is what
 * compose passing through an absent host variable means. Anything else
 * non-numeric is an operator mistake and says so, the way lib/pricing.ts already
 * reports an unparseable EVESTACK_PRICING rather than silently pricing nothing.
 */
function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(
    `[evestack] ${name}=${JSON.stringify(raw)} is not a positive number; using ${fallback}.`,
  );
  return fallback;
}

/**
 * The pool's connect timeout.
 *
 * Exported because the property that matters cannot be read off the call site:
 * pg-pool arms the timer with `if (!this.options.connectionTimeoutMillis)`, so a
 * NaN or a 0 does not shorten the bound, it REMOVES it — and restores in full
 * the multi-minute hang the comment in getPool() says the setting exists to
 * prevent, on /api/health along with every page. test/db-env.test.mjs pins that.
 */
export function connectTimeoutMs(): number {
  return positiveNumberEnv("EVESTACK_DB_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS);
}

/**
 * Built on first query, not at module load.
 *
 * At module scope, a missing WORKFLOW_POSTGRES_URL threw during module
 * evaluation — before any route or page `try/catch` existed to catch it — so
 * the carefully worded error above never reached anyone and every route
 * answered a bare 500 instead. Deferring construction is what lets the
 * "Can't reach the database" page and `/api/health`'s 503 do their jobs.
 *
 * Next dev reloads modules on every edit; without the global we would leak a
 * pool per reload until Postgres refuses new connections.
 */
export function getPool(): Pool {
  const existing = globalThis.__evestackPool;
  if (existing) return existing;
  const created = new Pool({
    connectionString: connectionString(),
    types: utcTimestamps,
    max: positiveNumberEnv("EVESTACK_DB_POOL_MAX", DEFAULT_POOL_MAX),
    idleTimeoutMillis: 30_000,
    // Postgres being down is the common case, not the exotic one. Without a
    // bound, pg keeps retrying every address the hostname resolves to and a
    // page render hangs for minutes before anything is rendered at all.
    connectionTimeoutMillis: connectTimeoutMs(),
  });
  // A pool with no listener turns an idle client's socket error into an
  // unhandled 'error' event, which takes the whole server process down.
  created.on("error", (error) => {
    console.warn(`[evestack] idle Postgres client error: ${describeDbError(error)}`);
  });
  globalThis.__evestackPool = created;
  return created;
}

/**
 * End the pool AND forget it, which `getPool().end()` on its own does not.
 *
 * pg's `end()` leaves the object alive and permanently unusable — every later
 * query rejects with "Cannot use a pool after calling end on the pool" — while
 * the global above still points at it, so the next `getPool()` hands back the
 * corpse instead of building a replacement.
 *
 * Nothing in the running dashboard closes the pool, which is why this went
 * unnoticed. It surfaced in the probe runner, where every probe shares one
 * process: `08-metric-query` finishes with `db.getPool().end()`, and the next
 * probe to import a lib module that queries — `16-schedule-streaks` — threw
 * before its first assertion. Ordering decided it, so it was invisible to
 * `--only=schedules` and appeared the first time the whole tier ran together.
 *
 * Callers that own the process lifetime should use this instead of `end()`.
 */
export async function closePool(): Promise<void> {
  const existing = globalThis.__evestackPool;
  globalThis.__evestackPool = undefined;
  if (existing) await existing.end();
}

/**
 * Flattens whatever pg threw into a single readable sentence.
 *
 * A refused connection surfaces as an `AggregateError` whose `errors` property
 * is null rather than an array — one per resolved address. Rendering that
 * through Next's error path threw `TypeError: object null is not iterable`
 * from inside the framework, which escaped the page's own catch entirely and
 * came out as `uncaughtException` plus a 100-second hang. Normalizing here
 * keeps every caller dealing with an ordinary Error.
 */
export function describeDbError(error: unknown): string {
  if (error instanceof AggregateError) {
    const parts: unknown[] = Array.isArray(error.errors) ? error.errors : [];
    const detail = parts.map(describeDbError).filter(Boolean).join("; ");
    return detail || error.message || "connection failed";
  }
  if (error instanceof Error) {
    // Node attaches these to socket errors but does not declare them on Error;
    // pg re-throws the raw system error, so this is where the useful detail is.
    const { code, address, port } = error as Error & {
      code?: string;
      address?: string;
      port?: number;
    };
    const where = address ? ` (${address}${port ? `:${port}` : ""})` : "";
    return code && !error.message.includes(code)
      ? `${code}: ${error.message}${where}`
      : `${error.message}${where}`;
  }
  return String(error);
}

/**
 * Deliberately carries no `cause`.
 *
 * pg reports a refused connection as an `AggregateError`, and Next serializes
 * an error's `cause` chain across the server/client boundary in dev. Rebuilding
 * an AggregateError on the other side throws `TypeError: object null is not
 * iterable` from inside the framework — outside any page's try/catch — which
 * surfaced as `⨯ uncaughtException` and a 93-second `GET /`. The original
 * message is already flattened into `message`; the object itself must not
 * travel. `describeDbError` keeps the detail without keeping the shape.
 */
export class DatabaseUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DatabaseUnavailableError";
  }
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  try {
    const result = await getPool().query(text, params as unknown[]);
    return result.rows as T[];
  } catch (error) {
    throw new DatabaseUnavailableError(describeDbError(error));
  }
}

/** PostgreSQL `undefined_table`. */
const UNDEFINED_TABLE = "42P01";

/**
 * This repository's own SQLSTATE, raised by the guard at the top of
 * `sql/traces.sql` and `sql/facts.sql` when the database is at a HIGHER schema
 * version than the file being applied.
 *
 * Not one of Postgres's: five characters outside classes 00/01/02 are reserved
 * for exactly this, and a user-defined code is what lets the message be
 * recognised here without matching on its prose.
 */
export const SCHEMA_TOO_NEW = "EV001";

/**
 * Whether a failure is "the schema was never created" rather than "the database
 * is not there".
 *
 * These are opposite problems with opposite fixes and they looked identical.
 * A container brought up without `npm run db:bootstrap` reported **healthy**,
 * answered `/api/health` with 200, and rendered "Can't reach the database —
 * Start it with `docker compose up postgres`" on every page. Postgres was
 * running the whole time; the user had already done the thing being suggested,
 * and the one command that would have fixed it was named nowhere on the screen.
 *
 * Matched on the SQLSTATE and the schema name rather than the message text, so
 * a Postgres locale change cannot silently turn this back into the wrong advice.
 */
export function isMissingSchema(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(UNDEFINED_TABLE) && message.includes("workflow.");
}

/**
 * The same question for a table this repo owns, rather than eve's.
 *
 * `isMissingSchema` is deliberately narrowed to `workflow.` because its answer
 * is the `db:bootstrap` advice, which is wrong for anything else. The
 * `evestack.*` tables have their own creators — `sql/facts.sql`, `sql/alerts.sql`
 * — and "this feature has never run" is a legitimate, non-error state for them.
 *
 * Same SQLSTATE match and the same reason for it: a locale change must not turn
 * a missing table into an unreadable database or the other way round.
 */
export function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(UNDEFINED_TABLE);
}

/**
 * Whether the database is NEWER than this build understands.
 *
 * The third opposite problem, and the one that does not look like a problem.
 * An older dashboard image pointed at a database a newer one has already
 * migrated used to apply its own `CREATE OR REPLACE FUNCTION`s over the newer
 * definitions, leave the version marker claiming the newer version, and then
 * render pages that were empty or quietly wrong — measured live as a database
 * reading `spans v4` while running the v3 resolver, with fresh spans resolving
 * to `turn_0`. The guard in the SQL now refuses to apply anything at all, and
 * this is what turns that refusal into a sentence instead of a blank page.
 *
 * Matched on the SQLSTATE rather than the message, for the same reason
 * `isMissingSchema` is: the prose can be reworded, and a Postgres locale must
 * not be able to turn this back into "can't reach the database".
 */
export function isSchemaTooNew(error: unknown): boolean {
  // The driver's own field, when the pg error survived intact.
  if (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === SCHEMA_TOO_NEW
  ) {
    return true;
  }
  // And the flattened form, because `query()` rewraps every failure as a
  // DatabaseUnavailableError carrying only `describeDbError`'s sentence. That
  // sentence starts with the SQLSTATE, so the test is anchored rather than a
  // bare substring search — an id or a model name containing these five
  // characters must not be read as a version mismatch.
  const message = error instanceof Error ? error.message : String(error);
  return new RegExp(`(^|[;\\s])${SCHEMA_TOO_NEW}: `).test(message);
}

export interface DbFailure {
  readonly title: string;
  readonly detail: string;
  /** What to actually do, as prose. Never contradicts what the user just did. */
  readonly guidance: string;
}

/** One classification, so five pages cannot drift into five diagnoses. */
export function describeDbFailure(error: unknown): DbFailure {
  const detail = describeDbError(error);
  // First, because it is the one failure whose fix is neither of the other two:
  // Postgres is up, the schema is there, and it is this dashboard that is out
  // of date. Telling someone to bootstrap or to start a container here would
  // send them to change the healthy half.
  if (isSchemaTooNew(error)) {
    return {
      title: "This dashboard is older than its database",
      detail,
      guidance:
        "A newer evestack already migrated this database, so nothing was changed and no page here can be trusted to read it. Run the newer dashboard image — or, if you meant to go back, drop the `evestack` schema and let this one rebuild it. The `workflow` tables holding your sessions are not affected either way.",
    };
  }
  if (isMissingSchema(error)) {
    return {
      title: "The database has no agent schema yet",
      detail,
      guidance:
        "Postgres is running — this is the one step nothing creates for you. Run `npm run db:bootstrap` in your agent project, then reload.",
    };
  }
  return {
    title: "Can't reach the database",
    detail,
    guidance:
      "The dashboard reads the same Postgres that stores your agent's sessions. Start it with `docker compose up -d postgres`.",
  };
}
