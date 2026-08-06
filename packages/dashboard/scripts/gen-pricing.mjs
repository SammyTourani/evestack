#!/usr/bin/env node
/**
 * Regenerates the price table inside lib/pricing.ts from Vercel's public model
 * catalog.
 *
 * The table used to be seven models typed by hand under a comment admitting they
 * go stale. They had. Measured against the catalog on 2026-08-05, three of the
 * six non-wildcard entries were wrong, and all three were wrong in the direction
 * that overstates spend:
 *
 *   anthropic/claude-opus-4.8   table 15 / 75   catalog 5 / 25   (3.0x)
 *   anthropic/claude-sonnet-5   table  3 / 15   catalog 2 / 10   (1.5x)
 *   anthropic/claude-haiku-4.5  table  1 /  5   catalog 1 /  5   (agreed)
 *
 * A dashboard whose headline number is dollars cannot be off by 3x on the model
 * the default template picks for Anthropic, and no amount of "THESE NUMBERS GO
 * STALE" in a comment fixes that — the comment was already there.
 *
 * Why this catalog and not a scraped pricing page: eve already reads it. When a
 * local model has no entry, eve fails compaction with "model does not have known
 * AI Gateway context window metadata" (see templates/default/agent/agent.ts),
 * which means the catalog is the same source eve itself consults for model
 * facts. Pricing from it makes the dashboard agree with the framework rather
 * than with a third party's summary of the framework.
 *
 * Verified 2026-08-05: HTTP 200, no Authorization header, 317 models, 304 with a
 * non-empty `pricing` object.
 *
 * Usage:
 *   node packages/dashboard/scripts/gen-pricing.mjs           fetch and rewrite
 *   node packages/dashboard/scripts/gen-pricing.mjs --check   offline; see below
 *
 * WHAT --check DOES NOT DO: it does not re-fetch and compare. Freshness is not a
 * property a pull request can be responsible for. Providers reprice on their own
 * schedule, so a network check would turn "OpenAI cut a price this morning" into
 * a red build on an unrelated PR, and it would be indistinguishable from the one
 * thing CI genuinely needs to catch — somebody hand-editing a generated table and
 * committing a number no provider ever charged. So --check is offline and proves
 * exactly that: the markers are intact and the region still hashes to what the
 * generator wrote. Staleness is answered by `git log -1 packages/dashboard/lib/pricing.ts`,
 * which is a real answer; a self-reported "generated on" date in the file would
 * not be, because it would rewrite itself on every run and make the hash useless.
 *
 * No clock, no locale, no network in the output. Same rule as
 * scripts/gen-compatibility.mjs, for the same reason.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLE = join(HERE, "..", "lib", "pricing.ts");

const CATALOG = "https://ai-gateway.vercel.sh/v1/models";

const START = "// GENERATED:pricing start";
const END = "// GENERATED:pricing end";

/**
 * Refuse to publish a table this much smaller than the one measured on
 * 2026-08-05 (206 priceable language models). The failure this guards is not
 * hypothetical shrinkage but an upstream incident answering 200 with a partial
 * catalog: every model that fell out would stop being priced, and because
 * unpriced renders as "—" rather than "$0.00" the dashboard would go quietly
 * blank on cost instead of visibly wrong. Loud is better. Deliberately a floor,
 * not an equality — the catalog gained and lost models all through 2026 and a
 * generator that has to be edited every time is a generator nobody runs.
 */
const MIN_MODELS = 100;

const checkOnly = process.argv.slice(2).includes("--check");

