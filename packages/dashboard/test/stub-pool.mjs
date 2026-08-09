/**
 * A Postgres that answers exactly what a test says, and records what it was
 * asked.
 *
 * ── Why this exists rather than a mocked `query` ─────────────────────────────
 *
 * lib/db.ts:160 builds its pool once and keeps it on `globalThis.__evestackPool`
 * — a global rather than a module variable because `next dev` re-evaluates
 * modules on every edit and would otherwise leak a pool per reload until
 * Postgres refuses new connections. `getPool()` returns that global if it is
 * already set, so setting it first is a supported way in, not a hole poked
 * through the module: every caller still goes through the real `query()`,
 * including its `DatabaseUnavailableError` wrapping (lib/db.ts:255-265), which
 * is the thing `isMissingTable` then reads a SQLSTATE out of.
 *
 * That matters for what the alerting code is FOR. `lib/alerts.ts` and
 * `deliveryStatus()` are almost entirely a set of judgements about answers the
 * database gave — empty versus absent, stale versus fresh, "nothing happened"
 * versus "I could not look" — and none of those distinctions is reachable from
 * a pure function. A stub of the pool is the smallest thing that makes them
 * reachable without a server.
 *
 * ── Recording, not just answering ────────────────────────────────────────────
 *
 * `calls` is the other half. Two of the defects these tests pin are about a
 * query that was made with the wrong number in it (a wedge threshold typed as a
 * literal while three other surfaces used STUCK_TURN_MS) or not made at all (a
 * fact table summed without refreshing it first, so the daily spend cap was
 * armed with stale money). Neither shows up in the returned value: the alert
 * looks calm in both cases. They only show up in what was asked, and in what
 * order.
 */

/**
 * Install a stub pool for the current process.
 *
 * `routes` is an ordered list of `[match, answer]`. `match` is a substring or a
 * RegExp tested against the SQL with its whitespace squashed to single spaces,
 * so a fragment can be written on one line even where the query spans ten.
 * `answer` is an array of rows, a function of the parameters returning rows, or
 * an Error to throw — throwing is how "the table does not exist" is expressed,
 * and `query()` preserves the message so the SQLSTATE survives.
 *
 * An unmatched query answers zero rows rather than throwing. That is the honest
 * default for this codebase: every reader here already handles an empty result
 * (`const [row] = await query(...)` then `row?.n ?? 0`), so a test only has to
 * describe the rows it cares about.
 */
export function installStubPool(routes = []) {
  const calls = [];
  const pool = {
    async query(text, params = []) {
      const sql = String(text);
      const squashed = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql, squashed, params });
      for (const [match, answer] of routes) {
        const hit = match instanceof RegExp ? match.test(squashed) : squashed.includes(match);
        if (!hit) continue;
        const rows = typeof answer === "function" ? answer(params) : answer;
        if (rows instanceof Error) throw rows;
        return { rows };
      }
      return { rows: [] };
    },
    // getPool() attaches an 'error' listener only to a pool it built itself, so
    // this is here for `closePool()` and for nothing else.
    async end() {},
  };
  globalThis.__evestackPool = pool;

  return {
    calls,
    /** Every call whose SQL contains `fragment`. */
    matching: (fragment) => calls.filter((call) => call.squashed.includes(fragment)),
    /** Position of the first call containing `fragment`, or -1. */
    firstIndexOf: (fragment) => calls.findIndex((call) => call.squashed.includes(fragment)),
  };
}

export function uninstallStubPool() {
  globalThis.__evestackPool = undefined;
}

/**
 * The error Postgres raises for a table that was never created.
 *
 * 42P01 is `undefined_table`, and lib/db.ts:300 matches on that code rather
 * than on the message text precisely so a locale change cannot turn "this
 * feature has never run" into "the database is unreadable". Building the
 * fixture from the same code keeps the test honest about what it is simulating.
 */
export function undefinedTable(relation) {
  return new Error(`42P01: relation "${relation}" does not exist`);
}
