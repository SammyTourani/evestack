import {
  costUsd as catalogCostUsd,
  findPrice as catalogFindPrice,
  type ModelPrice,
} from "./pricing.js";

export { formatUsd } from "./pricing.js";
export type { ModelPrice } from "./pricing.js";

/**
 * The checked layer over the price table, and the only one this package uses.
 *
 * `pricing.ts` next to this file is NOT editable here. It is copied verbatim
 * from `packages/dashboard/lib/pricing.ts` by `scripts/sync-pricing.mjs` on
 * every build and is gitignored, precisely so nobody edits the copy — see the
 * header of that script for why the direction is forced. So a fix to how prices
 * are *validated* cannot go in the table; it has to go in front of it. This file
 * is that front.
 *
 * Two defects it exists to close, both measured against the built package on
 * 2026-09-15 before this module existed:
 *
 * 1. `EVESTACK_PRICING` was `JSON.parse`d and spread straight into the merged
 *    table with no shape check at all. With
 *
 *        EVESTACK_PRICING='{"acme/m1":{"input":0.25}}'
 *
 *    — an override where somebody forgot the output rate, which is the single
 *    most likely way to get this wrong — `costUsd("acme/m1", 1000, 1000)`
 *    returned **NaN**, `isPriced("acme/m1")` returned **true**, and `evaluate()`
 *    answered "not exceeded" because `NaN >= 2` is false. That NaN was then
 *    handed to `recordStep`, which adds it to `cost_usd` in both
 *    `evestack.budget_usage` rows, and `cost + NaN` is NaN forever: the session
 *    total AND the principal-day total for that user stayed poisoned for the
 *    rest of the day, with no cap able to trip, even after the environment
 *    variable was corrected and the process restarted. A typo in an override is
 *    an ordinary operator mistake; silently disabling the money guard for a
 *    whole day is not an ordinary consequence of one.
 *
 * 2. The lookup was `known[model]` over an object literal, so every property
 *    JavaScript hangs off `Object.prototype` answered as a price.
 *    `findPrice("constructor")` returned the `Object` constructor *function*,
 *    `isPriced("toString")` and `isPriced("__proto__")` were both true, and
 *    `costUsd("toString", …)` was NaN by the same route as (1) — an unpriced
 *    model that reports itself priced is the exact state the rest of this
 *    package is built to make impossible.
 *
 * The fix is deliberately two independent locks, because they fail differently:
 *
 *   - `sanitizeOverrides()` rewrites `EVESTACK_PRICING` down to the entries that
 *     pass, so a bad override is *rejected* rather than a good model being
 *     *lost*. That distinction is the whole reason this runs before the table is
 *     built instead of filtering afterwards: dropping a malformed
 *     `{"openai/gpt-5-mini":{"input":0.25}}` at lookup time would leave
 *     gpt-5-mini unpriced, when the right answer is obviously the catalog price
 *     the operator was trying to adjust.
 *   - `isModelPrice()` gates every value on its way out, so anything that
 *     reaches the table by a route this module does not control — a prototype
 *     property, a future edit to the dashboard's copy, a shape nobody thought
 *     of — still cannot become a number the caps are measured against.
 *
 * Neither lock invents a price. A rejected override falls back to the catalog,
 * and a model with no catalog entry stays honestly unpriced, which is what the
 * loud `no price for …` warning in `hook.ts` and
 * `evestack.budget_usage.unpriced_steps` already exist to surface.
 *
 * UPDATE, same day (dashboard-pricing-nan): `packages/dashboard/lib/pricing.ts`
 * — the real source this file's copy is taken from — now has the identical
 * validation applied DIRECTLY to it: an `isModelPrice` shape check in front of
 * `EVESTACK_PRICING`, and a null-prototype merged table so Object.prototype
 * members can never answer a lookup. Both defects described above are now
 * closed AT THE ROOT, not only in front of a copy of it. Concretely, that
 * means `sanitizeOverrides()` below now runs against an `EVESTACK_PRICING`
 * that `pricing.ts`'s own `build()` would ALSO have refused correctly on its
 * own, and `findPrice()` below now gates a `catalogFindPrice()` that cannot
 * return anything but a genuine `ModelPrice` or `null` in the first place —
 * verified by importing the post-fix, freshly-synced `pricing.ts` on its own
 * and reproducing every case in this file's own tests directly against it.
 *
 * This file stays anyway, and deliberately keeps doing the full validation
 * rather than shrinking to a re-export, for a reason specific to what this
 * package does with the number afterward. `hook.ts` feeds `costUsd`'s answer
 * straight into `recordStep`, which adds it into a Postgres row that every
 * later step of the day keeps adding to — see the "a total that is already
 * poisoned" tests in `test/pricing-and-caps.test.mjs`. A pricing defect that
 * reaches the DASHBOARD costs one wrong number on one screen; the identical
 * defect reaching THIS package costs a cap that silently stops tripping and a
 * stored total that is still wrong after the defect is fixed and the process
 * restarted. `pricing.ts` is edited for dashboard reasons, by people looking
 * at a rendered dollar figure, not at a spend cap several files removed from
 * what is on their screen — so a second, independent gate immediately in front
 * of the money-accounting path costs a handful of `typeof` checks per lookup
 * against a table already built, which is cheap insurance against a failure
 * whose entire signature is that it is expensive and durable once it happens.
 * So: not redundant in the "delete this file" sense — genuinely duplicate
 * validation logic, as of this update, kept on purpose. If a third place ever
 * needs the same check, factor it out then; two call sites sharing a few small
 * pure functions is not yet a reason to introduce a shared dependency between
 * a package that ships to npm and the dashboard app that does not.
 */

