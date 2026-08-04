import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { createOllama } from "ai-sdk-ollama";

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
const provider = process.env.EVESTACK_PROVIDER ?? "openai";

const model =
  provider === "ollama"
    ? createOllama({
        // Host only — no /api suffix. ai-sdk-ollama appends the path itself, so
        // including it yields "OllamaError: 404 page not found".
        baseURL: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
      })(process.env.EVESTACK_MODEL ?? "qwen3")
    : openai(process.env.EVESTACK_MODEL ?? "gpt-5-mini");

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
const localContextWindow = Number(process.env.EVESTACK_CONTEXT_WINDOW ?? 32768);

export default defineAgent({
  model,
  ...(provider === "ollama" ? { modelContextWindowTokens: localContextWindow } : {}),
  ...(workflow ? { experimental: { workflow } } : {}),
});
