/**
 * Recall must return the same rows whichever query plan Postgres picks.
 *
 * This is the IVFFlat bug made into a permanent check. The memory schema
 * originally built `USING ivfflat`, which assigns vectors to `lists` centroids
 * at build time and probes one per query. Built on an empty table — as any
 * bootstrap migration must be — those centroids are meaningless. Postgres reads
 * a small table sequentially and gets the right answer; the moment the planner
 * decides the index is worth using, it probes one near-empty list and returns
 * NOTHING for a query that plainly matches.
 *
 * That is why the symptom was so confusing: the query did not change, the
 * *plan* changed, and nothing errored. Measured on 17.10 / pgvector 0.8.6 with
 * the index built before the first insert: a 200-row table answered `LIMIT 1`
 * with **0 rows** off the IVFFlat index and `LIMIT 3` with the correct 3 off a
 * seq scan; an 800-row table answered `LIMIT 3` with **2 rows** and `LIMIT 1`
 * with one row that was simply the WRONG memory.
 *
 * An earlier version of this comment said 2 rows at `LIMIT 3` and 0 at
 * `LIMIT 20`. The first half is real; the second is backwards. Raising the
 * limit can only move the planner OFF an ordered index path (its cost grows
 * linearly in the limit, a top-N sort's logarithmically), and one IVFFlat scan
 * returns min(limit, rows in the probed list) — so a larger limit cannot return
 * fewer rows, and in 1,440 measured queries it never did. The damage lands on
 * SMALL limits, which is where `recall` lives: its default is 5.
 *
 * So the invariant this probe asserts is not "recall returns rows" — a
 * sequential scan would satisfy that forever while the index was broken. It is
 * **the exact plan-independence the bug violated**: run every query twice, once
 * letting Postgres choose and once forcing the index, and require identical
 * results. An approximate index that cannot answer correctly shows up as a
 * disagreement between the two.
 *
 * ── Getting this probe wrong, and what it taught ─────────────────────────────
 *
 * The first version of this file built its own simplified table with no GIN
 * index on `tags`, and forced `enable_seqscan = off` globally. It duly reported
 * two dramatic failures: tag-filtered recall returning zero rows, and `LIMIT 50`
 * returning 40. Both were artifacts. The real schema *does* create the GIN
 * index, which is what makes filtered recall exact; and forcing an index scan on
 * a 60-row table exposes HNSW's `ef_search` ceiling in a situation the real
 * planner never chooses.
 *
 * A probe that builds its own approximation of the schema tests its own
 * approximation. This one now mirrors `templates/default/lib/memory.ts`
 * statement for statement, and any drift between them should be treated as this
 * probe going stale rather than as a discovery.
 */
import { randomUUID } from "node:crypto";

/** Must match DIMENSIONS in templates/default/lib/memory.ts. */
const DIMENSIONS = 1536;

/** Rows enough that the planner has a real choice to make. */
const ROWS = 400;

/** Of those, the tail carries a tag, and is deliberately the FARTHEST from the
 *  query vector — the case where an approximate index would never surface them
 *  because it stops looking before it gets that far. */
const TAGGED = 10;

/**
 * Row `i` sits at angle `i / ROWS` in the plane spanned by the first two
 * dimensions, so cosine distance from row 0 grows strictly with `i` and every
 * row has a *distinct* distance.
 *
 * The first version put a 1 on the row's own axis and 0.001 everywhere else,
 * which made every row equidistant from every other. Ordering was then a tie
 * broken arbitrarily, and two plans disagreeing about arbitrary ties looked
 * exactly like the plan-dependence bug this probe hunts. A test whose expected
 * answer is undefined cannot fail honestly.
 */
function gradedVector(i, total) {
  const angle = (i / total) * (Math.PI / 2);
  const v = new Array(DIMENSIONS).fill(0);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return `[${v.join(",")}]`;
}

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  return client;
}

