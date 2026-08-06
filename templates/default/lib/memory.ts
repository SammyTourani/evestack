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

/**
 * `pg`'s connection failures, made readable.
 *
 * A refused connection to a host that resolves to BOTH ::1 and 127.0.0.1 arrives
 * as an `AggregateError` whose own `message` is the EMPTY STRING — every detail
 * is one level down in `.errors`. So `remember` failed with literally
 * "AggregateError" and nothing else: no host, no port, no reason. That string
 * goes into a tool result, which the model then paraphrases to the user, and per
 * the header of this file it tends to paraphrase it as success.
 *
 * scripts/checks.mjs already had to solve this for `npm run verify`. An error the
 * agent relays to a person needs it at least as much.
 *
 * Only NETWORK failures are rewritten. A Postgres error carrying a SQLSTATE — a
 * missing privilege, a bad column — is passed through untouched, because calling
 * that "cannot reach Postgres" would send the reader at the wrong problem.
 */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
  "EAI_AGAIN",
]);

/**
 * The connection failures `pg` reports as plain Errors with NO `code`.
 *
 * A syscall error carries ECONNREFUSED and friends, but a connection that drops
 * once established does not: `pg` throws its own Error, and matching on `code`
 * alone let it through unannotated. CI caught this — the probe destroys a socket,
 * which on Linux surfaces as "Connection terminated unexpectedly" rather than the
 * ECONNRESET macOS produced, so the check for a named host and port failed on a
 * platform I had not run it on.
 *
 * That is the laptop-resume case named in ensureSchema's note, so it is the case
 * this most needs to read well. Matching on message text is fragile by nature, so
 * these are copied verbatim from pg 8 (`lib/client.js`, `lib/connection.js`) and
 * pg-pool, and a string that stops matching costs context in an error message
 * rather than correctness anywhere.
 */
const PG_CONNECTION_FAILURES = new Set([
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Client has encountered a connection error and is not queryable",
  "timeout expired",
  "timeout exceeded when trying to connect",
]);

function networkReason(error: unknown): string | null {
  if (error instanceof AggregateError) {
    const parts = (Array.isArray(error.errors) ? error.errors : [])
      .map(networkReason)
      .filter((part): part is string => Boolean(part));
    const unique = [...new Set(parts)];
    return unique.length > 0 ? unique.join("; ") : null;
  }
  if (error instanceof Error) {
    const { code, address, port } = error as Error & {
      code?: string;
      address?: string;
      port?: number;
    };
    if (code && NETWORK_CODES.has(code)) {
      const where = address ? ` (${address}${port ? `:${port}` : ""})` : "";
      return `${code}${where}`;
    }
    // A SQLSTATE is a real answer from a reachable server, so it is never one of
    // these and must keep its own message.
    if (!code && PG_CONNECTION_FAILURES.has(error.message.trim())) return error.message.trim();
  }
  return null;
}

/** Host and port only — never the connection string, which carries the password. */
function postgresTarget(): string {
  const parsed = URL.parse(process.env.WORKFLOW_POSTGRES_URL ?? "");
  return parsed ? `${parsed.hostname}:${parsed.port || "5432"}` : "the configured WORKFLOW_POSTGRES_URL";
}

function withPostgresContext(error: unknown): unknown {
  const reason = networkReason(error);
  if (!reason) return error;
  return new Error(
    `Long-term memory cannot reach Postgres at ${postgresTarget()} — ${reason}. Start it with ` +
      "`docker compose up -d postgres`. Nothing was saved, and no restart of the agent is " +
      "needed: the next call tries again.",
    { cause: error },
  );
}

/** Wraps the three tool entry points, so a dead database reads the same from all
 *  of them however far into the call it is noticed. */
