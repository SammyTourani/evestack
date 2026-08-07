/**
 * `forget` on an id that does not exist must explain itself, not throw.
 *
 * The tool's not-found branch exists because a missing id is far more likely to be
 * a number the model invented than a race, so it answers with a note plus a sample
 * of real ids. It got that sample by calling `recall("")` — a vector search for
 * whatever is nearest to the empty string.
 *
 * Which throws. An empty string still has to be embedded, and an empty embedding is
 * an error on every provider: measured on the local path as
 * "Empty embeddings array returned", and OpenAI answers 400 on `'$.input'`. So the
 * one branch written to be helpful was the one branch that could not run.
 *
 * That failure lands inside a tool call, and per the header of lib/memory.ts the
 * model tends to relay a failed memory operation to the user as a success. The
 * whole sequence is: the model invents an id, a human approves the deletion at the
 * `always()` gate, nothing is deleted, the explanation throws, and the user is told
 * it worked.
 *
 * Asserted through the real lib, with no model and no agent — `recent()` and
 * `forget()` need neither. Uses its own schema-shaped rows in the real
 * `evestack.memories` table and cleans up only what it created, the same way
 * probe 06 does.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIMENSIONS_ENV = "EVESTACK_EMBED_DIMENSIONS";
const MEMORY_MODULE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "templates", "default", "lib", "memory.ts");

async function pgClient(connectionString) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  // A pg.Client with no 'error' listener turns a dead socket into an
  // uncaughtException, and in a probe runner that does not fail THIS probe — it
  // kills the process and takes every other probe's result with it. A Postgres
  // blip mid-suite would then report as "the suite crashed" instead of as one red
  // line. Every long-lived client under probes/ was missing it; the same listener
  // already exists in templates/default/scripts/checks.mjs connectPostgres(), for
  // the same reason and with the same body.
  //
  // A no-op, not `client.destroy()`: pg.Client has no `destroy`, only `end`, and
  // there is nothing useful to do here anyway — the next query rejects on its own
  // with pg's "Client has encountered a connection error and is not queryable",
  // which the runner reports as this probe failing, which is what it is.
  client.on("error", () => {});
  return client;
}

export default {
  id: "memory/forget-explains-a-missing-id-instead-of-throwing",
  title: "forget() on an unknown id returns a note and real ids, and never embeds an empty string",
  needs: ["postgres"],
  why:
    "The not-found branch called recall(\"\"), which embeds the empty string and throws on every " +
    "provider. So the branch that exists to explain a hallucinated id was the only branch that could " +
    "not run, and it failed inside a tool call where the model reports a failed memory write as a " +
    "success.",

  async available() {
    const url = process.env.WORKFLOW_POSTGRES_URL;
    if (!url) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await pgClient(url);
      await client.end();
      return [];
    } catch (error) {
      return [`cannot reach Postgres: ${error.message}`];
    }
  },

  async run(t) {
    const url = process.env.WORKFLOW_POSTGRES_URL;
    const admin = await pgClient(url);

    // Match whatever width is already stored, or the width guard in memory.ts will
    // correctly refuse to touch a table written by a different embedding model.
    const { rows: existing } = await admin.query(
      `SELECT a.atttypmod AS dims
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'evestack' AND c.relname = 'memories' AND a.attname = 'embedding'`,
    );
    const width = existing[0]?.dims ?? null;
    const saved = process.env[DIMENSIONS_ENV];
    if (width && width > 0) {
      process.env[DIMENSIONS_ENV] = String(width);
      t.note(`evestack.memories exists at ${width} dimensions; matching it`);
    }

    let createdTable = width === null;

    try {
      /* In a CHILD process, and that is not fussiness.
         templates/default/lib/memory.ts caches its Pool at module scope, and probe
         06 deliberately points that pool at a TCP proxy it then tears down. Both
         probes run in one process, so importing memory.ts here would reuse 06's
         dead pool and fail with an ECONNREFUSED that has nothing to do with this
         probe — measured exactly that before isolating. A child gets its own module
         state and its own pool, so this probe passes or fails on its own subject. */
      const script = `
        const { recent, forget } = await import(${JSON.stringify(MEMORY_MODULE)});
        const out = {};
        try { out.forgot = await forget(-424242); } catch (e) { out.forgetError = String(e.message ?? e); }
        try { out.sample = (await recent(5)).length; } catch (e) { out.sampleError = String(e.message ?? e); }
        process.stdout.write(JSON.stringify(out));
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { ...process.env },
      });
      let answer = {};
      try {
        answer = JSON.parse(result.stdout || "{}");
      } catch {
        answer = {};
      }

      t.ok(
        answer.forgetError === undefined,
        "forget() on an unknown id does not throw",
        answer.forgetError ? { actual: answer.forgetError.slice(0, 160) } : {},
      );
      t.ok(answer.forgot === false, "and reports that nothing was deleted", {
        actual: String(answer.forgot),
      });
      t.ok(
        answer.sampleError === undefined,
        "the sample of real ids can be fetched without embedding anything",
        answer.sampleError ? { actual: answer.sampleError.slice(0, 160) } : { actual: result.stderr.slice(0, 160) },
      );
      t.ok(typeof answer.sample === "number", "and it is a list", { actual: String(answer.sample) });

      /* Two properties, one spawn. Emptying the table first means the run below
         also covers the state a fresh project is in — zero rows — which is where a
         `rows[0]` access or an off-by-one would show up, and which the old
         `recall("")` would have failed on just as hard. */
      await admin.query("DELETE FROM evestack.memories").catch(() => {});

      /* The assertion that pins the property rather than the spelling: the old code
         got this sample from `recall("")`, so it needed the embedding provider to
         answer. A list of existing ids does not. An unreachable provider proves it. */
      /* The width has to be pinned explicitly here, and getting this wrong is how
         this probe first failed on a FRESH database. Switching the provider to
         ollama also switches the DEFAULT vector width to 768, while the table the
         first child just created is 1536 (the openai default, which is what a run
         with no EVESTACK_PROVIDER gets). memory.ts's width guard then correctly
         refused to touch it, and the failure looked like the thing being tested
         rather than the test's own doing. Read the width back and say it out loud. */
      const { rows: nowRows } = await admin.query(
        `SELECT a.atttypmod AS dims
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'evestack' AND c.relname = 'memories' AND a.attname = 'embedding'`,
      );
      const currentWidth = nowRows[0]?.dims ?? null;

      const offline = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          EVESTACK_PROVIDER: "ollama",
          OLLAMA_BASE_URL: "http://127.0.0.1:1",
          ...(currentWidth && currentWidth > 0 ? { [DIMENSIONS_ENV]: String(currentWidth) } : {}),
        },
      });
      let offlineAnswer = {};
      try {
        offlineAnswer = JSON.parse(offline.stdout || "{}");
      } catch {
        offlineAnswer = {};
      }
      t.ok(
        offlineAnswer.sampleError === undefined && offlineAnswer.sample === 0,
        "an empty table with no reachable embedding provider still gives a list, not an error",
        offlineAnswer.sampleError
          ? { actual: offlineAnswer.sampleError.slice(0, 160) }
          : { actual: offline.stderr.slice(0, 160) },
      );
    } finally {
      if (saved === undefined) delete process.env[DIMENSIONS_ENV];
      else process.env[DIMENSIONS_ENV] = saved;
      if (createdTable) {
        await admin.query("DROP TABLE IF EXISTS evestack.memories").catch(() => {});
      }
      await admin.end().catch(() => {});
    }
  },
};
