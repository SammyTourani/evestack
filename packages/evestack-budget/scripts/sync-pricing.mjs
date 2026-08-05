// Copies the one price table into this package before it compiles.
//
// The table has to be reachable from two places that cannot import each other.
// This package is published to npm and must carry its own copy in the tarball.
// The dashboard is built by `docker compose` from an isolated context —
// `context: ./packages/dashboard`, then a plain `npm install` — so it cannot
// depend on a workspace package at all: `npm error EUNSUPPORTEDPROTOCOL
// Unsupported URL Type "workspace:"`. Measured, not assumed.
//
// So the dashboard keeps the editable copy and this build takes it. One file
// anyone edits, one table at runtime, and `docker compose up dashboard` still
// works. The generated file is gitignored so it can never be edited by mistake.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../dashboard/lib/pricing.ts");
const target = resolve(here, "../src/pricing.ts");

let contents;
try {
  contents = readFileSync(source, "utf8");
} catch {
  console.error(
    `[evestack:budget] cannot find the price table at ${source}.\n` +
      `It lives in packages/dashboard/lib/pricing.ts and is copied here at build time. ` +
      `Building this package outside the evestack monorepo is not supported.`,
  );
  process.exit(1);
}

const banner = `// GENERATED FILE — DO NOT EDIT.
//
// Copied from packages/dashboard/lib/pricing.ts by scripts/sync-pricing.mjs.
// Edit that file; this one is overwritten on every build and is gitignored.

`;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, banner + contents);