async function readable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw withPostgresContext(error);
  }
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
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 4 });
    // WITHOUT THIS LISTENER A POSTGRES RESTART KILLS THE AGENT.
    //
    // pg-pool attaches its own handler to idle clients and re-emits their socket
    // errors on the pool. `EventEmitter.emit("error")` with nothing listening
    // throws, so the failure is not a rejected query — it is an
    // uncaughtException that takes down the whole process: every session, every
    // channel, because an optional memory tool once left a client idle.
    //
    // Measured with a proxy that drops an established connection while the
    // client sat idle in the pool: `UNCAUGHT EXCEPTION -> Connection terminated
    // unexpectedly`, exit code 9. packages/dashboard/lib/db.ts already carried
    // this listener and the reason for it; the three pools inside the agent did
    // not.
    //
    // Nothing to do but say so. pg has already discarded the dead client, and
    // the next call gets a fresh one.
    pool.on("error", (error) => {
      console.warn(`[evestack] idle Postgres client error: ${networkReason(error) ?? error.message}`);
    });
  }
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
  // The `.catch` on the end of this is load-bearing; see the note there.
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
  })().catch((error: unknown) => {
    // `ready` memoizes the PROMISE, and a rejected promise is still a memoized
    // one: without this, every later call is handed the same rejection back
    // forever. Postgres becoming ready a few seconds after the agent — the
    // normal order under `docker compose up`, and what happens on every laptop
    // resume — therefore disabled long-term memory for the entire life of the
    // process, and went on reporting the original "connection refused" long
    // after the connection worked.
    //
    // Measured, not theorised: stop Postgres, call `remember` (fails,
    // correctly), start Postgres, wait for pg_isready, call `remember` again —
    // still the stale error. `eve dev` runs for hours, so "the life of the
    // process" means the rest of the working day, and the model reports the save
    // as successful anyway.
    //
    // So the memo is kept on success and dropped on failure. A retry costs a
    // handful of catalog queries, and the deliberate error above (a vector-width
    // mismatch) simply throws again unchanged — which is the right outcome for a
    // condition that really is permanent.
    ready = null;
    throw error;
  });
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
  return readable(async () => {
    await ensureSchema();
    const embedding = await embedText(content);
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO evestack.memories (content, tags, session_id, embedding)
       VALUES ($1, $2, $3, $4::vector) RETURNING id`,
      [content, options.tags ?? [], options.sessionId ?? null, JSON.stringify(embedding)],
    );
    return { id: Number(rows[0].id) };
  });
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
  return readable(() => recallOnce(queryText, options));
}

/** Split out only so `recall` can wrap it whole; the transaction below already
 *  has a catch of its own, and a dead database is noticed before it. */
async function recallOnce(
  queryText: string,
  options: { limit?: number; tags?: string[]; minSimilarity?: number },
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

/**
 * The most recent memories, without embedding anything.
 *
 * `forget` needs this for its not-found branch, and used to get it by calling
 * `recall("")` — a vector search for whatever is nearest to the empty string.
 * That throws. Measured on the local path: `Empty embeddings array returned`.
 * OpenAI rejects empty input too, with a 400 on `'$.input'`.
 *
 * So the branch written to explain a hallucinated id was the one branch that
 * could not run, and it failed inside a tool call, where per the header of this
 * file the model tends to report success anyway.
 *
 * A plain ordered SELECT is also the more honest answer to the question being
 * asked. "Show the model some real ids" is not a similarity query, and ranking by
 * distance from a degenerate vector would be an arbitrary order dressed as
 * relevance even on a provider that tolerated the empty input.
 */
export async function recent(limit = 5): Promise<Recalled[]> {
  return readable(async () => {
    await ensureSchema();
    const { rows } = await getPool().query<MemoryRow>(
      `SELECT id, content, tags, created_at, 1 AS similarity
         FROM evestack.memories
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [Math.max(1, Math.min(limit, 50))],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      content: r.content,
      tags: r.tags ?? [],
      // Not a similarity — nothing was compared. Reported as 1 so the shape
      // matches Recalled, and callers that show a score show a truthful "exact".
      similarity: 1,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  });
}

export async function forget(id: number): Promise<boolean> {
  return readable(async () => {
    await ensureSchema();
    const { rowCount } = await getPool().query("DELETE FROM evestack.memories WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  });
}
