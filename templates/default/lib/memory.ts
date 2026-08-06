import { openai } from "@ai-sdk/openai";
import { embed, type EmbeddingModel } from "ai";
import { createOllama } from "ai-sdk-ollama";
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

/* -------------------------------------------------------------------------- */
/* which model turns text into a vector                                        */
/* -------------------------------------------------------------------------- */

/**
 * Embeddings follow the chat provider unless told otherwise.
 *
 * This file used to call `openai.textEmbeddingModel(...)` unconditionally, and
 * that made the whole `$0` story false. Pick Ollama in the scaffolder — the
 * option whose own text reads *"Local models need no API key"* — and the first
 * `remember` call died on `AI_LoadAPIKeyError: OpenAI API key is missing`. It
 * failed in the worst possible way, too: the tool error went to the log, the
 * model saw it, and it told the user *"saved to long-term memory"* anyway.
 * A silent lie about what was persisted is worse than a crash.
 *
 * Anthropic has no embeddings endpoint at all, so an Anthropic project borrows
 * OpenAI's if a key is present and otherwise says so in one sentence naming the
 * variable that fixes it. Guessing a provider the user never configured is how
 * the original bug happened; this asks instead.
 */
const EMBED_PROVIDERS = ["openai", "ollama"] as const;
type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** Model and vector width that go together. Change one, change the other. */
const EMBED_DEFAULTS: Record<EmbedProvider, { model: string; dimensions: number }> = {
  // 1536 is text-embedding-3-small's native width.
  openai: { model: "text-embedding-3-small", dimensions: 1536 },
  // nomic-embed-text is 274 MB and 768-wide — the small, ordinary choice for a
  // local stack. It is a SEPARATE pull from the chat model: `ollama pull
  // nomic-embed-text`. `npm run verify` checks for it by name.
  ollama: { model: "nomic-embed-text", dimensions: 768 },
};

function readEmbedProvider(): EmbedProvider {
  const explicit = process.env.EVESTACK_EMBED_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if ((EMBED_PROVIDERS as readonly string[]).includes(explicit)) return explicit as EmbedProvider;
    throw new Error(
      `EVESTACK_EMBED_PROVIDER="${process.env.EVESTACK_EMBED_PROVIDER}" is not an embedding provider ` +
        `this agent knows. Use one of: ${EMBED_PROVIDERS.join(", ")}.`,
    );
  }

  const chat = process.env.EVESTACK_PROVIDER?.trim().toLowerCase() || "openai";
  if (chat === "ollama") return "ollama";
  if (chat === "openai") return "openai";

  // anthropic, or anything else that reached here.
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  throw new Error(
    `EVESTACK_PROVIDER=${chat} has no embeddings endpoint, so long-term memory needs one from ` +
      "somewhere else. Either set OPENAI_API_KEY, or run embeddings locally with " +
      "EVESTACK_EMBED_PROVIDER=ollama (then `ollama pull nomic-embed-text`).",
  );
}

/**
 * Resolved on FIRST USE, not at module load, and that is load-bearing.
 *
 * `remember.ts`, `recall.ts` and `forget.ts` all import this module, and eve
 * loads every tool at boot — so a `throw` at module scope is not "the memory
 * tools are unavailable", it is "the agent does not start". An Anthropic
 * project with no OPENAI_API_KEY is a perfectly ordinary configuration that
 * simply cannot do embeddings, and the first version of this file bricked its
 * whole agent over it. A misconfiguration that disables one optional tool has
 * to surface as that tool failing, where the message reaches the operator and
 * everything else keeps working.
 *
 * Memoized because the answer cannot change within a process, and because
 * `ensureSchema` and `embedText` must agree on the vector width.
 */
let embedConfig: { provider: EmbedProvider; model: string; dimensions: number } | null = null;

function embedSettings(): { provider: EmbedProvider; model: string; dimensions: number } {
  if (embedConfig) return embedConfig;
  const provider = readEmbedProvider();
  const model = process.env.EVESTACK_EMBED_MODEL?.trim() || EMBED_DEFAULTS[provider].model;
  embedConfig = { provider, model, dimensions: readDimensions(provider) };
  return embedConfig;
}

/**
 * Trimmed and checked rather than `??`: `EVESTACK_EMBED_DIMENSIONS=` is an
 * empty string, which `??` keeps and `Number("")` turns into 0 — a
 * `vector(0)` column that fails at CREATE TABLE with a message about nothing
 * the reader configured.
 */
function readDimensions(provider: EmbedProvider): number {
  const raw = process.env.EVESTACK_EMBED_DIMENSIONS?.trim();
  if (!raw) return EMBED_DEFAULTS[provider].dimensions;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 16000) {
    throw new Error(
      `EVESTACK_EMBED_DIMENSIONS="${raw}" is not a vector width. It must be a whole number ` +
        "between 1 and 16000, and it must match what EVESTACK_EMBED_MODEL actually returns.",
    );
  }
  return value;
}

function embeddingModel(): EmbeddingModel {
  const { provider, model } = embedSettings();
  if (provider === "ollama") {
    // Same base-URL rule as the chat model: host only, no `/api` suffix, or
    // every call returns `OllamaError: 404 page not found`.
    return createOllama({
      baseURL: process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
    }).textEmbeddingModel(model);
  }
  return openai.textEmbeddingModel(model);
}

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
        embedding   vector(${embedSettings().dimensions}) NOT NULL,
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

    // `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already
    // exists, INCLUDING when its vector column is a different width — so a
    // project that switches embedding provider gets a schema step that reports
    // success and an insert that fails later with
    //
    //     error: expected 1536 dimensions, not 768
    //
    // which names neither the model, nor the setting, nor the table. Measured
    // exactly that while moving a live project from OpenAI to Ollama. Checking
    // the column here turns it into one sentence at startup with the command
    // that fixes it.
    const { rows } = await db.query<{ dims: number | null }>(
      `SELECT a.atttypmod AS dims
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'evestack' AND c.relname = 'memories' AND a.attname = 'embedding'`,
    );
    const existing = rows[0]?.dims ?? null;
    const { provider, model, dimensions } = embedSettings();
    if (existing !== null && existing > 0 && existing !== dimensions) {
      throw new Error(
        `evestack.memories stores ${existing}-dimensional vectors but this agent is configured for ` +
          `${dimensions} (${provider}/${model}). Vectors from two different models are ` +
          "not comparable, so the old rows cannot be kept. Either set " +
          `EVESTACK_EMBED_DIMENSIONS=${existing} and go back to the model that wrote them, or drop ` +
          "the table and start over:\n" +
          "    docker compose exec postgres psql -U evestack -d evestack -c 'DROP TABLE evestack.memories'",
      );
    }
  })();
  return ready;
}

async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: embeddingModel(), value: text });

  // A width that does not match the column is caught here, once, with both
  // numbers and the variable that reconciles them — rather than as pgvector's
  // `expected N dimensions, not M` from inside an INSERT, which names neither
  // the model nor the setting that produced it. It is the first thing that goes
  // wrong when someone changes EVESTACK_EMBED_MODEL on a database that already
  // has rows.
  const { provider, model, dimensions } = embedSettings();
  if (embedding.length !== dimensions) {
    throw new Error(
      `${provider}/${model} returns ${embedding.length}-dimensional vectors but this ` +
        `database stores ${dimensions}. Set EVESTACK_EMBED_DIMENSIONS=${embedding.length} and drop ` +
        "the evestack.memories table (existing rows were embedded by the old model and cannot be " +
        "compared against the new one).",
    );
  }
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
