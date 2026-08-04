import { Pool } from "pg";

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
