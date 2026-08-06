/**
 * Lets `node --test` import the dashboard's own modules.
 *
 * Node 25 strips TypeScript types from a `.ts` file without help, so
 * lib/auth.ts, lib/pricing.ts and lib/promote-eval.ts import as they are —
 * measured: `node -e "import('./lib/auth.ts')"` resolves all 18 exports.
 * lib/traces.ts does not, and the reason is resolution rather than syntax: it
 * says `import { query } from "./db"`, which tsconfig's `moduleResolution:
 * "bundler"` accepts and Node's ESM resolver refuses —
 * `ERR_MODULE_NOT_FOUND: Cannot find module …/lib/db`.
 *
 * The fix that is NOT taken here is editing lib/traces.ts to say "./db.ts".
 * That file is application code with a build (`next build`) and other authors;
 * a test runner is not a reason to rewrite it. So the extension is added at
 * resolve time, for extensionless RELATIVE specifiers only — a bare specifier
 * still goes to node_modules, so an accidental shadowing of a real package is
 * impossible.
 *
 * `registerHooks` rather than `register`: it runs in-thread, so the hook can
 * live in this one file instead of a loader module plus a registration module,
 * and it needs no worker for what is a two-line path rewrite.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

/**
 * tsconfig maps the package root to an alias, and every route handler uses it
 * to reach lib/. Node does not know that mapping, so importing a handler fails
 * with "Cannot find package" before a single line of it runs -- which is why
 * the control routes had no tests and only their helpers were ever covered.
 * Resolved here rather than by rewriting app imports, for the same reason the
 * extension is: the runner adapts to the app, not the other way round.
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = join(PACKAGE_ROOT, specifier.slice(2));
      for (const candidate of [base + ".ts", base + ".tsx", join(base, "index.ts"), base]) {
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    // A specifier with any extension, or a bare/absolute one, is left alone.
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/i.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      // No `format` is returned on purpose: Node then derives it from the .ts
      // extension exactly as it does for a specifier the user wrote out in
      // full, so this hook has no opinion about type stripping and nothing to
      // keep in sync with it.
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
