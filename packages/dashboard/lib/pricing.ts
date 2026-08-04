/**
 * Token pricing, in USD per million tokens.
 *
 * We compute cost ourselves because nothing upstream can tell us. eve only
 * attaches `gen_ai.usage.cost` to spans when the call was served by Vercel's AI
 * Gateway; a self-hosted agent calls its provider directly, so that attribute
 * is simply absent. Token *counts* are always present, so price × tokens is the
 * only path to a cost figure.
 *
 * THESE NUMBERS GO STALE. Providers reprice, and a wrong table silently reports
 * wrong money. Override without touching this file:
 *
 *   EVESTACK_PRICING='{"openai/gpt-5-mini":{"input":0.25,"output":2,"cacheRead":0.025}}'
 *
 * Unknown models cost 0 and are surfaced in the UI as "unpriced" rather than
 * silently counted as free — an unpriced model must never look cheap.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cached input tokens; defaults to 10% of input when omitted. */
  cacheRead?: number;
}

const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "openai/gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "openai/gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "openai/gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
  "anthropic/claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3 },
  "anthropic/claude-opus-4.8": { input: 15, output: 75, cacheRead: 1.5 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5, cacheRead: 0.1 },
  // Local models are free by definition — that is the point of the Ollama path.
  "ollama/*": { input: 0, output: 0, cacheRead: 0 },
};

let overrides: Record<string, ModelPrice> | null = null;

function pricing(): Record<string, ModelPrice> {
  if (overrides === null) {
    overrides = {};
    const raw = process.env.EVESTACK_PRICING;
    if (raw) {
      try {
        overrides = JSON.parse(raw) as Record<string, ModelPrice>;
      } catch {
        console.warn("[evestack] EVESTACK_PRICING is not valid JSON; ignoring it.");
      }
    }
  }
  return { ...DEFAULT_PRICING, ...overrides };
}

export function findPrice(model: string | null): ModelPrice | null {
  if (!model) return null;
  const table = pricing();
  if (table[model]) return table[model];
  // Prefix wildcards, so "ollama/*" covers every local model.
  for (const [key, value] of Object.entries(table)) {
    if (key.endsWith("/*") && model.startsWith(key.slice(0, -1))) return value;
  }
  return null;
}

export function isPriced(model: string | null): boolean {
  return findPrice(model) !== null;
}

export function costUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
): number {
  const price = findPrice(model);
  if (!price) return 0;
  const cacheRate = price.cacheRead ?? price.input * 0.1;
  // Cached reads are billed at the cache rate, so they must not also be billed
  // at the full input rate. eve reports them inside the input total.
  const billableInput = Math.max(0, inputTokens - cacheReadTokens);
  return (
    (billableInput / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output +
    (cacheReadTokens / 1_000_000) * cacheRate
  );
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
