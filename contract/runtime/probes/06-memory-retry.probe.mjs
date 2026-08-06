/**
 * A database that was merely LATE must not disable long-term memory for good.
 *
 * `ensureSchema()` in templates/default/lib/memory.ts memoizes its work in a
 * module-level `ready` promise so the CREATE statements run once per process.
 * The trap: a memoized promise that REJECTED is still memoized. Every later call
 * received the same rejection, so the first `remember` to run before Postgres was
 * accepting connections poisoned memory for the entire life of the process — and
 * went on reporting the original "connection refused" long after the connection
 * worked.
 *
 * That is not an exotic ordering. `docker compose up` starts Postgres and the
 * agent together, `eve dev` runs for hours, and a laptop that sleeps drops every
 * socket it had. Worse, the header of memory.ts records what the agent does with
 * a failing memory tool: it tells the user the thing was saved anyway. So the
 * observable bug is a permanent, silent lie about what was persisted, healed only
 * by restarting the agent.
 *
 * ── How this is provoked without Docker or a model key ────────────────────────
 *
 * A TCP proxy in front of the real Postgres, on one port for the whole probe:
 * first it destroys every connection (the failure), then it forwards them (the
 * recovery). The connection string handed to memory.ts points at the proxy, so
 * the product code is exercised unmodified — no stubs, no injected clock.
 *
 * `forget()` is the entry point used deliberately: it awaits `ensureSchema()`
 * exactly like `remember` and `recall` do, but it never embeds anything, so this
 * runs on a runner with no OPENAI_API_KEY and no Ollama.
 *
 * ── Why it does not disturb a real database ───────────────────────────────────
 *
 * `ensureSchema` writes to the fixed `evestack` schema; it cannot be redirected
 * at a scratch one the way probe 01 does. So this reads the existing vector width
 * first and configures itself to match — otherwise the width guard in memory.ts
 * would correctly refuse to run against a developer's 768-wide Ollama table and
 * this probe would fail for the wrong reason. Anything it creates, it drops;
 * anything that was already there, it leaves alone.
 */
import { createServer, connect } from "node:net";

function parseUrl(raw) {
  const parsed = URL.parse(raw ?? "");
  if (!parsed) return null;
  return { host: parsed.hostname, port: Number(parsed.port || 5432), parsed };
}

async function pgClient(connectionString) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/**
 * Forwards to `upstream`, or destroys the connection, depending on `mode.forward`.
 * One listening port for the probe's whole life, so the pool inside memory.ts
 * never has to be told the address changed.
 */
function proxy(upstream, mode) {
  const sockets = new Set();
  const pairs = new Set();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());

    if (!mode.forward) {
      // A destroyed socket surfaces to `pg` as ECONNRESET/EPIPE — a network
      // failure, which is what the "Postgres is not up yet" case really is.
      client.destroy();
      return;
    }

    const server_ = connect(upstream.port, upstream.host);
    server_.on("error", () => client.destroy());
    client.pipe(server_);
    server_.pipe(client);

    const pair = { client, server_ };
    pairs.add(pair);
    client.on("close", () => pairs.delete(pair));
  });

  /** Kills every ESTABLISHED connection: a Postgres restart, or a laptop resume,
   *  as seen by a client that already has a socket. */
  const dropEstablished = () => {
    for (const { client, server_ } of pairs) {
      client.destroy();
      server_.destroy();
    }
    pairs.clear();
  };

  return { server, sockets, dropEstablished };
}

