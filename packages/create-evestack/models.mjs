/**
 * What you can point evestack at, and what each choice actually costs.
 *
 * The wizard used to offer three things: OpenAI, Anthropic, and a 5.2 GB local
 * model. That list is wrong in both directions. It is too short at the top —
 * there was no way to reach an open catalogue without editing `.env.local` by
 * hand — and at the bottom it offered exactly one local option, the largest
 * one, on the assumption that "local" means "big". It does not: the smallest
 * model here that can still drive this agent is 366 MB.
 *
 * ── the one property that decides everything ────────────────────────────────
 *
 * evestack is an agent, and an agent is tool calls. Memory (`remember` /
 * `recall`), approvals, schedules, the Docker sandbox and all 1,000+ Composio
 * toolkits are reached the same way: the model emits a tool call. A model that
 * cannot emit one is not a slower evestack, it is an evestack that answers in
 * prose and does nothing — and it fails silently, because a model with no tools
 * will cheerfully claim it saved your note.
 *
 * So `tools` is not a footnote in this table, it is the first thing rendered.
 *
 * ── where these numbers come from ───────────────────────────────────────────
 *
 * Sizes and tool support were both read from Ollama's own registry: the
 * manifest gives the summed layer size, and the `template` layer either
 * references `.Tools` or does not. Cross-checked against a local
 * `/api/show` — which reports `capabilities` for a pulled model — and the two
 * agreed, including on Gemma 3, whose template has no `.Tools` at any size.
 *
 * They are still only a default. `probeLocalModel` below asks the running
 * Ollama about the model actually chosen, because a re-quantised or renamed tag
 * is a thing people have, and a table in a scaffolder cannot know about it.
 */
import { totalmem } from "node:os";

import { c } from "./ui.mjs";

/* -------------------------------------------------------------------------- */
/* hosted and gateway                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything here writes EVESTACK_PROVIDER, and agent.ts branches on it. A
 * model name written without its provider goes to whichever provider was
 * already selected — the failure create.mjs documents as `compaction trigger
 * model "openai/qwen3" does not have known AI Gateway context window metadata`.
 */
export const REMOTE = [
  {
    id: "openai",
    label: "OpenAI",
    model: "gpt-5-mini",
    keyVar: "OPENAI_API_KEY",
    keyHint: "https://platform.openai.com/api-keys",
    keyShape: /^sk-/,
    note: "best tool-calling per dollar",
    badge: "hosted",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    model: "claude-sonnet-5",
    keyVar: "ANTHROPIC_API_KEY",
    keyHint: "https://console.anthropic.com/settings/keys",
    keyShape: /^sk-ant-/,
    note: "strongest tool-calling",
    badge: "hosted",
  },
  {
    /**
     * The open door, and the answer to "why can I only pick three things".
     *
     * One key reaches every major lab plus the open-weight catalogue — Llama,
     * Qwen, DeepSeek, Mistral, Kimi — behind a single OpenAI-shaped API, so
     * changing model later is editing one line of .env.local rather than
     * installing a provider package. It also carries `:free` variants, which
     * makes it the only option here that costs nothing AND needs no RAM.
     *
     * @openrouter/ai-sdk-provider declares `ai: ^7.0.0`, which is the range the
     * template is already on — checked before adding it, because a provider
     * built for AI SDK v6 would install clean and fail at the first call.
     */
    id: "openrouter",
    label: "OpenRouter",
    // Open weights, tool-capable, and cheap — $0.21/M in against gpt-5-mini's
    // $0.25 — which is the combination that makes this the interesting default
    // rather than a second way to buy the same hosted model. Kept short on
    // purpose: the finish diagram's line has a pinned 80-column budget, and the
    // model id is the only variable-width part of it.
    model: "qwen/qwen3.8-27b",
    keyVar: "OPENROUTER_API_KEY",
    keyHint: "https://openrouter.ai/keys",
    keyShape: /^sk-or-/,
    note: "one key, 400+ models, some free",
    badge: "gateway",
  },
  {
    /**
     * Anything that speaks the OpenAI wire format and is not one of the above:
     * LM Studio, llama.cpp's server, vLLM, Groq, Together, Fireworks, an
     * internal gateway. One branch in agent.ts covers all of them, so this is
     * the difference between "evestack supports six providers" and "evestack
     * supports whatever you already run".
     */
    id: "compatible",
    label: "OpenAI-compatible",
    model: "",
    keyVar: "EVESTACK_COMPATIBLE_API_KEY",
    keyHint: null,
    keyShape: null,
    note: "LM Studio, vLLM, Groq, Together, your own gateway",
    badge: "custom",
    needsBaseUrl: true,
  },
];

/* -------------------------------------------------------------------------- */
/* local                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ordered by download size, smallest first, because size is the constraint
 * people actually hit and the old wizard buried it in a warning after the
 * choice was already made.
 *
 * `mb` is the download, in the decimal megabytes Ollama itself reports. Resident
 * cost is larger — weights plus KV cache — which is what `fits()` accounts for.
 */
