/**
 * IVFFlat and HNSW, built side by side on an empty table, measured against the
 * exhaustive answer.
 *
 * docs/memory.mdx justifies shipping HNSW with numbers. This probe is where
 * those numbers come from, so the page cannot drift away from what the database
 * actually does — which is what happened to the version of that page this
 * probe replaced. It said the same query returned 2 rows at LIMIT 3 and 0 rows
 * at LIMIT 20. The first half is real. The second is backwards.
 *
 * Backwards for a reason worth writing down, because it is what makes the
 * monotonicity check safe to assert rather than flaky. One IVFFlat scan returns
 * min(limit, rows in the probed list), which cannot shrink as the limit grows.
 * The only other way to get fewer rows from a larger limit is for the plan to
 * change, and the plan can only change one way: Postgres charges an ordered
 * index path in proportion to limit/rows, while a top-N sort grows with
 * log(limit). Raising the limit moves the planner OFF the vector index and
 * never onto it. So ask-for-more-get-less is not the symptom. The symptom is
 * that SMALL limits get the broken index — and small is where a memory tool
 * lives, since recall() defaults to 5.
 *
 * ── What this probe does NOT assert, and why ─────────────────────────────────
 *
 * Not "HNSW returns the exhaustive answer". It does not, and demanding that
 * would be demanding that an approximate index stop being approximate. On the
 * deliberately hostile data below — dense random unit vectors in 1536
 * dimensions, where every pair is nearly orthogonal and the true nearest
 * neighbour is barely nearer than the hundredth — HNSW picked a different top
 * row in 16 of 96 measured cases. That is the index working as designed.
 *
 * What separates the two indexes is not ranking noise, it is whether they can
 * answer at all: IVFFlat returned FEWER ROWS THAN ASKED FOR in 26 of those 96
 * cases and HNSW in none, and IVFFlat missed the true nearest row in all 96
 * against HNSW s 16. Those are the assertions.
 */
import { randomUUID } from "node:crypto";

/** The OpenAI default in templates/default/lib/memory.ts. */
const DIMENSIONS = 1536;

/** Enough rows that the planner picks the vector index at small limits and a
 *  seq scan at large ones. Measured: the flip sits between LIMIT 5 and 20. */
const ROWS = 800;

/** Deterministic, so a failure reproduces and a pass is not luck. */
const QUERIES = 24;
const LIMITS = [1, 3, 5, 20];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function unitVector(rand) {
  const v = new Array(DIMENSIONS);
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    v[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIMENSIONS; i++) v[i] /= norm;
  return "[" + v.join(",") + "]";
}

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  return client;
}

/**
 * recall() from templates/default/lib/memory.ts, verbatim apart from the
 * schema. The similarity column is NOT decoration: dropping it changes the
 * plan. Measured — without it the planner sequentially scans this table at
 * every limit, the IVFFlat index is never chosen, and the probe reports that
 * IVFFlat is fine. A probe that simplifies the query tests the simplification.
 */
const RECALL =
  "SELECT id, content, tags, created_at, 1 - (embedding <=> $1::vector) AS similarity" +
  " FROM SCHEMA.memories" +
  " WHERE ($2::text[] = ARRAY[]::text[] OR tags && $2::text[])" +
  " ORDER BY embedding <=> $1::vector LIMIT $3";