export default {
  id: "memory/a-late-database-does-not-disable-memory-for-the-process",
  title: "long-term memory retries after a transient Postgres failure",
  needs: ["postgres"],
  why:
    "A memoized REJECTED promise in ensureSchema() meant the first memory call made before " +
    "Postgres was accepting connections disabled remember/recall/forget for the whole life of " +
    "the agent, still quoting the original connection error after the database was healthy. " +
    "Measured by stopping Postgres, calling remember, starting Postgres and calling it again.",

  async available() {
    const url = process.env.WORKFLOW_POSTGRES_URL;
    if (!url) return ["WORKFLOW_POSTGRES_URL is not set"];
    if (!parseUrl(url)) return ["WORKFLOW_POSTGRES_URL is not a URL"];
    try {
      const client = await pgClient(url);
      await client.end();
      return [];
    } catch (error) {
      return [`cannot reach Postgres: ${error.message}`];
    }
  },

  async run(t) {
    const realUrl = process.env.WORKFLOW_POSTGRES_URL;
    const upstream = parseUrl(realUrl);

    // What is already in the database decides how this configures itself, and
    // what it is allowed to clean up.
    const admin = await pgClient(realUrl);
    const { rows: existing } = await admin.query(
      `SELECT a.atttypmod AS dims
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'evestack' AND c.relname = 'memories' AND a.attname = 'embedding'`,
    );
    const preexistingWidth = existing[0]?.dims ?? null;
    const { rows: schemaRows } = await admin.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'evestack'",
    );
    const schemaPreexisted = schemaRows.length > 0;

    const mode = { forward: false };
    const { server, sockets, dropEstablished } = proxy(upstream, mode);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const proxyPort = server.address().port;

    const proxied = new URL(realUrl);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(proxyPort);

    const saved = {
      url: process.env.WORKFLOW_POSTGRES_URL,
      dims: process.env.EVESTACK_EMBED_DIMENSIONS,
    };
    process.env.WORKFLOW_POSTGRES_URL = proxied.toString();
    if (preexistingWidth && preexistingWidth > 0) {
      // Match what is already stored, or memory.ts will rightly refuse to touch
      // a table written by a different embedding model.
      process.env.EVESTACK_EMBED_DIMENSIONS = String(preexistingWidth);
      t.note(`evestack.memories already exists at ${preexistingWidth} dimensions; matching it`);
    }

    try {
      const { forget } = await import("../../../templates/default/lib/memory.ts");

      /* ---- 1. the database is not answering ---------------------------------- */
      let first = null;
      try {
        await forget(1);
      } catch (error) {
        first = error;
      }
      t.ok(first !== null, "a memory call fails while Postgres is unreachable");

      const message = first ? String(first.message ?? first) : "";
      // The second half of the same bug: this used to be the bare string
      // "AggregateError", because a refused connection to a name with two
      // addresses arrives as an AggregateError whose own message is EMPTY.
      t.ok(
        message.trim().length > 0 && message !== "AggregateError",
        "the failure says something, rather than the empty AggregateError message",
        { actual: message.slice(0, 160) },
      );
      t.ok(
        message.includes(`127.0.0.1:${proxyPort}`),
        "the failure names the host and port it could not reach",
        { actual: message.slice(0, 160) },
      );
      t.ok(
        !message.includes(proxied.password) || proxied.password === "",
        "the failure does not print the database password",
      );

      /* ---- 2. the database comes up ------------------------------------------ */
      mode.forward = true;
      t.note("proxy now forwarding; the connection string never changed");

      let recovered = null;
      let secondError = null;
      try {
        recovered = await forget(1);
      } catch (error) {
        secondError = error;
      }

      // THE assertion. Before the fix this threw the phase-1 error again, having
      // never touched the database.
      t.ok(
        secondError === null,
        "the next memory call succeeds once Postgres is reachable, with no restart",
        secondError ? { actual: String(secondError.message ?? secondError).slice(0, 200) } : {},
      );
      t.ok(
        typeof recovered === "boolean",
        "and it answers normally rather than half-succeeding",
        { actual: String(recovered) },
      );

      /* ---- 3. the database dies while a pooled client is idle -------------- */
      //
      // The severe one. pg-pool attaches its own handler to idle clients and
      // re-emits their socket errors on the pool; `emit("error")` with nothing
      // listening THROWS, so this was not a failed query but an
      // uncaughtException that took the whole agent down — every session and
      // every channel — because an optional memory tool had left a client idle.
      // Measured before the fix: exit code 9, "Connection terminated
      // unexpectedly".
      //
      // The temporary listener is what makes this reportable. Without it a
      // regression would kill the runner and take every other probe's result
      // with it; with it, the same regression is one red line here.
      let uncaught = null;
      const capture = (error) => {
        uncaught = error;
      };
      process.on("uncaughtException", capture);
      try {
        dropEstablished();
        await new Promise((resolve) => setTimeout(resolve, 400));
      } finally {
        process.off("uncaughtException", capture);
      }

      t.ok(
        uncaught === null,
        "a pooled client dying while idle does not raise an uncaughtException",
        uncaught ? { actual: `${uncaught.message} (would have killed the agent)` } : {},
      );

      let afterDrop = null;
      let afterDropError = null;
      try {
        afterDrop = await forget(1);
      } catch (error) {
        afterDropError = error;
      }
      t.ok(
        afterDropError === null && typeof afterDrop === "boolean",
        "and the pool hands out a working client on the next call",
        afterDropError
          ? { actual: String(afterDropError.message ?? afterDropError).slice(0, 160) }
          : {},
      );
    } finally {
      process.env.WORKFLOW_POSTGRES_URL = saved.url;
      if (saved.dims === undefined) delete process.env.EVESTACK_EMBED_DIMENSIONS;
      else process.env.EVESTACK_EMBED_DIMENSIONS = saved.dims;

      // Stop accepting new connections but leave established ones to die with
      // the process: destroying an idle pooled socket makes `pg`'s Pool emit an
      // 'error' event that nothing here can listen for, which would take the
      // whole runner down.
      server.close();
      for (const socket of sockets) socket.unref();

      // Only ever remove what this probe brought into existence.
      if (preexistingWidth === null) {
        await admin.query("DROP TABLE IF EXISTS evestack.memories").catch(() => {});
        if (!schemaPreexisted) {
          await admin.query("DROP SCHEMA IF EXISTS evestack CASCADE").catch(() => {});
        }
      }
      await admin.end().catch(() => {});
    }
  },
};
