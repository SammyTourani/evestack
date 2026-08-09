/**
 * `evestack create` and `evestack attach`, delegated to `create-evestack`.
 *
 * There is one scaffolder in this repo and it lives in
 * packages/create-evestack. This file is the seam that lets the `evestack`
 * binary offer it under the names the owner wants without a second copy of it
 * existing anywhere.
 *
 * Why the dependency points this way — `evestack` -> `create-evestack`, and not
 * the reverse:
 *
 *   - `create-evestack` is dependency-free on purpose, and already carries the
 *     agent template. Inverting the edge would put this package's `pg` (a
 *     Postgres driver, needed only by `doctor`) in front of every first-time
 *     `npx create-evestack`, which is the flagship path.
 *   - `create-evestack` is already published at a version that works. Turning a
 *     live package into a shim is a riskier change than adding a caller.
 *
 * The import is dynamic, and that is not incidental: it keeps the scaffolder and
 * its 148 KB of template out of the process for `evestack doctor`, which is the
 * command someone runs when their production queue is wedged.
 */

/**
 * Lazy, so `create` and `attach` pay for the scaffolder only when they run.
 *
 * ── the handler that used to be here, and why it is gone ─────────────────────
 *
 * This caught ERR_MODULE_NOT_FOUND and rethrew a sentence explaining that
 * `create-evestack` was missing and that `npx create-evestack` works without
 * this package. Careful, well-worded, and unreachable: `cli.mjs` statically
 * imports project.mjs, status.mjs, tour.mjs and render.mjs, and every one of
 * them imports `create-evestack/ui` at the top level — so a missing copy fails
 * during module resolution, before `main()` is called, and there is no frame
 * left to catch it in. Verified by removing the package: the binary exits 1 on
 * a seven-frame ERR_MODULE_NOT_FOUND without reaching a line of this file.
 *
 * Making it reachable would mean lazy-loading the design system in five
 * modules to improve one broken-install message. `create-evestack` is a
 * declared, non-optional dependency (`package.json` → `create-evestack:
 * workspace:^`, published as a real range), so its absence is an install that
 * did not complete, and npm's own error names the package correctly. Deleting
 * the pretence beats maintaining it.
 */
async function load(subpath) {
  return import(`create-evestack/${subpath}`);
}

export async function create(argv) {
  const { create } = await load("create");
  return (await create(argv)) ?? 0;
}

export async function attach(argv) {
  const { attach } = await load("attach");
  return (await attach(argv)) ?? 0;
}