function die(message) {
  process.stderr.write(`gen-pricing: ${message}\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* units                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * "0.00000005" -> 0.05, in USD per million tokens.
 *
 * Deliberately a decimal shift over the string, not `Number(raw) * 1e6`. The
 * catalog states prices per token, this table states them per million, and the
 * float multiply is visibly lossy at exactly the magnitudes involved:
 * `Number("0.00000005") * 1e6` is 0.049999999999999996 and
 * `Number("0.000001") * 1e6` is 0.9999999999999999. Those would land in a
 * checked-in file as literal 17-digit noise, and every regeneration would
 * re-round them differently enough to churn the diff.
 *
 * Returns null for anything that is not a plain non-negative decimal. All 648
 * scalar price strings in the catalog matched that shape on 2026-08-05 — no
 * exponents, no signs — so a non-match means the format changed and the caller
 * should drop the model rather than guess at it.
 */
function perMillionUsd(raw) {
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const padded = frac.padEnd(6, "0");
  const shiftedWhole = `${whole}${padded.slice(0, 6)}`.replace(/^0+(?=\d)/, "");
  const shiftedFrac = padded.slice(6).replace(/0+$/, "");
  const value = Number(shiftedFrac ? `${shiftedWhole}.${shiftedFrac}` : shiftedWhole);
  return Number.isFinite(value) ? value : null;
}

/* -------------------------------------------------------------------------- */
/* the fetch                                                                   */
/* -------------------------------------------------------------------------- */

async function fetchCatalog() {
  let response;
  try {
    response = await fetch(CATALOG, {
      headers: { accept: "application/json" },
      // A hung socket must not hang a developer's terminal forever. The catalog
      // is ~300 KB and answered in well under a second when measured.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    die(
      `could not reach ${CATALOG}: ${error.message}\n` +
        "  Nothing was written. The committed table in lib/pricing.ts is still there and still valid;\n" +
        "  this script only ever replaces it with a table it actually fetched.",
    );
  }
  if (!response.ok) die(`${CATALOG} answered ${response.status} ${response.statusText}. Nothing was written.`);

  let body;
  try {
    body = await response.json();
  } catch {
    die(`${CATALOG} did not answer JSON. Nothing was written.`);
  }
  if (!Array.isArray(body?.data)) {
    die("the catalog response has no `data` array. Did the endpoint's shape change? Nothing was written.");
  }
  return body.data;
}

/* -------------------------------------------------------------------------- */
/* selection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Keep only the models this cost model can bill honestly.
 *
 * `costUsd` charges input tokens, output tokens and cached reads. A model whose
 * real invoice has terms outside those three is not something we can price, and
 * pricing it anyway is worse than declining to: `isPriced()` drives the
 * "unpriced" badge, so a wrong inclusion replaces a visible "—" with a confident
 * dollar figure that is quietly too low. Two rules follow.
 *
 * First, `type === "language"`. The catalog also prices image, video, speech,
 * realtime, transcription, embedding and reranking models. Ten of those carry a
 * flat input/output pair and would sail through a naive filter — openai/gpt-image-1
 * among them — but their bills also carry `image_dimension_quality_pricing` or
 * `realtime_session_duration_cost_per_second`, per-image and per-second terms
 * with no token count anywhere in eve's span attributes to multiply against.
 *
 * Second, a flat `input` and `output` must both be present. Three language models
 * ship `pricing: {}` — perplexity/sonar, sonar-pro, sonar-reasoning-pro — because
 * Perplexity bills per request, not per token. They stay unpriced, which is the
 * true statement about them.
 *
 * Two terms are knowingly ignored, because ignoring them cannot understate a
 * token bill: `web_search` (73 models) is a per-search fee, and `service_tiers`
 * (34) prices priority/flex lanes the base rate already covers for standard
 * traffic.
 *
 * One is ignored and can understate: `input_tiers`/`output_tiers` (35 models)
 * raise the rate past a context threshold. The flat `input` equals `input_tiers[0].cost`
 * for all 35, so what lands here is the base tier. Worst case measured is
 * alibaba/qwen3.7-flash at 6.67x the base rate above its threshold. That is the
 * deliberate trade: dropping the 35 would take Gemini and Qwen out of the table
 * entirely and report nothing for the common short-context call, which is the
 * call these agents actually make.
 */
function selectPrices(models) {
  const table = new Map();

  for (const model of models) {
    if (model?.type !== "language") continue;
    const id = typeof model.id === "string" ? model.id : null;
    if (!id) continue;
    // The table is keyed by the same string eve puts in `$eve.model`, and
    // findPrice() reads a trailing "/*" as a wildcard. A literal id containing
    // one would be indistinguishable from the ollama rule. None exist today.
    if (id.includes("*")) continue;

    const p = model.pricing;
    if (!p) continue;

    const input = p.input == null ? null : perMillionUsd(p.input);
    const output = p.output == null ? null : perMillionUsd(p.output);
    if (input === null || output === null) continue;

    const entry = { input, output };

    // Only when the catalog states it. Omitting the key is meaningful: it hands
    // the model to costUsd's `input * 0.1` default rather than freezing a guess
    // into the table as though it were reported. 140 of 206 state a cache read
    // price; across those the ratio to input runs 0.008 to 0.52, and 59 sit at
    // exactly 0.10 — so the default is the plurality, not a rule, and it is only
    // reached by models the catalog says nothing about.
    if (p.input_cache_read != null) {
      const cacheRead = perMillionUsd(p.input_cache_read);
      if (cacheRead !== null) entry.cacheRead = cacheRead;
    }

    // Captured but not yet billed by costUsd, which takes no cache-write token
    // count. It is recorded because the counter already exists on the other
    // side: lib/queries.ts reads `$eve.cache_write_tokens` into `cacheWriteTokens`
    // and the session page renders it. Those tokens are currently billed at the
    // plain input rate, and 33 language models say that is too cheap —
    // anthropic/claude-opus-4.8 charges 6.25/M to write a cache entry against
    // 5/M for ordinary input. Wiring it up needs a signature change in costUsd,
    // which is a behaviour change and not this script's to make; having the
    // number here means that change is a change to one function, not a
    // regeneration.
    if (p.input_cache_write != null) {
      const cacheWrite = perMillionUsd(p.input_cache_write);
      if (cacheWrite !== null) entry.cacheWrite = cacheWrite;
    }

    // REGIONAL PRICING IS DROPPED, and it is not a rounding decision.
    //
    // 42 language models carry a `regional` sub-object, always keyed `eu` and/or
    // `us`. The tempting read is that the top-level price is one region's and the
    // sub-object holds the others. It is not: for 29 of the 42 the top-level rate
    // is strictly cheaper than every region listed under it. anthropic/claude-opus-4.8
    // reads 5/M at the top and 5.5/M under both `eu` and `us` — there is no region
    // where you are billed the headline number. No region undercuts it anywhere in
    // the catalog, and the largest premium measured is 36.4% (zai/glm-5.2).
    //
    // We take the top-level number anyway, because the alternative is worse.
    // Choosing a region needs to know which region served the call, and nothing
    // knows: eve's span attributes carry `$eve.model` and token counts, and no
    // region, endpoint or account field to infer one from. Baking in `us` would
    // be a guess that reads like a fact and would overstate every EU-served run.
    //
    // So this table is a floor, and callers who route through a region should say
    // so themselves — EVESTACK_PRICING exists for exactly this and overrides per
    // model. The error is bounded and one-directional: never more than 36.4% low
    // on 42 of 206 models, never high. That beats an unbounded wrong guess, and it
    // beats the status quo, which was 200% high on Opus.
    table.set(id, entry);
  }

  return new Map([...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/* -------------------------------------------------------------------------- */
/* rendering                                                                   */
/* -------------------------------------------------------------------------- */

function renderEntries(table) {
  const lines = [];
  for (const [id, price] of table) {
    const parts = [`input: ${price.input}`, `output: ${price.output}`];
    if (price.cacheRead !== undefined) parts.push(`cacheRead: ${price.cacheRead}`);
    if (price.cacheWrite !== undefined) parts.push(`cacheWrite: ${price.cacheWrite}`);
    lines.push(`  ${JSON.stringify(id)}: { ${parts.join(", ")} },`);
  }
  return lines.join("\n");
}

/** The hash --check verifies. Over the entry lines only, so reflowing the banner is not a diff. */
function fingerprint(entries) {
  return createHash("sha256").update(entries).digest("hex").slice(0, 16);
}

function renderRegion(table) {
  const entries = renderEntries(table);
  return [
    "// Generated by scripts/gen-pricing.mjs from https://ai-gateway.vercel.sh/v1/models.",
    "// Do not edit inside these markers; run the script instead. USD per 1M tokens.",
    `// ${table.size} models. sha256:${fingerprint(entries)}`,
    "const GATEWAY_PRICING: Record<string, ModelPrice> = {",
    entries,
    "};",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* splice                                                                      */
/* -------------------------------------------------------------------------- */

function regionBounds(source) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1) die(`lib/pricing.ts is missing the start marker:\n  ${START}`);
  if (end === -1) die(`lib/pricing.ts is missing the end marker:\n  ${END}`);
  if (end < start) die(`${END} appears before ${START} in lib/pricing.ts.`);
  // A duplicated marker makes the splice rewrite the first region and abandon a
  // second stale one below it, which --check would then happily bless.
  if (source.indexOf(START) !== source.lastIndexOf(START)) die(`lib/pricing.ts contains more than one ${START}`);
  if (source.indexOf(END) !== source.lastIndexOf(END)) die(`lib/pricing.ts contains more than one ${END}`);
  return { start: start + START.length, end };
}

