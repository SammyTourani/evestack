import { QueryValue, QueryValueRow } from "@/components/charts/query-value";
import { TimeSeriesChart } from "@/components/charts/time-series";
import { TopList } from "@/components/charts/top-list";
import { Card } from "@/components/ui/card";
import { Placeholder } from "@/components/ui/feedback";
import { CONTROL, FOCUS_RING } from "@/components/ui/style";
import { DatabaseError } from "@/app/db-error";
import { makeWindow, OVERVIEW_WINDOWS, ranked, stacked, windowLabel } from "@/app/overview";
import { query } from "@/lib/db";
import { effectiveRates } from "@/lib/facts";
import { freshFacts } from "@/lib/metrics";
import { findPrice, formatUsd } from "@/lib/pricing";

export const dynamic = "force-dynamic";

/**
 * Money — the thing Vercel's Agent Runs does not show at all.
 *
 * Agent Runs is read-only and displays no cost anywhere, which is a reasonable
 * choice for a product that bills you separately and an unreasonable gap for
 * one you host yourself. The bill is the reason most people look twice at an
 * agent.
 *
 * ── Cost is four numbers, not one ────────────────────────────────────────────
 *
 * Datadog's `ml_obs` model decomposes spend into non-cached input, output,
 * cache reads and cache writes, each at its own rate, and it is right to. A
 * cache WRITE usually costs MORE than plain input (anthropic/claude-opus-4.8:
 * 6.25/M against 5/M) while a cache READ costs a fraction of it. Folding all
 * four into one rate — which this codebase did until Wave 1 — under-reports
 * every cached session and hides the one lever that actually moves the bill.
 *
 * ── Cache savings, which nobody else puts on a page ─────────────────────────
 *
 * `cache_read_tokens × (input_rate − cache_read_rate)`: what those tokens WOULD
 * have cost at the uncached rate, minus what they did. It is the only number
 * here that tells you a decision was correct rather than what it cost, and the
 * survey behind this work did not find it in any commercial product.
 *
 * It is computed per model, never fleet-wide from an average rate, because the
 * rates differ by an order of magnitude between models and a blended rate would
 * produce a large confident number with no referent.
 *
 * ── Zero is a real answer here ───────────────────────────────────────────────
 *
 * `ollama/*` is priced at zero on purpose — local inference costs no API money
 * — so a local-only install has a genuinely empty cost surface. That is
 * correct, and it is also indistinguishable at a glance from a broken pricing
 * table, so the page says which one it is looking at instead of rendering a
 * grid of $0.00 and letting the reader guess.
 */

const DEFAULT_WINDOW = 24 * 7;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

interface Decomposition {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly pricedTurns: number;
  readonly unpricedTurns: number;
  readonly unpricedModels: string[];
  readonly freeTurns: number;
  /** Per-model, summed. See the header for why not fleet-wide. */
  readonly cacheSavings: number;
  readonly cacheReadTokens: number;
  /** How much of `cacheSavings` rests on the assumed 10% cache-read rate. */
  readonly estimatedSavings: number;
  /** The models that assumption was applied to, so the reader can judge it. */
  readonly estimatedModels: string[];
}

/**
 * The four cost classes and the savings, in one pass.
 *
 * Grouped by model rather than aggregated flat, because the savings figure
 * needs each model's own rates and because "which model is unpriced" is the
 * question that follows immediately from "some of this is unpriced".
 */
