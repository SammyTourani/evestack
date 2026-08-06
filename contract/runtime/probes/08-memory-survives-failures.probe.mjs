/**
 * Long-term memory must not be able to kill the agent.
 *
 * It is an optional feature bolted onto a Postgres that is there for something
 * else, and the two ways it can take the whole process down with it are worth
 * a probe each. This file is that probe. It runs against a database it creates
 * and drops, never the one holding a developer real memories: lib/memory.ts
 * writes to a fixed `evestack.memories`, so the per-run schema trick probe 01
 * uses is not available here.
 *
 * ── The backend going away ───────────────────────────────────────────────────
 *
 * `pg.Pool` emits an `error` EVENT when an idle client socket fails. An
 * unhandled event is not a rejected promise — no `await`, no `try/catch` and no
 * `.catch()` can intercept it — so with no listener attached Node prints the
 * stack and exits.
 *
 * Measured before the fix: one ordinary `recall()`, then `pg_terminate_backend`
 * on the pooled connection, and the process was gone. That is not an exotic
 * input. It is what a Postgres restart does, what a failover does, what
 * `docker compose restart postgres` does, and what any idle-connection reaper
 * in front of the database does. The agent died with it, sessions and all.
 *
 * So the probe kills the backend out from under a live pool and requires two
 * things: the process is still running afterwards, and the next recall works.
 * The second half matters as much as the first — a handler that swallowed the
 * error but left the pool poisoned would pass the first check and be useless.
 *
 * ── The embedding provider going away ────────────────────────────────────────
 *
 * `forget` is gated behind `approval: always()`, so every deletion parks the
 * turn for a human. When the id turns out not to exist, the tool answers with
 * the ids that DO exist rather than a bare failure — a branch that exists
 * because a bad id is far more likely to be a hallucinated number than a race.
 *
 * That branch used to call `recall("")`, and an empty string is not something
 * any embedding endpoint will embed. Measured against the local default
 * (Ollama + nomic-embed-text):
 *
 *     recall("") -> OllamaError: Empty embeddings array returned
 *
 * OpenAI 400s on the same input. So the one branch written to be helpful was
 * the only one that threw, and it threw a message about embeddings at someone
 * who had just approved an irreversible delete.
 *
 * The provider stays pointed at a closed port for these checks, because "works
 * when embeddings are down" is the actual requirement and a probe that let the
 * provider answer would not be testing it.
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEMORY_TS = join(HERE, "..", "..", "..", "templates", "default", "lib", "memory.ts");

/** A closed port on loopback, inside the range this repo reserves for scratch
 *  services: any embedding call fails at once instead of hanging. */
const NO_EMBEDDINGS = "http://127.0.0.1:14087";

async function adminClient() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  return client;
}

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = "/" + name;
  return parsed.toString();
}