function splice(source, region) {
  const { start, end } = regionBounds(source);
  return `${source.slice(0, start)}\n${region}\n${source.slice(end)}`;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

let source;
try {
  source = readFileSync(TABLE, "utf8");
} catch {
  die(`cannot read ${TABLE}. This script rewrites a region of an existing file; it does not create one.`);
}

if (checkOnly) {
  const { start, end } = regionBounds(source);
  const region = source.slice(start, end);

  const claimed = /^\/\/ (\d+) models\. sha256:([0-9a-f]{16})$/m.exec(region);
  if (!claimed) {
    die(
      "the generated region in lib/pricing.ts has no `// N models. sha256:…` line.\n" +
        "  Run `node packages/dashboard/scripts/gen-pricing.mjs` and commit the result.",
    );
  }

  const body = /const GATEWAY_PRICING: Record<string, ModelPrice> = \{\n([\s\S]*?)\n\};/.exec(region);
  if (!body) die("the generated region in lib/pricing.ts does not contain a GATEWAY_PRICING literal.");

  const entries = body[1];
  const actualHash = fingerprint(entries);
  const actualCount = entries.split("\n").filter((line) => line.trim().length > 0).length;

  if (actualHash !== claimed[2]) {
    die(
      "the price table in lib/pricing.ts was edited by hand.\n" +
        `  It claims sha256:${claimed[2]} and hashes to sha256:${actualHash}.\n` +
        "  Prices belong upstream: fix them at the provider, or override at runtime with\n" +
        "  EVESTACK_PRICING, or edit FALLBACK_PRICING outside the markers. To restore the\n" +
        "  table, run `node packages/dashboard/scripts/gen-pricing.mjs`.",
    );
  }
  if (actualCount !== Number(claimed[1])) {
    die(`the region claims ${claimed[1]} models and contains ${actualCount}. Regenerate it.`);
  }

  process.stdout.write(`lib/pricing.ts: ${actualCount} generated models, sha256:${actualHash}, unedited.\n`);
  process.exit(0);
}

const models = await fetchCatalog();
const table = selectPrices(models);

if (table.size < MIN_MODELS) {
  die(
    `the catalog yielded only ${table.size} priceable language models, below the floor of ${MIN_MODELS}.\n` +
      `  ${models.length} models were returned in total. That looks like an upstream incident rather than a\n` +
      "  repricing, so nothing was written and the committed table stands.",
  );
}

const next = splice(source, renderRegion(table));
if (next === source) {
  process.stdout.write(`lib/pricing.ts is up to date (${table.size} models from ${models.length} in the catalog).\n`);
  process.exit(0);
}

writeFileSync(TABLE, next);
process.stdout.write(
  `lib/pricing.ts updated: ${table.size} priceable language models out of ${models.length} in the catalog.\n`,
);
