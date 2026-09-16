import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";
/**
 * eve's own ChatGPT-subscription model, re-exported from a public entry point
 * (`eve/models/openai`). It returns an ordinary AI SDK `LanguageModel` that
 * routes through the Codex backend and authenticates from the ChatGPT session
 * in your OS secret store — so there is no key in this file and none in
 * .env.local. Sign in with `/model` inside `npm run dev`, or let the scaffolder
 * do it for you.
 */
import { chatgpt } from "eve/models/openai";
import { createOllama } from "ai-sdk-ollama";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

/**
 * Durable session storage.
 *
 * With WORKFLOW_POSTGRES_URL set (docker compose does this for you), sessions
 * live in your own Postgres and survive restarts, redeploys, and crashes.
 * Without it, eve falls back to its local on-disk world under
 * `.eve/.workflow-data` — fine for a quick `eve dev`, but mount that directory
 * if you care about the data.
 *
 * The @workflow/* line must match eve's, and "match" is finer-grained than the
 * version number suggests. eve needs the 5.0.0-beta line and rejects mismatched
 * protocol versions, so npm's `latest` (4.x) is out — but upstream also raises
 * the World *spec* version inside 5.0.0-beta.* with no semver bump, so the
 * `beta` dist-tag is out too. That is why package.json pins
 * `@workflow/world-postgres` to an EXACT version rather than a tag or a range.
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
const PROVIDERS = ["openai", "anthropic", "openrouter", "ollama", "compatible", "chatgpt"] as const;
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
  openrouter: "qwen/qwen3.8-27b",
  ollama: "qwen3:0.6b",
  // No default worth guessing: a custom endpoint's model id is that server's
  // own name for it, and "" is refused below with a message naming the variable.
  compatible: "",
  // eve's own default for this route, kept identical deliberately: the Codex
  // backend decides per account which model slugs it will serve, so a different
  // guess here is a guess about someone else's allow-list.
  chatgpt: "gpt-5.6-sol",
};

/**
 * Normalize a tool result whose output type the AI SDK cannot map, so an
 * unmappable type never reaches the provider as `output: undefined`.
 *
 * This exists because of a real outage, and the version numbers are the whole
 * story. Under @ai-sdk/openai **v2**, the `output.type = "execution-denied"`
 * that eve records when a human denies a gated tool call was outside the SDK's
 * tool-output contract: the mapping switch fell through and the next turn
 * replayed the denial as `{type: "function_call_output", call_id,
 * output: undefined}`. OpenAI answered "Missing required parameter:
 * 'input[N].output'" and the turn — and with it the whole durable session —
 * died `session.failed`. Approving was always fine; only denial poisoned the
 * transcript. Observed live on eve 0.30.2 and 0.30.6, request body captured.
 *
 * **v4 fixes that upstream, which is why `execution-denied` is listed below and
 * this middleware no longer touches a denial.** In @ai-sdk/provider 4.0.5 it is
 * a first-class member of `LanguageModelV4ToolResultOutput`, and
 * @ai-sdk/openai 4.0.30 has an explicit case in both converters
 * (`responses/convert-to-openai-responses-input.ts`,
 * `chat/convert-to-openai-chat-messages.ts`) that sends
 * `output.reason ?? "Tool call execution denied."`. Intercepting it now would
 * be a downgrade twice over: it replaces eve's prose reason with a JSON blob,
 * and it defeats the two v4 guards that skip a denial already carried by the
 * sibling `tool-approval-response` part — one matching on the output type, one
 * on `providerOptions.openai.approvalId`, which the rewrite below drops along
 * with the type. Those guards are inert today only because eve 0.30.8 builds
 * the denial as `{type: "execution-denied", reason}` with no providerOptions
 * (`eve/dist/src/harness/input-requests.js`); the day it stamps one, rewriting
 * the part would send the denial twice. `evals/deny-survives.eval.ts` — the
 * regression test for the original outage — passes on v4 with this middleware
 * bypassed.
 *
 * What the middleware still buys is the case it can catch: an output type new
 * to BOTH eve and this list. v4's `function_call_output` switch has no default
 * branch, so an unrecognized type still serializes to `output: undefined` and
 * still 400s exactly as v2 did — hence the normalization stays, and the set is
 * the full v4 union as of @ai-sdk/provider 4.0.5.
 */
const SDK_TOOL_OUTPUT_TYPES = new Set([
  "text",
  "json",
  "execution-denied",
  "error-text",
  "error-json",
  "content",
]);

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
/**
 * Where a custom endpoint lives. Shared by the `compatible` provider and, as a
 * fallback, by Ollama — OLLAMA_BASE_URL stays the name Ollama users expect.
 */
const baseUrl = process.env.EVESTACK_BASE_URL?.trim();

