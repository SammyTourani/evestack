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

// Next dev reloads modules on every edit; without the global we would leak a
// pool per reload until Postgres refuses new connections.
export const pool: Pool =
  globalThis.__evestackPool ??
  (globalThis.__evestackPool = new Pool({
    connectionString: connectionString(),
    types: utcTimestamps,
    max: Number(process.env.EVESTACK_DB_POOL_MAX ?? 8),
    idleTimeoutMillis: 30_000,
  }));

export async function query<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool.query(text, params as unknown[]);
  return result.rows as T[];
}
