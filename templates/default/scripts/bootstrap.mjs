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
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { C, connectPostgres, dockerRunning, envValue, readEnvFile, redact } from "./checks.mjs";

const require = createRequire(import.meta.url);

function fail(lines) {
  console.error(`\n${C.red}${C.bold}  Cannot bootstrap the database.${C.reset}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error();
  process.exit(1);
}

// `.env.local` is one way to configure this, not the only one, and an absent
// file is not an error. CI runs this step inside templates/default with
// WORKFLOW_POSTGRES_URL exported and no .env.local at all; so does every
// container deployment. Requiring the file broke exactly that, which is a
// worse failure than the stack trace this script was written to replace —
// the reader is told to go somewhere else when they were already correct.
const fileEnv = readEnvFile();

const url = envValue(fileEnv, "WORKFLOW_POSTGRES_URL");
if (!url) {
  fail([
    "WORKFLOW_POSTGRES_URL is not set.",
    "",
    "  Without it the agent falls back to an on-disk world under .eve/ and this",
    "  step has nothing to create. Set it in the environment, or put the line",
    `  back in .env.local — ${fileEnv ? "the file is here but has no such key" : "there is no .env.local in this directory"}.`,
    "",
    "  .env.example has the line to copy.",
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

/**
 * Where upstream's setup script actually is.
 *
 * NOT `require.resolve("@workflow/world-postgres/bin/setup.js")`: the package's
 * `exports` map lists `.`, `./schema`, `./cli` and `./migrations/*.sql` and
 * nothing else, so asking for the bin path by name throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED even on a perfectly good install. That is why
 * this used to be a hardcoded `node_modules/...` string — which in turn broke
 * on any layout that hoists.
 *
 * So: resolve an exported subpath to find where the package really lives, walk
 * up to its root, and take the path out of its own `bin` field. The literal
 * path stays as a first guess because it is right in the common case and costs
 * one `existsSync`.
 */
function findSetupScript() {
  const flat = join(process.cwd(), "node_modules", "@workflow", "world-postgres", "bin", "setup.js");
  if (existsSync(flat)) return flat;

  try {
    let dir = dirname(require.resolve("@workflow/world-postgres/cli"));
    for (let up = 0; up < 6; up += 1) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name === "@workflow/world-postgres") {
          const rel = pkg.bin?.bootstrap ?? "./bin/setup.js";
          const full = join(dir, rel);
          if (existsSync(full)) return full;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Not installed, or an unexpected layout. Falls through to the message.
  }
  return null;
}

const setup = findSetupScript();
if (!setup) {
  fail([
    "@workflow/world-postgres is installed nowhere this script can find.",
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
