import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

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

export default defineAgent({
  // Direct provider call — no AI Gateway, no Vercel account, no markup.
  // Swap to a local model for a genuinely $0 stack; see docs/models.md.
  model: openai(process.env.EVESTACK_MODEL ?? "gpt-5-mini"),
  ...(workflow ? { experimental: { workflow } } : {}),
});
