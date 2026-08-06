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
 * Turn a missing dependency into a sentence rather than a stack trace.
 *
 * Reachable in exactly one situation that matters — a partial or hand-assembled
 * install where node_modules/create-evestack is absent — and there the useful
 * information is the workaround, because `npx create-evestack` needs nothing
 * from this package at all.
 */
async function load(subpath) {
  try {
    return await import(`create-evestack/${subpath}`);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "MODULE_NOT_FOUND") throw error;
    throw new Error(
      "evestack: the `create-evestack` package is missing, so `create` and `attach` " +
        "cannot run.\n" +
        "  Reinstall this CLI (`npm i -g evestack`), or use the scaffolder directly:\n" +
        "    npx create-evestack my-agent\n" +
        "    npx create-evestack attach .",
    );
  }
}

export async function create(argv) {
  const { create } = await load("create");
  return (await create(argv)) ?? 0;
}

export async function attach(argv) {
  const { attach } = await load("attach");
  return (await attach(argv)) ?? 0;
}
