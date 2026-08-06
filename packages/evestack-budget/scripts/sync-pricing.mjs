// Copies the one price table into this package before it compiles.
//
// The table has to be reachable from two places that cannot import each other.
// This package is published to npm and must carry its own copy in the tarball,
// and a published tarball cannot resolve a `workspace:` specifier at all.
//
// It used to say the dashboard could not depend on a workspace package either,
// because `docker compose` built it from `context: ./packages/dashboard` and
// then ran `npm install`, which dies on `EUNSUPPORTEDPROTOCOL Unsupported URL
// Type "workspace:"`. That was measured and it was true — but it was a
// description of a broken Dockerfile, not a constraint. The image never built
// for anyone. It now builds from the repository root with pnpm, so the
// dashboard resolves `workspace:*` like every other package here; see the
// header of packages/dashboard/Dockerfile.
//
// The copy stays, for the npm half. The dashboard keeps the editable copy and
// this build takes it: one file anyone edits, one table at runtime. The
// generated file is gitignored so it can never be edited by mistake.

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