const baseModel =
  provider === "chatgpt"
    ? /**
       * Billed to a ChatGPT plan instead of an API key.
       *
       * Nothing is read from the environment here either — the session lives in
       * the OS secret store, put there by a browser sign-in. That is also the
       * limit of this provider: a container or a remote host has no keychain and
       * no browser, so a deployment needs one of the key-based providers above.
       * `npm run verify` says so rather than leaving it to a 401 at runtime.
       */
      modelObject(chatgpt(modelId))
    : provider === "ollama"
      ? createOllama({
          // Host only — no /api suffix. ai-sdk-ollama appends the path itself, so
          // including it yields "OllamaError: 404 page not found".
          baseURL: process.env.OLLAMA_BASE_URL?.trim() || baseUrl || "http://127.0.0.1:11434",
        })(modelId)
      : provider === "anthropic"
        ? anthropic(modelId)
        : provider === "openrouter"
          ? /**
             * One key, the whole catalogue. The model id carries its own vendor
             * prefix (`qwen/qwen3.8-27b`), which is why nothing here rewrites it.
             *
             * No baseURL: the provider package ships OpenRouter's own, and an
             * override here is how someone ends up pointing an OpenRouter key at
             * api.openai.com.
             */
            createOpenRouter({})(modelId)
          : provider === "compatible"
            ? /**
               * LM Studio, llama.cpp, vLLM, Groq, Together, an internal gateway —
               * anything speaking the OpenAI wire format.
               *
               * The URL is REQUIRED and not defaulted. Falling back to OpenAI's
               * would take a request meant for a machine on this desk and send it,
               * with whatever key was lying around, to a third party.
               */
              createOpenAICompatible({
                name: "compatible",
                baseURL: requireBaseUrl(),
                apiKey: process.env.EVESTACK_COMPATIBLE_API_KEY?.trim() || "not-needed",
              })(modelId)
            : openai(modelId);

/**
 * Narrow eve's `LanguageModel` to the object `wrapLanguageModel` accepts.
 *
 * `LanguageModel` in AI SDK v7 is `string | LanguageModelV2 | V3 | V4`: the
 * string arm exists so an agent can be authored as `model: "openai/gpt-5"` and
 * resolved by the runtime later. `chatgpt()` never returns it — it builds a
 * Codex-backed model object — but the declared type keeps the arm, and the
 * middleware below cannot wrap a string.
 *
 * Checked at runtime rather than cast away. A cast would compile today and, the
 * day eve changed what it hands back, fail inside the middleware with a message
 * about a property of undefined; this fails here, naming what arrived.
 */
function modelObject(model: LanguageModel) {
  if (typeof model === "string") {
    throw new Error(
      `Expected eve's chatgpt() to build a model, but it returned the id "${model}". ` +
        "Set EVESTACK_PROVIDER=openai (with OPENAI_API_KEY) until this is sorted out.",
    );
  }
  return model;
}

function requireBaseUrl(): string {
  if (baseUrl) return baseUrl;
  throw new Error(
    'EVESTACK_PROVIDER="compatible" needs EVESTACK_BASE_URL to say where that server is ' +
      "(for example http://127.0.0.1:1234/v1 for LM Studio). Set it in .env.local.",
  );
}

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
 * 32768 matches Qwen3's native window and is a safe floor for the small local
 * models the wizard offers. Override for a model with a different one — most
 * gateway models are far larger — since too high and compaction triggers too
 * late to save the turn, while too low just compacts more often than it need.
 */
const localContextWindow = readContextWindow();

/**
 * A bare `Number(...)` here accepted anything and produced `NaN` for a typo —
 * `32k`, `32,768`, a trailing comment — which eve then took verbatim as the
 * compaction budget. Nothing threw, nothing warned, and compaction silently
 * stopped working on the one provider that has no catalog to fall back on.
 * Every other setting in this file refuses a value it does not understand
 * rather than passing it on; this one now does too.
 */
function readContextWindow(): number {
  const raw = process.env.EVESTACK_CONTEXT_WINDOW?.trim();
  if (!raw) return 32768;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024) {
    throw new Error(
      `EVESTACK_CONTEXT_WINDOW="${raw}" is not a context window. It must be a whole number of ` +
        "tokens, at least 1024, and it must match what the model actually accepts — 32768 for " +
        "qwen3 and most small local models, far more for a gateway model. Leave it unset for 32768.",
    );
  }
  return value;
}

/**
 * Which providers eve cannot look up, and therefore must be told about.
 *
 * eve sizes compaction from the model's context window, which it reads out of
 * the AI Gateway catalog. Three of these six are not in that catalog and cannot
 * be: a local Ollama tag, an OpenRouter id carrying its own vendor prefix, and
 * a model id that only some server on your own network has a name for. Without
 * an explicit window the agent does not degrade, it refuses to compile at all.
 *
 * This was `provider === "ollama"` and had to widen the moment the wizard could
 * offer a gateway. Getting it wrong is not a subtle bug — it is the same
 * `does not have known AI Gateway context window metadata` error that made the
 * local path dead on arrival before `modelContextWindowTokens` was set for it.
 *
 * `chatgpt` is deliberately ABSENT, and that is the one entry here worth
 * checking before you add to the list. It looks like it belongs — the Codex
 * model ids are not gateway ids either — but eve special-cases ChatGPT routing
 * ahead of the catalog lookup and returns 200,000 tokens itself. Adding it
 * would not rescue anything; it would overwrite a right number with a wrong
 * one, and the symptom would be compaction firing six times too early with no
 * error anywhere.
 */
const UNCATALOGUED: readonly Provider[] = ["ollama", "openrouter", "compatible"];

export default defineAgent({
  model,
  ...(UNCATALOGUED.includes(provider) ? { modelContextWindowTokens: localContextWindow } : {}),
  ...(workflow ? { experimental: { workflow } } : {}),
});
