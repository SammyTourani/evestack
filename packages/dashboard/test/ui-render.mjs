/**
 * Renders a `.tsx` primitive to HTML inside `node --test`.
 *
 * Why this exists. `test/register-ts-resolve.mjs` gets Node as far as `.ts`,
 * because Node strips types by itself. It cannot do JSX — `import('./x.tsx')`
 * fails with `Unknown file extension ".tsx"` and there is no flag that changes
 * that. Without a transform, every claim about a component would have to be
 * checked by reading it, and "renders correctly empty, with one item, and in
 * its error state" is exactly the kind of claim that is true when written and
 * false two commits later.
 *
 * What it costs. One `load` hook and `ts.transpileModule`, from the
 * `typescript` devDependency this package already declares and already runs in
 * `pnpm typecheck`. No new dependency, no bundler, no jsdom: components render
 * through `react-dom/server`, which is the same renderer Next uses for these
 * pages, and the assertions are made against real HTML.
 *
 * What it does not cover, stated so nobody reads more into a passing test than
 * is there. `renderToStaticMarkup` runs no effects and has no DOM, so it proves
 * the *server* pass only: markup, roles, labels, and every branch that is
 * decided during render. A Radix popover's open panel, a focus ring, and a
 * keyboard handler are not reachable from here. Those are asserted where they
 * can be — the props that produce them, and the composition that wires them —
 * and the rest belongs to a browser.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import ts from "typescript";

registerHooks({
  // The sibling of the `.ts` rule in register-ts-resolve.mjs, for the same
  // reason: components import each other as `./feedback`, which is what
  // tsconfig's `moduleResolution: "bundler"` wants and what Node refuses.
  // Writing `./feedback.tsx` instead is not an option — tsc rejects a `.tsx`
  // specifier unless `allowImportingTsExtensions` is on.
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/i.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.tsx`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const path = fileURLToPath(url);
    const { outputText, diagnostics } = ts.transpileModule(readFileSync(path, "utf8"), {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        // The same `jsx` setting as tsconfig.json, so the automatic runtime is
        // used and no `import React` is needed in a component.
        jsx: ts.JsxEmit.ReactJSX,
        isolatedModules: true,
      },
    });
    // transpileModule never type-checks, but it does report syntax errors, and
    // a syntax error here would otherwise surface as a confusing runtime one.
    if (diagnostics?.length) {
      throw new SyntaxError(
        `${path}: ${diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ")}`,
      );
    }
    return { format: "module", shortCircuit: true, source: outputText };
  },
});

const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");

/** `React.createElement`, for building children without JSX in a `.mjs` test. */
export const h = createElement;

/**
 * Static HTML for a component and its props.
 *
 * Takes the component rather than an element because calling `Component(props)`
 * directly — the obvious thing to write in a plain `.mjs` file — dispatches no
 * hooks and fails with "Invalid hook call" on anything stateful. Going through
 * `createElement` makes that mistake unavailable.
 *
 * Static rather than `renderToString`: the assertions are about content and
 * roles, and hydration markers only make the strings harder to read.
 */
export function render(Component, props, ...children) {
  return renderToStaticMarkup(createElement(Component, props, ...children));
}

/** Substring assertion helper that prints the markup when it fails. */
export function contains(markup, needle, message) {
  if (!markup.includes(needle)) {
    throw new Error(`${message ?? "expected markup to contain"}: ${JSON.stringify(needle)}\n\n${markup}`);
  }
}

/** The inverse, for "this must never appear" rules like `$0.00`. */
export function omits(markup, needle, message) {
  if (markup.includes(needle)) {
    throw new Error(`${message ?? "expected markup NOT to contain"}: ${JSON.stringify(needle)}\n\n${markup}`);
  }
}
