#!/usr/bin/env node
/**
 * Generates the evestack registry.
 *
 * eve consumes third-party registries in the shadcn registry-item format:
 *
 *   eve registry add @evestack=https://registry.evestack.dev/r/{name}.json
 *   eve add @evestack/memory
 *
 * That is why evestack ships as a registry and not a fork. Anyone already
 * running eve can take one piece — memory, the dashboard exporter, Postgres
 * durability — without migrating a project or tracking our releases. We stay
 * additive to eve instead of competing with it.
 *
 * Item content is inlined from the real files under templates/default, so the
 * registry can never drift from the code we actually test.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const template = join(root, "templates", "default");
const outDir = join(root, "registry", "r");

const read = (rel) => readFileSync(join(template, rel), "utf8");

const templateManifest = JSON.parse(read("package.json"));

/**
 * Pin every declared dependency to the range templates/default is tested with.
 *
 * A bare name in a registry item means "whatever npm calls latest today". That
 * is how `eve add @evestack/memory` ended up installing @ai-sdk/openai@4 next to
 * ai@7 in a project whose code has only ever been run against @ai-sdk/openai@2.
 * eve's own items pin (`@vercel/connect@0.4.2`); so do ours, from the one
 * manifest that is actually exercised.
 */
function pin(names, field = "dependencies") {
  return names.map((name) => {
    const range = templateManifest[field]?.[name];
    if (!range) {
      throw new Error(
        `registry: ${name} is listed as a ${field} of a registry item but is not in ` +
          "templates/default/package.json, so there is no tested version to pin to.",
      );
    }
    return `${name}@${range}`;
  });
}

/** @type {Array<{name:string,title:string,description:string,dependencies?:string[],devDependencies?:string[],files:Array<{source:string,target:string}>,docs?:string}>} */
const ITEMS = [
  {
    name: "memory",
    title: "Long-term memory (pgvector)",
    description:
      "Semantic long-term memory for an eve agent, stored in your own Postgres with pgvector. " +
      "No vector service, no extra container, no bill.",
    // `ai` is deliberately NOT listed. Every eve project already depends on it
    // AND carries an `overrides` entry for it, so declaring it here as a direct
    // dependency makes npm fail the whole install with
    // `EOVERRIDE: Override for ai@^7.0.51 conflicts with direct dependency`.
    // Pinning it was meant to prevent a version mismatch and instead made
    // `eve add @evestack/memory` impossible on a stock project.
    dependencies: pin(["pg", "@ai-sdk/openai"]),
    devDependencies: pin(["@types/pg"], "devDependencies"),
    files: [
      { source: "lib/memory.ts", target: "lib/memory.ts" },
      { source: "agent/tools/remember.ts", target: "agent/tools/remember.ts" },
      { source: "agent/tools/recall.ts", target: "agent/tools/recall.ts" },
      { source: "agent/tools/forget.ts", target: "agent/tools/forget.ts" },
    ],
    docs:
      "Requires a Postgres with the pgvector extension available (the pgvector/pgvector image " +
      "has it) and WORKFLOW_POSTGRES_URL set. The tools import lib/memory.ts by relative path, " +
      "so no `imports` or tsconfig `paths` entry is needed — but if your tsconfig `include` " +
      "lists only agent/, add \"lib/**/*.ts\" so the file is typechecked. Uses HNSW indexing, " +
      "which is correct on an empty table — IVFFlat is not. `forget` is gated with approval: always(), so deleting a memory always parks the turn for a human decision — it is also the worked example of human-in-the-loop.",
  },
  {
    name: "instrumentation",
    title: "evestack dashboard traces",
    description:
      "Export OpenTelemetry traces from an eve agent to a self-hosted evestack dashboard.",
    dependencies: pin(["@vercel/otel"]),
    files: [{ source: "agent/instrumentation.ts", target: "agent/instrumentation.ts" }],
    docs:
      "Set EVESTACK_DASHBOARD_URL to your dashboard's ingest endpoint " +
      "(http://localhost:4000/api/ingest/v1/traces). Leave it unset and no exporter is " +
      "registered. NOTE: the presence of agent/instrumentation.ts disables eve's zero-config " +
      "local trace spool, so `eve traces` stops working — delete the file to get it back.",
  },
  {
    name: "docker-sandbox",
    title: "Docker sandbox",
    description:
      "Run the agent's sandbox in a local Docker container instead of hosted Vercel Sandbox.",
    files: [{ source: "agent/sandbox/sandbox.ts", target: "agent/sandbox/sandbox.ts" }],
    docs:
      "Needs a reachable Docker daemon. eve keeps one long-lived container per durable session " +
      "and persists /workspace across turns with no idle timeout. The Docker backend honors " +
      "only allow-all and deny-all network policies; use microsandbox for domain allow-lists.",
  },
  {
    name: "basic-auth",
    title: "HTTP Basic route auth",
    description:
      "Replace vercelOidc()/placeholderAuth() with HTTP Basic, for agents that run off Vercel.",
    files: [{ source: "agent/channels/eve.ts", target: "agent/channels/eve.ts" }],
    docs:
      "Set EVESTACK_AUTH_USER and EVESTACK_AUTH_PASSWORD. Requires eve >= 0.30, where " +
      "localDev() grants on the deployment being a dev process rather than on the request " +
      "Host header — on 0.29.x that header was attacker-controlled and `127.evil.com` could " +
      "obtain an unauthenticated local-dev principal. In production nothing is granted " +
      "implicitly, so every request including loopback needs the Basic credentials; eve " +
      "fails closed and a 401 there is the intended behavior, not a bug.",
  },
];

mkdirSync(outDir, { recursive: true });

const index = [];
for (const item of ITEMS) {
  const json = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: item.name,
    type: "registry:item",
    title: item.title,
    description: item.description,
    ...(item.dependencies ? { dependencies: item.dependencies } : {}),
    ...(item.devDependencies ? { devDependencies: item.devDependencies } : {}),
    files: item.files.map((f) => ({
      path: `registry/${item.name}/${f.target}`,
      target: f.target,
      type: "registry:file",
      content: read(f.source),
    })),
    ...(item.docs ? { docs: item.docs } : {}),
  };
  writeFileSync(join(outDir, `${item.name}.json`), `${JSON.stringify(json, null, 2)}\n`);
  index.push({ name: item.name, title: item.title, description: item.description });
  console.log(`✓ r/${item.name}.json  (${item.files.length} file${item.files.length > 1 ? "s" : ""})`);
}

writeFileSync(
  join(outDir, "index.json"),
  `${JSON.stringify({ name: "evestack", homepage: "https://github.com/SammyTourani/evestack", items: index }, null, 2)}\n`,
);
console.log(`✓ r/index.json  (${index.length} items)`);