async function decompose(from: string, to: string): Promise<Decomposition> {
  /**
   * `freshFacts()` first, for the same reason `listTurnFacts` does it — and this
   * was the one fact-table reader in the app that skipped it.
   *
   * `refreshFacts()` is what applies `sql/facts.sql`, so on any database that
   * has never served a metrics query — which is every fresh install — this
   * SELECT was a 42P01. It runs inside `Promise.all` beside `stacked()` and
   * `ranked()`, which DO refresh, so the outcome depended on which promise won:
   * the page rendered "Can't reach the database" on a Postgres that was up and
   * correctly bootstrapped, and did it only on the first load, which is the
   * hardest kind of report to act on.
   *
   * The coalescing wrapper rather than bare `refreshFacts()`: all three queries
   * on this page want the same upsert, and metrics.ts is explicit that running
   * it three times concurrently is "wasted work at best and lock contention at
   * worst". Sharing the in-flight promise keeps it at one.
   */
  await freshFacts();
  const rows = await query<Record<string, string | boolean | null>>(
    `SELECT model,
            priced,
            count(*)::text                        AS turns,
            sum(cost_input_usd)::text             AS c_input,
            sum(cost_output_usd)::text            AS c_output,
            sum(cost_cache_read_usd)::text        AS c_cache_read,
            sum(cost_cache_write_usd)::text       AS c_cache_write,
            sum(cache_read_tokens)::text          AS cache_read_tokens
       FROM evestack.fact_turn
      WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
      GROUP BY model, priced`,
    [from, to],
  );

  const n = (v: unknown): number => {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  };

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let pricedTurns = 0;
  let unpricedTurns = 0;
  let freeTurns = 0;
  let cacheSavings = 0;
  let cacheReadTokens = 0;
  let estimatedSavings = 0;
  const unpricedModels: string[] = [];
  const estimatedModels: string[] = [];

  for (const r of rows) {
    const model = typeof r.model === "string" ? r.model : null;
    const turns = n(r.turns);
    // `priced` has THREE states, and `!== true` folded two of them together.
    // sql/facts.sql:155 says it outright: TRUE priced, FALSE the catalog has no
    // entry, NULL no model call happened at all. A turn that failed before it
    // reached a provider is NULL, and counting it as unpriced spend produced the
    // warning above this table — "N turns ran a model with no catalog price ()"
    // — with an empty parenthetical, because a turn that called no model has no
    // model name to list. The empty brackets were the visible tell.
    //
    // NULL belongs in neither total: nothing was spent, and nothing is unknown.
    // lib/alerts.ts:522-527 was corrected the same way; this is the surface a
    // user actually reads.
    if (r.priced === null || r.priced === undefined) continue;
    if (r.priced === false) {
      unpricedTurns += turns;
      if (model !== null && !unpricedModels.includes(model)) unpricedModels.push(model);
      continue;
    }
    pricedTurns += turns;
    input += n(r.c_input);
    output += n(r.c_output);
    cacheRead += n(r.c_cache_read);
    cacheWrite += n(r.c_cache_write);

    const reads = n(r.cache_read_tokens);
    cacheReadTokens += reads;

    const rates = effectiveRates(model);
    if (rates !== null) {
      // What these tokens would have cost uncached, minus what they did. Per
      // model: a blended rate across models is a number with no referent.
      const saved = reads * ((rates.input - rates.cacheRead) / 1_000_000);
      if (saved > 0) {
        cacheSavings += saved;
        // Which side of this subtraction is measured, and which is assumed.
        //
        // `rates.input` is always published. `rates.cacheRead` is not: pricing.ts
        // falls back to `price.input * 0.1` when a model states no cache-read
        // rate, and 66 of 206 catalog models state none. Among the 140 that do,
        // the ratio to input runs 0.008 to 0.52 — so 10% is a plurality, not a
        // rule, and for those models this dollar figure is an estimate wearing
        // the same typography as a measurement. Naming the models is what lets
        // a reader decide whether to trust the total.
        if (model !== null && findPrice(model)?.cacheRead === undefined) {
          if (!estimatedModels.includes(model)) estimatedModels.push(model);
          estimatedSavings += saved;
        }
      }
      // A model priced at zero end to end is genuinely free, not unpriced.
      if (rates.input === 0 && rates.output === 0) freeTurns += turns;
    }
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    pricedTurns,
    unpricedTurns,
    unpricedModels,
    freeTurns,
    cacheSavings,
    cacheReadTokens,
    estimatedSavings,
    estimatedModels,
  };
}

function Class({ label, value, total, note }: { label: string; value: number; total: number; note: string }) {
  const share = total > 0 ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-small text-text-dim">{label}</span>
        <span className="font-mono text-body text-text">{formatUsd(value)}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-sm bg-bg" aria-hidden="true">
        <div className="h-full rounded-sm bg-accent" style={{ width: `${share}%` }} />
      </div>
      <p className="mt-1 mb-0 text-micro text-text-faint">
        {total > 0 ? `${share.toFixed(1)}% of spend. ` : ""}
        {note}
      </p>
    </div>
  );
}

