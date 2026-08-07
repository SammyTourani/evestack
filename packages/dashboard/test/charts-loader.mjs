/**
 * The one thing the chart tests need that `test/ui-render.mjs` does not
 * already do: the `@/` alias.
 *
 * `ui-render.mjs` landed alongside these charts and owns the JSX transform —
 * a `load` hook over `ts.transpileModule`, plus the `.tsx` half of the
 * extensionless-import rule in `register-ts-resolve.mjs`. Importing it here
 * rather than writing a second copy keeps one TypeScript transform in this
 * package; a duplicate would drift, and the two would disagree about a
 * compiler option on the day it mattered.
 *
 * What is left is `@/…`, the alias `tsconfig.json` declares and the pages use.
 * `components/charts/lib/format.ts` reaches `@/lib/pricing` for `formatUsd` —
 * deliberately, so there is one definition of how a dollar is printed — and
 * `time-series.tsx` reaches `@/lib/time` for the axis formatter. Node's
 * resolver knows nothing about either. Rewriting those two imports as
 * `../../../lib/pricing` to avoid this file would trade a nine-line hook for a
 * convention break in application code.
 *
 * Hooks run most-recently-registered first, so this one sees a specifier
 * before `ui-render.mjs` does and hands everything it does not recognise
 * straight on.
 */

import { statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import "./ui-render.mjs";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = join(PACKAGE, specifier.slice(2));
      for (const suffix of SUFFIXES) {
        try {
          if (statSync(`${base}${suffix}`).isFile()) {
            return { url: pathToFileURL(`${base}${suffix}`).href, shortCircuit: true };
          }
        } catch {
          // Not that one; try the next suffix.
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