/** The variable both halves of evestack read, named once so the warnings match. */
const OVERRIDE_ENV = "EVESTACK_PRICING";

/**
 * One rate, as a number a cap can actually be measured against.
 *
 * Zero is valid and load-bearing: `ollama/*` and `chatgpt/*` are priced AT zero
 * because that is the truth about them, which is a different claim from being
 * unpriced. Negative is not — a negative rate makes an expensive step *lower* a
 * running total, which is the poisoning failure above wearing a different hat.
 */
function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Whether a value found in the table can be used as a price.
 *
 * `input` and `output` are both required, because `costUsd` multiplies by both
 * and `undefined * n` is NaN. `cacheRead` and `cacheWrite` are optional — the
 * catalog omits them for most models and `costUsd` documents its fallbacks for
 * exactly that case — but a *present* one must still be a rate, or the same
 * multiplication produces the same NaN one term further down.
 *
 * The `typeof value === "object"` test is what rejects `Object.prototype`'s
 * methods: `findPrice("constructor")` used to hand back a function, and a
 * function has no `input`, so it priced everything at NaN.
 */
function isModelPrice(value: unknown): value is ModelPrice {
  if (typeof value !== "object" || value === null) return false;
  const price = value as Partial<ModelPrice>;
  if (!isRate(price.input) || !isRate(price.output)) return false;
  if (price.cacheRead !== undefined && !isRate(price.cacheRead)) return false;
  if (price.cacheWrite !== undefined && !isRate(price.cacheWrite)) return false;
  return true;
}

/**
 * Why one override was thrown away, in the words the operator needs to fix it.
 *
 * Named per model rather than a single "some overrides were invalid" line: an
 * `EVESTACK_PRICING` with eight entries and one typo is the case that matters,
 * and a message that does not say which one costs the reader the same debugging
 * session the silent NaN used to.
 */
function describeRejection(price: unknown): string {
  if (typeof price !== "object" || price === null) {
    return `it is ${price === null ? "null" : typeof price}, not an object with input and output rates`;
  }
  const candidate = price as Partial<Record<keyof ModelPrice, unknown>>;
  const problems: string[] = [];
  for (const field of ["input", "output"] as const) {
    if (!Object.hasOwn(candidate, field)) problems.push(`"${field}" is missing`);
    else if (!isRate(candidate[field])) problems.push(`"${field}" is not a number >= 0`);
  }
  for (const field of ["cacheRead", "cacheWrite"] as const) {
    if (Object.hasOwn(candidate, field) && !isRate(candidate[field])) {
      problems.push(`"${field}" is not a number >= 0`);
    }
  }
  // `isModelPrice` rejects an object for one of the reasons collected above, so
  // this fallback should be unreachable. It is here because an empty string in
  // the middle of the warning would read as a truncated sentence rather than as
  // the bug it would be.
  return problems.length > 0 ? problems.join(" and ") : "its shape is not a price";
}

/**
 * Rewrites `EVESTACK_PRICING` to the entries that can actually price a token.
 *
 * Mutating the environment is a real side effect and it is the point, not a
 * shortcut. The table in `pricing.ts` reads this variable itself, lazily, the
 * first time anything calls `findPrice` — and that file cannot be changed from
 * this package. Rewriting the variable before that first lookup is therefore the
 * only way to make a bad override fall back to the catalog price instead of
 * shadowing it with a number that is not one. It also leaves every other reader
 * in the process — the `/api/budget` route, anything an operator wires up —
 * agreeing with the caps about what the overrides are, which is the disagreement
 * the single shared price table exists to prevent.
 *
 * Runs at module load, which is before any lookup can happen: `pricing.ts`
 * builds its merged table on first *use*, and nothing in this package calls
 * `findPrice` at import time. The variable is left untouched when every entry
 * passes, so the ordinary case observes no mutation at all.
 *
 * `Object.hasOwn` and a null-prototype accumulator are both deliberate. A key
 * called `constructor` or `__proto__` survives `JSON.parse` as an ordinary own
 * property, and a plain `{}` accumulator would answer for those names whether or
 * not they were written.
 */