export default {
  id: "memory/recall-does-not-depend-on-the-plan",
  title: "recall returns identical rows whether or not the vector index is used",
  needs: ["postgres"],
  why:
    "Memory recall returned zero rows for queries that plainly matched, because an approximate " +
    "index built on an empty table could not answer. Nothing errored: measured, a 200-row table " +
    "answered LIMIT 1 with 0 rows off the IVFFlat index and LIMIT 3 with the correct 3 off a " +
    "seq scan, purely because the plan flipped. The agent simply behaved as though it had " +
    "never remembered anything.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await connect();
      await client.end();
      return [];
    } catch (error) {
      return [`cannot reach Postgres: ${error.message}`];
    }
  },

  async run(t) {
    const client = await connect();
    // Per-run schema: this must never see or disturb a developer's real
    // memories sitting in the same database.
    const schema = `probe_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");

      await client.query(`CREATE SCHEMA ${schema}`);
      // Mirrors lib/memory.ts ensureSchema() — same columns, same index types,
      // and critically the same ORDER: both indexes are created while the table
      // is empty, which is the condition that broke IVFFlat.
      await client.query(`
        CREATE TABLE ${schema}.memories (
          id          bigserial PRIMARY KEY,
          content     text NOT NULL,
          tags        text[] NOT NULL DEFAULT '{}',
          session_id  text,
          embedding   vector(${DIMENSIONS}) NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX ON ${schema}.memories USING hnsw (embedding vector_cosine_ops)`,
      );
      await client.query(`CREATE INDEX ON ${schema}.memories USING gin (tags)`);
      t.note("schema and both indexes built on an empty table, as the bootstrap migration does");

      const values = [];
      for (let i = 0; i < ROWS; i++) {
        values.push(`('memory ${i}', '${i >= ROWS - TAGGED ? "{rare}" : "{}"}', '${gradedVector(i, ROWS)}')`);
      }
      for (let i = 0; i < values.length; i += 100) {
        await client.query(
          `INSERT INTO ${schema}.memories (content, tags, embedding) VALUES ${values.slice(i, i + 100).join(",")}`,
        );
      }
      await client.query(`ANALYZE ${schema}.memories`);
      t.note(`${ROWS} rows inserted after the indexes existed; ${TAGGED} carry a rare tag`);

      // The recall() query from lib/memory.ts, verbatim apart from the schema.
      const RECALL = `
        SELECT id, content, tags, created_at,
               1 - (embedding <=> $1::vector) AS similarity
          FROM ${schema}.memories
         WHERE ($2::text[] = '{}' OR tags && $2::text[])
         ORDER BY embedding <=> $1::vector
         LIMIT $3`;

      const query = gradedVector(0, ROWS);

      /**
       * Runs RECALL under a specific planner setting, in its own transaction so
       * the setting cannot leak into the next case.
       *
       * `SET LOCAL hnsw.ef_search` mirrors what recall() itself now does. It is
       * not a convenience for the probe: HNSW returns at most ef_search rows,
       * whose default of 40 is below recall()'s own cap of 50, so without it a
       * request for 50 comes back with 40 and the ordering is silently
       * truncated. Measured against 5,000 rows with the planner left alone. If
       * this line and the one in lib/memory.ts ever disagree, this probe is
       * testing something the product does not do.
       */
      async function run(tags, limit, forceIndex) {
        await client.query("BEGIN");
        try {
          if (forceIndex) await client.query("SET LOCAL enable_seqscan = off");
          await client.query(`SET LOCAL hnsw.ef_search = ${Math.max(40, limit * 2)}`);
          const { rows } = await client.query(RECALL, [query, tags, limit]);
          return rows.map((r) => r.content);
        } finally {
          await client.query("ROLLBACK");
        }
      }

      const cases = [
        { label: "no tag filter, limit 1", tags: [], limit: 1, expect: 1 },
        { label: "no tag filter, limit 3", tags: [], limit: 3, expect: 3 },
        { label: "no tag filter, limit 20", tags: [], limit: 20, expect: 20 },
        // recall() caps its own limit at 50, so this is the widest query the
        // shipped code can ever issue.
        { label: "no tag filter, limit 50 (recall's own cap)", tags: [], limit: 50, expect: 50 },
        // The filtered cases matter most: an approximate index searches by
        // distance and only then applies the filter, so rare tags on distant
        // rows are exactly what it would fail to find.
        { label: "rare tag, limit 5", tags: ["rare"], limit: 5, expect: 5 },
        { label: "rare tag, limit 20 (fewer rows exist than asked for)", tags: ["rare"], limit: 20, expect: TAGGED },
      ];

      for (const c of cases) {
        const planner = await run(c.tags, c.limit, false);
        const forced = await run(c.tags, c.limit, true);

        t.ok(
          planner.length === c.expect,
          `${c.label} returns ${c.expect} rows`,
          planner.length === c.expect ? {} : { expected: c.expect, actual: planner.length },
        );

        // The assertion this probe exists for.
        const same = planner.length === forced.length && planner.every((v, i) => v === forced[i]);
        t.ok(same, `${c.label} is unchanged when the vector index is forced`, {
          ...(same
            ? {}
            : {
                expected: `${planner.length} rows: ${planner.slice(0, 3).join(", ")}…`,
                actual: `${forced.length} rows: ${forced.slice(0, 3).join(", ") || "NOTHING"}…`,
              }),
        });
      }

      // Ordering is the other half of correctness: a plan that returns the right
      // count in the wrong order is still wrong, and would go unnoticed above.
      const nearest = (await run([], 1, false))[0];
      t.ok(nearest === "memory 0", "the nearest row is the one built to be nearest", {
        ...(nearest === "memory 0" ? {} : { expected: "memory 0", actual: nearest ?? "NOTHING" }),
      });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await client.end().catch(() => {});
    }
  },
};
