#!/usr/bin/env node
/**
 * `npm run db:bootstrap` — create the workflow schema, or say why it cannot.
 *
 * This is a wrapper around `@workflow/world-postgres`'s own setup script, and
 * it exists for one reason: this is the SECOND command a new user runs, and
 * when Postgres is not reachable the upstream script answers with twenty lines
 * of
 *
 *     ❌ Failed to setup database: DrizzleQueryError: Failed query:
 *        CREATE SCHEMA IF NOT EXISTS "workflow_drizzle"
 *        at NodePgPreparedQuery.queryWithCache (…/drizzle-orm/pg-core/session.js:41:15)
 *        …
 *        cause: AggregateError [ECONNREFUSED]:
 *
 * which names a library the reader has never heard of, a schema they did not
 * ask for, and not one thing they can do about it. Observed for real: the
 * container had been created but its port was never published, so
 * `docker compose ps` said "healthy" and this said "DrizzleQueryError".
 *
 * So: check the connection first and, if it fails, say which host and port,
 * what is probably wrong, and the command that fixes it. Then hand over to
 * upstream unchanged — the migrations are theirs and this must not fork them.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { C, connectPostgres, dockerRunning, envValue, readEnvFile, redact } from "./checks.mjs";

const require = createRequire(import.meta.url);

function fail(lines) {
  console.error(`\n${C.red}${C.bold}  Cannot bootstrap the database.${C.reset}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error();
  process.exit(1);
}

const fileEnv = readEnvFile();
if (!fileEnv) {
  fail([
    "There is no .env.local in this directory.",
    "",
    `  ${C.bold}Run this from your project directory${C.reset} — the one create-evestack made.`,
  ]);
}

const url = envValue(fileEnv, "WORKFLOW_POSTGRES_URL");
if (!url) {
  fail([
    "WORKFLOW_POSTGRES_URL is not set in .env.local.",
    "",
    "  Without it the agent falls back to an on-disk world under .eve/ and this",
    "  step has nothing to create. Put the line back, or copy it from .env.example.",
  ]);
}

let target;
try {
  const parsed = new URL(url);
  target = { host: parsed.hostname, port: parsed.port || "5432" };
} catch {
  fail([`WORKFLOW_POSTGRES_URL is not a URL: ${redact(url)}`]);
}

const probe = await connectPostgres(url, 5000);
if (!probe.ok) {
  const hints = [];
  if (!dockerRunning()) {
    hints.push(
      `${C.bold}Docker is not running.${C.reset} Start Docker Desktop, then:`,
      "",
      "    docker compose up -d postgres",
    );
  } else {
    hints.push(
      "Postgres is not answering. Start it:",
      "",
      "    docker compose up -d postgres",
      "",
      `${C.dim}If it is already "Up", the container may exist without its port published —${C.reset}`,
      `${C.dim}a bind that failed once is not retried by a plain restart. Force it:${C.reset}`,
      "",
      "    docker compose up -d --force-recreate postgres",
    );
  }
  fail([
    `Nothing is accepting connections on ${C.bold}${target.host}:${target.port}${C.reset}.`,
    `${C.dim}${redact(url)}${C.reset}`,
    `${C.dim}${probe.error}${C.reset}`,
    "",
    ...hints,
  ]);
}
await probe.client.end().catch(() => {});

// Upstream, unchanged. Resolved through the package's own entry point rather
// than a hardcoded `node_modules/...` path so a hoisted, pnpm-linked or
// otherwise relocated install still finds it.
let setup;
try {
  setup = require.resolve("@workflow/world-postgres/bin/setup.js");
} catch {
  fail([
    "@workflow/world-postgres is not installed.",
    "",
    `    ${C.bold}npm install${C.reset}`,
  ]);
}

console.log(`${C.dim}  Postgres is up at ${target.host}:${target.port}. Creating the schema…${C.reset}`);
const result = spawnSync(process.execPath, ["--env-file-if-exists=.env.local", setup], {
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`
${C.green}${C.bold}  Schema created.${C.reset}

  ${C.bold}Next:${C.reset}
    npm run dev                                ${C.dim}# the agent${C.reset}
    docker compose --profile dashboard up -d   ${C.dim}# the dashboard${C.reset}
    npm run verify                             ${C.dim}# check the whole stack${C.reset}
`);