export const LOCAL = [
  {
    id: "ollama", label: "Granite 4 350m", model: "granite4:350m-h",
    mb: 366, tools: true, ctx: 32768,
    note: "smallest that still drives an agent",
  },
  {
    id: "ollama", label: "Qwen3 0.6b", model: "qwen3:0.6b",
    mb: 523, tools: true, ctx: 32768,
    note: "tiny, reliable at tool calls",
  },
  {
    id: "ollama", label: "Llama 3.2 1b", model: "llama3.2:1b",
    mb: 1320, tools: true, ctx: 32768,
    note: "good default if 0.6b struggles",
  },
  {
    id: "ollama", label: "Qwen3 1.7b", model: "qwen3:1.7b",
    mb: 1360, tools: true, ctx: 32768,
    note: "better reasoning, still small",
  },
  {
    id: "ollama", label: "Llama 3.2 3b", model: "llama3.2:3b",
    mb: 2020, tools: true, ctx: 32768,
    note: "strong tool use for its size",
  },
  {
    id: "ollama", label: "Qwen3 4b", model: "qwen3:4b",
    mb: 2500, tools: true, ctx: 32768,
    note: "the sweet spot on 16 GB",
  },
  {
    id: "ollama", label: "Qwen3 8b", model: "qwen3",
    mb: 5200, tools: true, ctx: 32768,
    note: "what this wizard used to pick",
  },
  /**
   * Gemma is here because it is genuinely excellent for its size and people ask
   * for it by name. It is listed last, and marked, because it cannot call
   * tools — verified from its Ollama template, which references no `.Tools` at
   * any size, and confirmed against a pulled `gemma3:1b` reporting
   * `capabilities: ["completion"]`.
   *
   * Listing it without the mark would be the worst of the three options: the
   * scaffold succeeds, the agent starts, and every tool silently does nothing.
   */
  {
    id: "ollama", label: "Gemma 3 270m", model: "gemma3:270m",
    mb: 292, tools: false, ctx: 32768,
    note: "runs on a phone",
  },
  {
    id: "ollama", label: "Gemma 3 1b", model: "gemma3:1b",
    mb: 815, tools: false, ctx: 32768,
    note: "excellent for its size",
  },
];

/** Every local entry needs this second, separate pull for remember/recall. */
export const EMBED_MODEL = "nomic-embed-text";

/* -------------------------------------------------------------------------- */
/* does it fit                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Headroom for everything that is NOT the model: Docker's VM, Postgres, the
 * dashboard container, the agent, and the desktop the user still wants to use.
 * The old warning said "4 GB free RAM on top of Docker, Postgres and the
 * dashboard"; this is that number, stated once, where it can be computed with.
 */
const OVERHEAD_GB = 4;

/** Weights are not the whole cost — KV cache and runtime add roughly a fifth. */
const RESIDENT_FACTOR = 1.2;

export function totalGb() {
  return totalmem() / 1024 ** 3;
}

/**
 * Will this model leave the machine usable?
 *
 * This exists because of a real failure on a real laptop: an 8 GB machine ran
 * the 5.2 GB default beside Docker, Postgres, the dashboard and the agent, and
 * the desktop did not survive it. The wizard printed a warning about that AFTER
 * the choice was made, in a step whose question had already moved on. Sorting
 * and marking the list beforehand is the version that changes the outcome.
 */
export function fits(model, ram = totalGb()) {
  return (model.mb / 1000) * RESIDENT_FACTOR + OVERHEAD_GB <= ram;
}

/** The largest model this machine should be offered by default. */
export function recommendedLocal(ram = totalGb()) {
  const usable = LOCAL.filter((m) => m.tools && fits(m, ram));
  return usable.at(-1) ?? LOCAL[0];
}

/**
 * "366 MB" / "5.2 GB" — byte-for-byte what `ollama pull` reports.
 *
 * Decimal, not binary: `ollama list` and the library pages both print decimal,
 * and a wizard that says 349 MB about a download the next screen calls 366 MB
 * is a wizard the reader stops trusting on the number that matters most here.
 */
export function humanSize(mb) {
  return mb < 1000 ? `${mb} MB` : `${(mb / 1000).toFixed(1)} GB`;
}

/**
 * The badge beside a local model: what it can do, then what it costs.
 *
 * Capability first and size second, because a model that cannot call tools is
 * disqualified for most people regardless of how small it is, and the eye
 * reaches the left column first.
 */
export function localBadge(model, ram = totalGb()) {
  const size = humanSize(model.mb);
  // Size stays in the badge in every case. An earlier draft replaced it with
  // "chat only" for Gemma, which answered the capability question by deleting
  // the answer to the size question — and size is the reason Gemma is on the
  // list at all.
  if (!model.tools) return { text: `${size}  no tools`, color: c.yellow };
  if (!fits(model, ram)) return { text: `${size}  tight`, color: c.yellow };
  return { text: size, color: c.dim };
}

/* -------------------------------------------------------------------------- */
/* what the running Ollama actually says                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ask Ollama about one model, rather than trusting the table above.
 *
 * `/api/show` returns a `capabilities` array for any pulled model — `tools`,
 * `thinking`, `vision`, `completion`. That is the only authority on whether a
 * tag someone typed or re-quantised can drive this agent, and it is the same
 * evidence the table was built from.
 *
 * Never throws: a probe is an improvement to the message, not a precondition
 * for scaffolding, and Ollama being absent is already handled by the caller.
 */
export async function probeLocalModel(baseUrl, model) {
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return { known: false, tools: null };
    const body = await response.json();
    const capabilities = Array.isArray(body?.capabilities) ? body.capabilities : [];
    return { known: true, tools: capabilities.includes("tools"), capabilities };
  } catch {
    return { known: false, tools: null };
  }
}

/**
 * What the reader loses by choosing a model with no tool calling.
 *
 * Named features rather than "some things will not work", because the whole
 * reason this warning exists is that the failure is invisible at runtime: the
 * model answers, and the answer is a description of work it did not do.
 */
export const NO_TOOLS_COST = [
  "remember / recall — long-term memory",
  "every Composio toolkit (Gmail, Slack, Notion, Linear…)",
  "the Docker sandbox, approvals and schedules",
];