export default async function CostsPage(props: PageProps<"/costs">) {
  const params = await props.searchParams;
  const asked = Number(first(params.window));
  const hours = (OVERVIEW_WINDOWS as readonly number[]).includes(asked) ? asked : DEFAULT_WINDOW;
  const label = windowLabel(hours);
  const w = makeWindow(hours);

  let costs: Decomposition;
  let spendByModel: Awaited<ReturnType<typeof stacked>>;
  let topSessions: Awaited<ReturnType<typeof ranked>>;
  try {
    [costs, spendByModel, topSessions] = await Promise.all([
      decompose(w.from, w.to),
      stacked(w, "cost", "sum", "model"),
      ranked(w, { dimension: "session_id", measure: "cost", aggregation: "sum", limit: 10 }),
    ]);
  } catch (error) {
    return <DatabaseError error={error} />;
  }

  const everythingFree = costs.total === 0 && costs.pricedTurns > 0;

  return (
    <>
      <h1>Costs</h1>
      <p className="page-sub">
        What the last {label} cost, decomposed the way the providers actually bill it. Vercel&rsquo;s
        hosted Agent Runs shows no cost at all.
      </p>

      <nav aria-label="Time range" className="mb-4 flex flex-wrap gap-1.5">
        {OVERVIEW_WINDOWS.map((option) => (
          <a
            key={option}
            href={option === DEFAULT_WINDOW ? "/costs" : `/costs?window=${option}`}
            aria-current={option === hours ? "page" : undefined}
            className={`${CONTROL} aria-[current=page]:border-accent aria-[current=page]:text-text`}
          >
            {windowLabel(option)}
          </a>
        ))}
      </nav>

      {costs.unpricedTurns > 0 ? (
        <p className="mb-4 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-small text-warn">
          {costs.unpricedTurns.toLocaleString("en-US")} turn
          {costs.unpricedTurns === 1 ? "" : "s"} ran a model with no catalog price (
          {costs.unpricedModels.join(", ")}). Every figure on this page excludes them, so the real
          bill is higher by an unknown amount. That is not the same as their costing nothing.
        </p>
      ) : null}

      {everythingFree ? (
        <Placeholder
          tone="empty"
          title="Everything here ran for free"
          detail={`${costs.pricedTurns.toLocaleString("en-US")} turns in this window, all on models priced at zero — local inference through Ollama costs no API money, so this is a real $0.00 rather than a missing price. Tokens, throughput and latency are on the overview and are the numbers worth watching on an install like this.`}
        />
      ) : (
        <>
          <QueryValueRow>
            <QueryValue label="Total spend" unit="cost" value={costs.total} priced />
            <QueryValue label="Cache savings" unit="cost" value={costs.cacheSavings} priced better="higher" />
            <QueryValue label="Cached tokens read" unit="tokens" value={costs.cacheReadTokens} />
            <QueryValue
              label="Priced turns"
              unit="count"
              value={costs.pricedTurns}
              coverage={{
                rows: costs.pricedTurns,
                of: costs.pricedTurns + costs.unpricedTurns,
                noun: "turns",
              }}
            />
          </QueryValueRow>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="m-0 mb-1 text-section font-medium text-text">Where the money went</h2>
              <p className="mt-0 mb-4 text-small text-text-dim">
                Four rates, not one. A cache write usually costs more than plain input and a cache
                read a fraction of it, so a single blended rate under-reports every cached session.
              </p>
              <div className="flex flex-col gap-3">
                <Class
                  label="Input (not cached)"
                  value={costs.input}
                  total={costs.total}
                  note="Tokens the model read fresh."
                />
                <Class
                  label="Output"
                  value={costs.output}
                  total={costs.total}
                  note="Tokens the model wrote. Usually the most expensive rate."
                />
                <Class
                  label="Cache read"
                  value={costs.cacheRead}
                  total={costs.total}
                  note="Tokens served from a warm cache, at a fraction of the input rate."
                />
                <Class
                  label="Cache write"
                  value={costs.cacheWrite}
                  total={costs.total}
                  note="Putting tokens INTO the cache, which most providers charge a premium for."
                />
              </div>
              {costs.cacheSavings > 0 ? (
                <>
                  <p className="mt-4 mb-0 border-t border-border pt-3 text-small text-ok">
                    Caching saved {formatUsd(costs.cacheSavings)} in this window — what those{" "}
                    {costs.cacheReadTokens.toLocaleString("en-US")} cached tokens would have cost at
                    each model&rsquo;s own uncached input rate, minus what they did cost.
                  </p>
                  {costs.estimatedModels.length > 0 ? (
                    <p className="m-0 mt-1.5 text-small text-text-dim">
                      {formatUsd(costs.estimatedSavings)} of that is an estimate:{" "}
                      {costs.estimatedModels.length === 1
                        ? `${costs.estimatedModels[0]} publishes`
                        : `${costs.estimatedModels.slice(0, 3).join(", ")}${
                            costs.estimatedModels.length > 3
                              ? ` and ${costs.estimatedModels.length - 3} more`
                              : ""
                          } publish`}{" "}
                      no cache-read rate, so a tenth of the input rate is assumed. Set{" "}
                      <code>EVESTACK_PRICING</code> to replace the guess with the real number.
                    </p>
                  ) : null}
                </>
              ) : null}
            </Card>

            <TimeSeriesChart
              title="Spend over time"
              subtitle={`By model, ${label} window. A model with no catalog price contributes nothing to this chart.`}
              series={spendByModel.series}
              unit="cost"
              variant="stacked-area"
              xLabel="time"
              xPrecision={hours <= 24 ? "time" : "date"}
            />
          </div>

          <div className="mt-4">
            <TopList
              title="Most expensive sessions"
              subtitle="Ranked by spend. Each links to the turn-by-turn breakdown."
              rows={topSessions.map((r) => ({
                ...r,
                label: r.label === "(none)" ? r.label : `${r.label.slice(0, 22)}…`,
                href: r.label === "(none)" ? undefined : `/sessions/${r.label}`,
              }))}
              unit="cost"
              valueLabel="spend"
            />
          </div>
        </>
      )}

      <p className="mt-6 text-small text-text-dim">
        Prices come from the generated catalog in <code>lib/pricing.ts</code>. A model missing from
        it is reported as unpriced rather than free —{" "}
        <a className={`text-accent hover:underline ${FOCUS_RING}`} href="/monitors">
          a monitor fires
        </a>{" "}
        when any unpriced model runs.
      </p>
    </>
  );
}