function sanitizeOverrides(): void {
  const raw = process.env[OVERRIDE_ENV];
  if (raw === undefined || raw.trim() === "") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deleting rather than leaving it for `pricing.ts` to complain about, so
    // this prints one warning naming the variable instead of two describing the
    // same mistake in different words.
    delete process.env[OVERRIDE_ENV];
    console.warn(
      `[evestack:budget] ${OVERRIDE_ENV} is not valid JSON; ignoring every override in it and ` +
        `using the built-in price table. It wants an object like ` +
        `'{"openai/gpt-5-mini":{"input":0.25,"output":2}}'.`,
    );
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    delete process.env[OVERRIDE_ENV];
    console.warn(
      `[evestack:budget] ${OVERRIDE_ENV} must be a JSON object keyed by model id; ignoring it.`,
    );
    return;
  }

  const kept: Record<string, ModelPrice> = Object.create(null) as Record<string, ModelPrice>;
  let rejected = 0;

  for (const [model, price] of Object.entries(parsed)) {
    if (!isModelPrice(price)) {
      rejected += 1;
      console.warn(
        `[evestack:budget] ${OVERRIDE_ENV} override for "${model}" was rejected because ` +
          `${describeRejection(price)}. A half-written override used to price every step as NaN, ` +
          `which disables the cap and poisons the stored totals, so the whole entry is dropped ` +
          `and "${model}" is priced from the built-in table instead.`,
      );
      continue;
    }
    // Rebuilt field by field rather than passed through, so nothing else the
    // JSON happened to carry reaches the merged table.
    kept[model] = {
      input: price.input,
      output: price.output,
      ...(price.cacheRead === undefined ? {} : { cacheRead: price.cacheRead }),
      ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite }),
    };
  }

  if (rejected === 0) return;

  const survivors = Object.keys(kept);
  if (survivors.length === 0) delete process.env[OVERRIDE_ENV];
  else process.env[OVERRIDE_ENV] = JSON.stringify(kept);
}

sanitizeOverrides();

/**
 * The catalog lookup, with anything that is not a usable price answered as
 * "unpriced" rather than as a price.
 *
 * This is the second lock described at the top of the file. `sanitizeOverrides`
 * has already removed the realistic way a bad shape gets in; this covers the
 * ones it cannot reach — `Object.prototype` members, and any future edit to the
 * dashboard's copy of the table that lands a malformed literal in it. Returning
 * null here routes the model into the unpriced path, which warns loudly and is
 * counted in `evestack.budget_usage.unpriced_steps`, instead of into arithmetic
 * that produces NaN in silence.
 */
export function findPrice(model: string | null): ModelPrice | null {
  const price = catalogFindPrice(model);
  return isModelPrice(price) ? price : null;
}

export function isPriced(model: string | null): boolean {
  return findPrice(model) !== null;
}

/**
 * Models already reported by `costUsd` below, so the log stays readable.
 *
 * Same reasoning as `warnedUnpriced` in `hook.ts` and `warnedImpossibleSplit` in
 * the table: whatever makes one step unmeasurable makes every step of that
 * session unmeasurable, and one line per model call would bury it.
 */
const warnedUnusableCost = new Set<string>();

/**
 * What a step cost, or zero when the model is not priced — never NaN.
 *
 * The delegation looks redundant now that `findPrice` is gated, and it is not
 * quite: `catalogCostUsd` does its own `findPrice` against the raw table, so the
 * guard has to be applied here as well or a prototype hit walks straight past
 * this function's own check. Asking the checked `findPrice` first and only then
 * delegating keeps one implementation of the rate arithmetic — which carries a
 * long-argued set of fallbacks for unstated cache rates that must not be
 * duplicated — while making its answer impossible to poison.
 *
 * The final `Number.isFinite` is for the token counts, which arrive from eve's
 * usage object and are not ours to trust either. A non-finite count with a
 * perfectly good price is the same NaN by another road, and this is the last
 * place before `hook.ts` hands the number to the store.
 */
export function costUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  if (findPrice(model) === null) return 0;
  const cost = catalogCostUsd(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
  if (Number.isFinite(cost) && cost >= 0) return cost;
  const key = String(model);
  if (!warnedUnusableCost.has(key)) {
    warnedUnusableCost.add(key);
    console.warn(
      `[evestack:budget] priced "${key}" at ${String(cost)} from ` +
        `input=${String(inputTokens)} output=${String(outputTokens)} ` +
        `cacheRead=${String(cacheReadTokens)} cacheWrite=${String(cacheWriteTokens)}; ` +
        `counting this step as $0.00 rather than writing a number that cannot be added up. ` +
        `Warned once per model.`,
    );
  }
  return 0;
}
