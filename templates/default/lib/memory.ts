import { openai } from "@ai-sdk/openai";
import { embed } from "ai";
import { Pool } from "pg";

/**
 * Long-term memory on the Postgres that is already running.
 *
 * This costs nothing extra. The database is here anyway for durable sessions,
 * and the compose file uses the pgvector image, so semantic recall is one
 * extension away — no vector service, no second container, no bill. Hosted
 * memory products charge for this or gate it behind a paid tier.
 *
 * Sessions and memory are different things: a session remembers one
 * conversation, memory persists across all of them.
 */

const DIMENSIONS = Number(process.env.EVESTACK_EMBED_DIMENSIONS ?? 1536);
const EMBED_MODEL = process.env.EVESTACK_EMBED_MODEL ?? "text-embedding-3-small";

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

function getPool(): Pool {
  const url = process.env.WORKFLOW_POSTGRES_URL;
  if (!url) {
    throw new Error(
      "Memory needs WORKFLOW_POSTGRES_URL. Start Postgres with `docker compose up postgres`.",
    );
  }
  pool ??= new Pool({ connectionString: url, max: 4 });
  return pool;
}

/**
 * Schema lives in `evestack`, never in `workflow` — that one belongs to eve's
 * runtime and a migration of ours must never collide with theirs.
 *
 * The vector column is fixed-width, so changing embedding model or dimension
 * means dropping this table. That is why the dimension is explicit rather than
 * inferred: a silent mismatch would fail at insert time with a confusing error.
 */
async function ensureSchema(): Promise<void> {
  ready ??= (async () => {
    const db = getPool();
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    await db.query("CREATE SCHEMA IF NOT EXISTS evestack");
    await db.query(`
      CREATE TABLE IF NOT EXISTS evestack.memories (
        id          bigserial PRIMARY KEY,
        content     text NOT NULL,
        tags        text[] NOT NULL DEFAULT '{}',
        session_id  text,
        embedding   vector(${DIMENSIONS}) NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // HNSW, not IVFFlat — and this is not a style preference, it is a
    // correctness bug we hit.
    //
    // IVFFlat assigns vectors to `lists` centroids at build time and probes
    // only `ivfflat.probes` of them per query (default 1). Build it on an empty
    // table, as any bootstrap-time migration must, and the centroids are
    // meaningless: the planner switches to the index once a query looks
    // selective enough, probes one near-empty list, and returns ZERO rows for a
    // query that plainly should match. Observed exactly that — the same query
    // returned 2 rows at LIMIT 3 and 0 rows at LIMIT 20, purely because the
    // plan flipped.
    //
    // HNSW builds a navigable graph incrementally, needs no training data, and
    // is correct from the first row. That matters more than IVFFlat's faster
    // build, because memory starts empty by definition.
    await db.query(`
      CREATE INDEX IF NOT EXISTS memories_embedding_idx
      ON evestack.memories USING hnsw (embedding vector_cosine_ops)
    `);
    await db.query(
      "CREATE INDEX IF NOT EXISTS memories_tags_idx ON evestack.memories USING gin (tags)",
    );
  })();
  return ready;
}

async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.textEmbeddingModel(EMBED_MODEL),
    value: text,
  });
  return embedding;
}

export async function remember(
  content: string,
  options: { tags?: string[]; sessionId?: string } = {},
): Promise<{ id: number }> {
  await ensureSchema();
  const embedding = await embedText(content);
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO evestack.memories (content, tags, session_id, embedding)
     VALUES ($1, $2, $3, $4::vector) RETURNING id`,
    [content, options.tags ?? [], options.sessionId ?? null, JSON.stringify(embedding)],
  );
  return { id: Number(rows[0].id) };
}

interface MemoryRow {
  id: string;
  content: string;
  tags: string[] | null;
  created_at: string | Date;
  similarity: string | number;
}

export interface Recalled {
  id: number;
  content: string;
  tags: string[];
  similarity: number;
  createdAt: string;
}

export async function recall(
  queryText: string,
  options: { limit?: number; tags?: string[]; minSimilarity?: number } = {},
): Promise<Recalled[]> {
  await ensureSchema();
  const embedding = await embedText(queryText);
  const limit = Math.min(options.limit ?? 5, 50);
  const tags = options.tags ?? [];

  // HNSW returns at most `hnsw.ef_search` rows, and that default is 40 — below
  // the 50 this function's own cap advertises. Once the table is big enough for
  // the planner to choose the index (measured: 5,000 rows), asking for 50
  // silently returns 40, and asking for 45 silently returns 40. No error, no
  // warning, just a short answer that looks complete.
  //
  // That is the same shape as the IVFFlat bug documented above — ask for more,
  // get less — so the fix is to make the search width follow the request rather
  // than to quietly lower the cap. pgvector's guidance is ef_search >= limit;
  // doubling it costs a little recall work and buys the ordering back at the
  // boundary.
  //
  // SET LOCAL, so it applies to this query and reverts with the transaction
  // instead of leaking onto whatever else this pooled connection serves next.
  const client = await getPool().connect();
  let rows: MemoryRow[];
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL hnsw.ef_search = ${Math.max(40, limit * 2)}`);
    ({ rows } = await client.query<MemoryRow>(
      // `<=>` is cosine DISTANCE (0 = identical), so similarity is 1 - distance.
      `SELECT id, content, tags, created_at,
              1 - (embedding <=> $1::vector) AS similarity
       FROM evestack.memories
       WHERE ($2::text[] = '{}' OR tags && $2::text[])
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [JSON.stringify(embedding), tags, limit],
    ));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const floor = options.minSimilarity ?? 0;
  return rows
    .map((r): Recalled => ({
      id: Number(r.id),
      content: r.content,
      tags: r.tags ?? [],
      similarity: Number(r.similarity),
      createdAt: new Date(r.created_at).toISOString(),
    }))
    .filter((r) => r.similarity >= floor);
}

export async function forget(id: number): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query("DELETE FROM evestack.memories WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