export default {
  id: "memory/an-optional-feature-cannot-kill-the-agent",
  title: "long-term memory survives the database restarting and the embedder going away",
  needs: ["postgres"],
  why:
    "pg.Pool emits an error EVENT when an idle client socket fails, and an unhandled event is " +
    "not a rejected promise: no try/catch in lib/memory.ts could ever see it. Measured, one " +
    "recall() followed by pg_terminate_backend killed the whole agent process. A Postgres " +
    "restart, a failover or docker compose restart postgres all do exactly that.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await adminClient();
      await client.end();
    } catch (error) {
      return ["cannot reach Postgres: " + error.message];
    }
    try {
      await import(pathToFileURL(MEMORY_TS).href);
    } catch (error) {
      // Almost always templates/default/node_modules missing. Under --require
      // that is a failure, which is right: this is the only probe that runs the
      // template own code rather than a copy of its SQL.
      return ["cannot import templates/default/lib/memory.ts: " + error.message];
    }
    return [];
  },

  async run(t) {
    const admin = await adminClient();
    const dbName = "probe_" + randomUUID().replace(/-/g, "").slice(0, 12);
    const original = {
      url: process.env.WORKFLOW_POSTGRES_URL,
      provider: process.env.EVESTACK_EMBED_PROVIDER,
      base: process.env.OLLAMA_BASE_URL,
    };

    try {
      await admin.query("CREATE DATABASE " + dbName);
      t.note("running against a throwaway database, never the one holding real memories");

      // lib/memory.ts reads these lazily and memoises on first use, so they
      // must be set before the first call rather than after.
      process.env.WORKFLOW_POSTGRES_URL = withDatabase(original.url, dbName);
      process.env.EVESTACK_EMBED_PROVIDER = "ollama";
      process.env.OLLAMA_BASE_URL = NO_EMBEDDINGS;

      const mem = await import(pathToFileURL(MEMORY_TS).href);
      const { default: pg } = await import("pg");

      // Open the pool the way the agent does. The embedding endpoint is down on
      // purpose, so this throws — that is fine and expected. What matters is
      // that ensureSchema() ran first and the pool now holds a live connection.
      let embeddingsAreDown = false;
      try {
        await mem.recall("a query with actual words in it", { limit: 1 });
      } catch {
        embeddingsAreDown = true;
      }
      t.ok(embeddingsAreDown, "the embedding provider really is unreachable at " + NO_EMBEDDINGS, {
        ...(embeddingsAreDown ? {} : { expected: "an error", actual: "it succeeded" }),
      });

      const before = await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [dbName]);
      t.ok(before.rows[0].n > 0, "the memory pool is holding " + before.rows[0].n + " connection(s) to kill", {
        ...(before.rows[0].n > 0 ? {} : { expected: "at least one", actual: "0" }),
      });

      // What a restart, a failover or an idle-connection reaper does.
      const killed = await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity" +
        " WHERE datname = $1 AND pid <> pg_backend_pid()", [dbName]);
      t.note("terminated " + killed.rowCount + " backend(s) under the live pool");

      // Long enough for the socket error to reach the pool. Without an `error`
      // listener on it, the process is already gone by the time this resolves
      // and nothing below ever runs — the probe crashes rather than fails,
      // which the runner reports as a failure either way.
      await new Promise((resolve) => setTimeout(resolve, 750));
      t.ok(true, "the process is still alive after the backend was terminated");

      // A handler that swallowed the error but left the pool poisoned would
      // pass the check above and be no use at all. forget() needs no embedding,
      // so this is a clean test of the connection rather than of the provider.
      let recovered = null;
      let recoveryError = null;
      try {
        recovered = await mem.forget(999999999);
      } catch (error) {
        recoveryError = error.message;
      }
      t.ok(recovered === false, "the next memory query reconnects and answers", {
        ...(recovered === false ? {} : { expected: "false", actual: recoveryError ?? String(recovered) }),
      });

      /* ── the embedding provider going away ─────────────────────────────── */

      t.ok(typeof mem.recentMemories === "function",
        "lib/memory.ts exports recentMemories, a listing that needs no model", {
          ...(typeof mem.recentMemories === "function"
            ? {}
            : { expected: "function", actual: typeof mem.recentMemories }),
        });

      // The call the old forget.ts made when an id was not found.
      let blank = null;
      let blankError = null;
      try {
        blank = await mem.recall("", { limit: 5 });
      } catch (error) {
        blankError = error.message;
      }
      const blankIsEmpty = Array.isArray(blank) && blank.length === 0;
      t.ok(blankIsEmpty, "recall on a blank query answers with no matches instead of throwing", {
        ...(blankIsEmpty ? {} : { expected: "[]", actual: blankError ?? JSON.stringify(blank) }),
      });

      // Seeded as SQL, because remember() needs the provider that is off on
      // purpose. The vector is whatever width ensureSchema() chose.
      const seed = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
      await seed.connect();
      try {
        const dims = Number((await seed.query(
          "SELECT a.atttypmod AS dims FROM pg_attribute a" +
          " JOIN pg_class c ON c.oid = a.attrelid" +
          " JOIN pg_namespace n ON n.oid = c.relnamespace" +
          " WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3",
          ["evestack", "memories", "embedding"],
        )).rows[0]?.dims);
        const filler = "[" + new Array(dims).fill(0.01).join(",") + "]";
        for (const content of ["oldest fact", "middle fact", "newest fact"]) {
          await seed.query(
            "INSERT INTO evestack.memories (content, tags, embedding) VALUES ($1, $2, $3::vector)",
            [content, ["seeded"], filler],
          );
          // Distinct created_at, so "newest first" has a defined answer rather
          // than a tie broken however the executor feels.
          await seed.query("SELECT pg_sleep(0.01)");
        }
      } finally {
        await seed.end().catch(() => {});
      }

      const listed = await mem.recentMemories(5);
      const order = listed.map((m) => m.content);
      const wanted = ["newest fact", "middle fact", "oldest fact"];
      const rightOrder = order.length === wanted.length && order.every((v, i) => v === wanted[i]);
      t.ok(rightOrder, "recentMemories lists the seeded rows newest first, with no model call", {
        ...(rightOrder ? {} : { expected: wanted.join(", "), actual: order.join(", ") || "NOTHING" }),
      });

      const realIds = listed.every((m) => Number.isInteger(m.id) && m.id > 0);
      t.ok(realIds, "every listed memory carries the real id forget has to be given", {
        ...(realIds ? {} : { expected: "integer ids", actual: JSON.stringify(listed.map((m) => m.id)) }),
      });

      const deleted = await mem.forget(listed[0].id);
      t.ok(deleted === true, "forget deletes a real id with the embedding provider still down", {
        ...(deleted === true ? {} : { expected: "true", actual: String(deleted) }),
      });
    } finally {
      for (const [key, value] of [
        ["WORKFLOW_POSTGRES_URL", original.url],
        ["EVESTACK_EMBED_PROVIDER", original.provider],
        ["OLLAMA_BASE_URL", original.base],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // FORCE because lib/memory.ts keeps a pool it exposes no way to close,
      // and a plain DROP DATABASE would fail on its open connections.
      await admin.query("DROP DATABASE IF EXISTS " + dbName + " WITH (FORCE)").catch(() => {});
      await admin.end().catch(() => {});
    }
  },
};
