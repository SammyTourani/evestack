import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { createOllama } from "ai-sdk-ollama";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

/**
 * Durable session storage.
 *
 * With WORKFLOW_POSTGRES_URL set (docker compose does this for you), sessions
 * live in your own Postgres and survive restarts, redeploys, and crashes.
 * Without it, eve falls back to its local on-disk world under
 * `.eve/.workflow-data` — fine for a quick `eve dev`, but mount that directory
 * if you care about the data.
 *
 * The @workflow/* line must match eve's. eve 0.29.x needs 5.0.0-beta, and the
 * runtime rejects mismatched protocol versions — which is why package.json
 * pins `@workflow/world-postgres` to the `beta` tag and not `latest`.
 */
const workflow = process.env.WORKFLOW_POSTGRES_URL
  ? { world: "@workflow/world-postgres" }
  : undefined;

/**
 * Provider selection. Direct calls either way — no AI Gateway, no Vercel
 * account, no markup.
 *
 * A local model is ONLY used when you ask for it by name. An earlier version of
 * this file fell back to Ollama whenever no API key was present, which is
 * actively dangerous: loading a multi-gigabyte model alongside Docker, Postgres
 * and the dashboard exhausted an 8 GB machine and took the whole desktop down.
 * A missing key should be a clear error, never an implicit decision to consume
 * every spare gigabyte on the host.
 */
const PROVIDERS = ["openai", "anthropic", "ollama"] as const;
type Provider = (typeof PROVIDERS)[number];

const provider = readProvider();

/**
 * An unrecognised EVESTACK_PROVIDER is a hard error, not a silent fallback.
 *
 * `?? "openai"` on its own hid the interesting case: `EVESTACK_PROVIDER=ollamma`
 * — or `claude`, or `anthropic-api` — quietly handed the local model name to the
 * OpenAI provider, which then failed hundreds of lines later with a message
 * about AI Gateway context-window metadata that names neither the typo nor the
 * variable. Unset still means openai, because that is a choice; misspelled does
 * not, because that is a mistake.
 */
function readProvider(): Provider {
  const raw = process.env.EVESTACK_PROVIDER?.trim().toLowerCase();
  if (!raw) return "openai";
  if ((PROVIDERS as readonly string[]).includes(raw)) return raw as Provider;
  throw new Error(
    `EVESTACK_PROVIDER="${process.env.EVESTACK_PROVIDER}" is not a provider this agent knows. ` +
      `Use one of: ${PROVIDERS.join(", ")}.`,
  );
}

/**
 * Each provider's default model, used when EVESTACK_MODEL is unset.
 *
 * Keep these in step with @evestack/budget's `envModel()`, which reconstructs
 * the same `provider/model` string to price tokens — a default that only one of
 * the two knows about prices the run as "unpriced".
 */
const DEFAULT_MODEL: Record<Provider, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-5",
  ollama: "qwen3",
};

/**
 * Denying a tool approval must not kill the session — but without this
 * middleware it does, on every eve version we tested (0.30.2 and 0.30.6).
 *
 * When a human denies a gated tool call, eve records the result with
 * `output.type = "execution-denied"`. That type is not part of the AI SDK's
 * tool-output contract (`text` | `json` | `error-text` | `error-json` |
 * `content`), so when the next turn replays the transcript, @ai-sdk/openai's
 * mapping switch falls through and serializes the denied call as
 * `function_call_output` with `output: undefined`. OpenAI rejects the request —
 * "Missing required parameter: 'input[N].output'" — and the turn, and with it
 * the whole durable session, dies with `session.failed`. Approving is fine;
 * only denial poisons the transcript. Observed live, both versions, and the
 * offending request body was captured before writing this.
 *
 * The fix is at the one seam we own: the model passes through here before eve
 * ever calls it, so normalize any tool result the SDK's switch cannot map into
 * `error-json`. The model then sees the denial verbatim ("Tool execution was
 * denied") and answers accordingly — verified end to end. Harmless once eve
 * emits a conforming type; the normalization simply never fires.
 */
const SDK_TOOL_OUTPUT_TYPES = new Set(["text", "json", "error-text", "error-json", "content"]);

const surviveDeniedToolResults: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    for (const message of params.prompt) {
      if (message.role !== "tool") continue;
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const output = part.output as { type?: string } | undefined;
        if (output && SDK_TOOL_OUTPUT_TYPES.has(output.type ?? "")) continue;
        console.warn(
          `[evestack] normalized a tool result the AI SDK cannot serialize (type=${output?.type ?? "undefined"}, tool=${part.toolName}); without this the provider rejects the turn`,
        );
        part.output = { type: "error-json", value: (output ?? { error: "tool did not run" }) as never };
      }
    }
    return params;
  },
};

// Trimmed and length-checked rather than `?? DEFAULT`: `??` only falls back on
// null and undefined, so `EVESTACK_MODEL=` — a blank line in .env.local, or a
// CI job passing through an unset input — sets it to "" and survives, producing
// `openai("")` and a provider error that names no cause. An empty value plainly
// means "not configured".
const modelId = process.env.EVESTACK_MODEL?.trim() || DEFAULT_MODEL[provider];

/**
 * Direct provider calls, one branch each.
 *
 * Nothing here reads a key: every provider package picks its own up from the
 * environment (OPENAI_API_KEY, ANTHROPIC_API_KEY), so a missing key surfaces as
 * that provider's own authentication error rather than as an evestack one.
 */
const baseModel =
  provider === "ollama"
    ? createOllama({
        // Host only — no /api suffix. ai-sdk-ollama appends the path itself, so
        // including it yields "OllamaError: 404 page not found".
        baseURL: process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
      })(modelId)
    : provider === "anthropic"
      ? anthropic(modelId)
      : openai(modelId);

const model = wrapLanguageModel({ model: baseModel, middleware: surviveDeniedToolResults });

/**
 * Local models need their context window declared.
 *
 * eve sizes compaction from the model's context window, which it looks up in
 * the AI Gateway catalog. A local model is not in that catalog, so the lookup
 * fails and the agent refuses to compile at all:
 *
 *   Cannot compile agent compaction because the primary compaction trigger
 *   model "ollama/qwen3" does not have known AI Gateway context window metadata.
 *
 * `modelContextWindowTokens` is the documented escape hatch — eve takes the
 * value verbatim and skips the lookup. Without it the entire local-model path
 * is dead on arrival, which is why this is set rather than left to the reader.
 *
 * 32768 matches Qwen3's native window. Override for a model with a different
 * one; too high and compaction triggers too late to save the turn.
 */
const localContextWindow = Number(process.env.EVESTACK_CONTEXT_WINDOW?.trim() || 32768);

export default defineAgent({
  model,
  ...(provider === "ollama" ? { modelContextWindowTokens: localContextWindow } : {}),
  ...(workflow ? { experimental: { workflow } } : {}),
});