export default {
  id: "memory/hnsw-beats-ivfflat-on-an-empty-table",
  title: "the vector index the template ships can answer from the first row; IVFFlat cannot",
  needs: ["postgres"],
  why:
    "The memory table is indexed before it holds anything, so an IVFFlat index has no training " +
    "data and answers out of one near-empty list. Measured: 0 rows at LIMIT 1 on a 200-row " +
    "table, 2 rows at LIMIT 3 on an 800-row one, and a LIMIT 1 that returns the wrong memory " +
    "while looking perfectly healthy. Nothing errors. docs/memory.mdx quotes these numbers to " +
    "justify HNSW, so they are measured here rather than remembered.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await connect();
      await client.end();
      return [];
    } catch (error) {
      return ["cannot reach Postgres: " + error.message];
    }
  },

  async run(t) {
    const client = await connect();
    const stem = "probe_" + randomUUID().replace(/-/g, "").slice(0, 10);
    const schemas = { ivfflat: stem + "_ivf", hnsw: stem + "_hnsw" };

    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");

      const rand = rng(20260806);
      const rows = [];
      for (let i = 0; i < ROWS; i++) rows.push(unitVector(rand));
      const queries = [];
      for (let i = 0; i < QUERIES; i++) queries.push(unitVector(rand));

      for (const kind of ["ivfflat", "hnsw"]) {
        const s = schemas[kind];
        await client.query("CREATE SCHEMA " + s);
        // Mirrors ensureSchema(), including the part that matters: both
        // indexes exist before the first insert.
        await client.query(
          "CREATE TABLE " + s + ".memories (" +
            "id bigserial PRIMARY KEY, content text NOT NULL," +
            " tags text[] NOT NULL DEFAULT ARRAY[]::text[], session_id text," +
            " embedding vector(" + DIMENSIONS + ") NOT NULL," +
            " created_at timestamptz NOT NULL DEFAULT now())",
        );
        await client.query(
          "CREATE INDEX memories_embedding_idx ON " + s + ".memories USING " + kind +
            " (embedding vector_cosine_ops)",
        );
        await client.query("CREATE INDEX memories_tags_idx ON " + s + ".memories USING gin (tags)");
        for (let i = 0; i < ROWS; i += 100) {
          const chunk = rows.slice(i, i + 100);
          const values = chunk.map((_, j) => "($" + (j * 2 + 1) + ", $" + (j * 2 + 2) + "::vector)");
          const params = [];
          for (let j = 0; j < chunk.length; j++) {
            params.push("memory " + (i + j));
            params.push(chunk[j]);
          }
          await client.query(
            "INSERT INTO " + s + ".memories (content, embedding) VALUES " + values.join(","),
            params,
          );
        }
        await client.query("ANALYZE " + s + ".memories");
      }
      t.note(ROWS + " rows inserted into both schemas AFTER their indexes existed");

      const am = await client.query(
        "SELECT n.nspname, am.amname FROM pg_index i" +
        " JOIN pg_class c ON c.oid = i.indexrelid" +
        " JOIN pg_am am ON am.oid = c.relam" +
        " JOIN pg_class tbl ON tbl.oid = i.indrelid" +
        " JOIN pg_namespace n ON n.oid = tbl.relnamespace" +
        " WHERE c.relname = $1 AND n.nspname = ANY($2::text[])",
        ["memories_embedding_idx", [schemas.ivfflat, schemas.hnsw]],
      );
      const built = Object.fromEntries(am.rows.map((r) => [r.nspname, r.amname]));
      for (const kind of ["hnsw", "ivfflat"]) {
        const got = built[schemas[kind]];
        t.ok(got === kind, "the " + kind + " index reports amname=" + kind + " in pg_am, not just in its DDL", {
          ...(got === kind ? {} : { expected: kind, actual: String(got) }),
        });
      }

      // "exact" reads every row and sorts: by definition the right answer.
      // "forced" makes the planner use the vector index, which is how the index
      // itself gets measured rather than the planner s taste. "planner" is what
      // a user actually gets.
      async function ask(kind, q, limit, mode) {
        await client.query("BEGIN");
        try {
          if (mode === "exact") await client.query("SET LOCAL enable_indexscan = off");
          if (mode === "forced") await client.query("SET LOCAL enable_seqscan = off");
          await client.query("SET LOCAL hnsw.ef_search = " + Math.max(40, limit * 2));
          const r = await client.query(RECALL.replace("SCHEMA", schemas[kind]), [q, [], limit]);
          return r.rows.map((row) => row.content);
        } finally {
          await client.query("ROLLBACK");
        }
      }

      const stat = { ivfflat: { short: 0, topWrong: 0 }, hnsw: { short: 0, topWrong: 0 } };
      let plannerNonMonotonic = 0;
      let witness = null;

      for (const q of queries) {
        const plannerCounts = [];
        for (const limit of LIMITS) {
          const truth = await ask("hnsw", q, limit, "exact");
          for (const kind of ["ivfflat", "hnsw"]) {
            const forced = await ask(kind, q, limit, "forced");
            if (forced.length < Math.min(limit, ROWS)) stat[kind].short++;
            if (forced[0] !== truth[0]) stat[kind].topWrong++;
            if (kind === "ivfflat" && !witness && forced.length < Math.min(limit, ROWS)) {
              witness = "LIMIT " + limit + " asked for " + limit + ", IVFFlat returned " +
                forced.length + " (top " + (forced[0] ?? "NOTHING") + "); reading every row returns " +
                truth.length + " (top " + truth[0] + ")";
            }
          }
          plannerCounts.push((await ask("ivfflat", q, limit, "planner")).length);
        }
        for (let a = 0; a < plannerCounts.length - 1; a++) {
          for (let b = a + 1; b < plannerCounts.length; b++) {
            if (plannerCounts[b] < plannerCounts[a]) plannerNonMonotonic++;
          }
        }
      }
      const total = QUERIES * LIMITS.length;

      // The assertion the template exists to satisfy: asking HNSW for N
      // memories gets N memories.
      t.ok(stat.hnsw.short === 0,
        "HNSW never returned fewer rows than asked for, in " + total + " forced-index queries",
        { ...(stat.hnsw.short === 0 ? {} : { expected: 0, actual: stat.hnsw.short }) });

      // And the reason it is not IVFFlat. Without this check the one above
      // would pass equally well against a table with no vector index at all.
      t.ok(stat.ivfflat.short > 0,
        "IVFFlat on the same empty-built table did return short: " + stat.ivfflat.short + "/" + total,
        { ...(stat.ivfflat.short > 0 ? {} : { expected: "at least one short answer", actual: "none" }) });
      if (witness) t.note(witness);

      // Ranking, separately from row count. Both indexes are approximate and
      // this data is adversarial, so the test is comparative, not absolute.
      t.ok(stat.ivfflat.topWrong > stat.hnsw.topWrong,
        "IVFFlat misses the true nearest row far more often than HNSW (" +
          stat.ivfflat.topWrong + "/" + total + " vs " + stat.hnsw.topWrong + "/" + total + ")",
        { ...(stat.ivfflat.topWrong > stat.hnsw.topWrong
          ? {}
          : { expected: "ivfflat worse than hnsw", actual: stat.ivfflat.topWrong + " vs " + stat.hnsw.topWrong }) });

      // The claim docs/memory.mdx now makes, and the one the old page
      // contradicted. If "2 rows at LIMIT 3 and 0 at LIMIT 20" were real, this
      // fails.
      t.ok(plannerNonMonotonic === 0,
        "no larger LIMIT ever returned fewer rows than a smaller one, even from IVFFlat",
        { ...(plannerNonMonotonic === 0 ? {} : { expected: 0, actual: plannerNonMonotonic }) });

      // The only check that looks at what the template actually built, rather
      // than at a copy of its DDL. Skipped rather than failed when the agent
      // has never run: an empty database is not a wrong index.
      const shipped = await client.query(
        "SELECT c.relname, am.amname FROM pg_index i" +
        " JOIN pg_class c ON c.oid = i.indexrelid" +
        " JOIN pg_am am ON am.oid = c.relam" +
        " JOIN pg_class tbl ON tbl.oid = i.indrelid" +
        " JOIN pg_namespace n ON n.oid = tbl.relnamespace" +
        " WHERE n.nspname = $1 AND tbl.relname = $2 AND am.amname = ANY($3::text[])",
        ["evestack", "memories", ["hnsw", "ivfflat"]],
      );
      if (shipped.rows.length === 0) {
        t.note("no evestack.memories in this database yet, so there is no shipped index to read");
      } else {
        const amname = shipped.rows[0].amname;
        t.ok(amname === "hnsw",
          "the live evestack.memories vector index reads back as HNSW (" + shipped.rows[0].relname + ")",
          { ...(amname === "hnsw" ? {} : { expected: "hnsw", actual: amname }) });
      }
    } finally {
      for (const s of Object.values(schemas)) {
        await client.query("DROP SCHEMA IF EXISTS " + s + " CASCADE").catch(() => {});
      }
      await client.end().catch(() => {});
    }
  },
};
