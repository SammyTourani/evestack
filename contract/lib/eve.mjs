/**
 * Locates and loads the installed eve package for the contracts to interrogate.
 *
 * Everything here is read-only and offline. The suite must be free to run on
 * every eve release, which rules out anything that spends money or needs a
 * network, a database, or a Docker daemon.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./repo.mjs";

/**
 * templates/default is where evestack pins eve, so that install is the one the
 * contracts must describe. Resolving from anywhere else risks reading a
 * transitive copy at a different version — this monorepo really does carry
 * more than one eve in the pnpm store at once.
 */
const HOST_MANIFEST = join(REPO_ROOT, "templates", "default", "package.json");

/**
 * Escape hatch used to prove the suite actually fails: point it at an older eve
 * in the pnpm store and the contracts that version violates go red. Also lets
 * the upgrade workflow test a candidate release installed somewhere else.
 */
const OVERRIDE_DIR = process.env.EVESTACK_CONTRACT_EVE_DIR;

export class ContractSetupError extends Error {}

function locate() {
  if (OVERRIDE_DIR) {
    const root = resolve(REPO_ROOT, OVERRIDE_DIR);
    if (!existsSync(join(root, "package.json"))) {
      throw new ContractSetupError(
        `EVESTACK_CONTRACT_EVE_DIR=${OVERRIDE_DIR} does not contain a package.json (looked in ${root}).`,
      );
    }
    return root;
  }

  if (!existsSync(HOST_MANIFEST)) {
    throw new ContractSetupError(`Expected ${HOST_MANIFEST} to exist. Run this from an evestack checkout.`);
  }

  try {
    return dirname(createRequire(HOST_MANIFEST).resolve("eve/package.json"));
  } catch {
    throw new ContractSetupError(
      "eve is not installed. Run `pnpm install` first — the contract suite reads the real package, not a mock.",
    );
  }
}

const root = locate();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const hostManifest = existsSync(HOST_MANIFEST) ? JSON.parse(readFileSync(HOST_MANIFEST, "utf8")) : {};

/**
 * Public specifiers resolve from *inside* the located eve package, using Node's
 * package self-reference: eve declares both a `name` and an `exports` map, so
 * `eve/tools` resolves against that package's own exports.
 *
 * Resolving from templates/default instead would look right and be wrong. It
 * silently ignores EVESTACK_CONTRACT_EVE_DIR, so a run aimed at a candidate
 * release would read route patterns out of the candidate while importing
 * `localDev` from the version already installed — half the suite testing one
 * eve and half the other, all of it green. The invariant this line exists to
 * hold is: every contract interrogates exactly the package `locate()` found.
 */
const requireFromEve = createRequire(join(root, "package.json"));

export const eve = {
  version: manifest.version,
  root,
  manifest,
  /** The range templates/default pins, for reporting. */
  pin: hostManifest.dependencies?.eve ?? "(unpinned)",

  /** Subpaths eve declares in its exports map, e.g. `eve/tools`. */
  declaredSubpaths() {
    return Object.keys(manifest.exports ?? {})
      .filter((key) => key.startsWith("."))
      .map((key) => (key === "." ? "eve" : `eve/${key.slice(2)}`));
  },

  /**
   * Absolute path a public specifier resolves to, or null. Uses Node's own
   * resolver so the exports map is honoured exactly as it will be at runtime,
   * conditions and all.
   */
  resolvePublic(spec) {
    try {
      return requireFromEve.resolve(spec);
    } catch {
      return null;
    }
  },

  /** Imports a public specifier (`eve/tools`) and returns its module namespace. */
  async loadPublic(spec) {
    const file = this.resolvePublic(spec);
    if (file === null) throw new Error(`${spec} does not resolve`);
    return await import(pathToFileURL(file).href);
  },

  /**
   * Imports a compiled module that is not in the exports map, by path inside
   * dist. Reaching past the public surface is deliberate: several of evestack's
   * assumptions (route patterns, run attributes, the dynamic-tool sentinel)
   * were read out of exactly these files, so exactly these files are what must
   * be pinned. If eve moves one, we want the failure — that is the signal.
   */
  async loadInternal(relativePath) {
    const file = join(root, relativePath);
    if (!existsSync(file)) throw new Error(`${relativePath} is not present in eve ${manifest.version}`);
    return await import(pathToFileURL(file).href);
  },

  /** Reads a file from inside the eve package as text. */
  readFile(relativePath) {
    const file = join(root, relativePath);
    if (!existsSync(file)) throw new Error(`${relativePath} is not present in eve ${manifest.version}`);
    return readFileSync(file, "utf8");
  },

  fileExists(relativePath) {
    return existsSync(join(root, relativePath));
  },

  /**
   * Returns files under a dist subtree whose text matches `needle`. Callers
   * must scope the subtree: eve's dist is ~34 MB, most of it vendored
   * dependencies under dist/src/compiled that say nothing about eve's own API.
   */
  grep(needle, subtree) {
    const base = join(root, subtree);
    const hits = [];
    const stack = [base];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) {
          if (readFileSync(full, "utf8").includes(needle)) hits.push(full.slice(root.length + 1));
        }
      }
    }
    return hits.sort();
  },
};
