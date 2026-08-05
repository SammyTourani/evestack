/**
 * Every `eve/*` specifier evestack imports still resolves, and every value it
 * takes from one is still exported.
 *
 * The import list is read out of evestack's source rather than hard-coded, so
 * a new `import { x } from "eve/y"` becomes a pinned contract the moment it is
 * written, with nothing to remember to update here.
 */
import { eveImports } from "../lib/repo.mjs";

const surface = {
  id: "modules/imported-subpaths-resolve",
  title: "every eve subpath evestack imports still exists",
  assumption: "The `eve/*` subpaths evestack imports are all present in eve's exports map and resolve to real files.",
  evestackUse:
    "These specifiers appear in templates/default (the agent users scaffold), in packages/dashboard, and " +
    "inlined as strings inside registry/r/*.json — the files `eve add @evestack/memory` writes into a " +
    "user's project. A subpath that disappears breaks `pnpm build` for every scaffolded agent, and for the " +
    "registry copies it breaks at the user's machine with no failing build in this repo to warn us first.",

  async check(eve, t) {
    const imports = eveImports();
    t.ok(imports.length > 0, `found ${imports.length} distinct eve specifiers in evestack's own source`);

    const declared = new Set(eve.declaredSubpaths());
    for (const { spec, origins } of imports) {
      const where = origins.length === 1 ? origins[0] : `${origins[0]} (+${origins.length - 1} more)`;
      t.contains(declared, spec, `eve declares "${spec}" in its exports map — imported by ${where}`);

      const resolved = eve.resolvePublic(spec);
      t.ok(resolved !== null, `"${spec}" resolves to a file on disk`, {
        ...(resolved === null ? { expected: "a resolvable module", actual: "MODULE_NOT_FOUND" } : {}),
      });
    }
  },
};

const namedExports = {
  id: "modules/imported-values-are-exported",
  title: "every value evestack imports from eve is still exported at runtime",
  assumption: "The named value exports evestack binds from each eve subpath still exist in the compiled module.",
  evestackUse:
    "`tsc` catches this for templates/default and packages/*, but not for registry/r/*.json: those items " +
    "carry agent source inlined as JSON strings and are never typechecked by anything. `eve add " +
    "@evestack/memory` writes them straight into a user's project, so a renamed export fails there first " +
    "and here never. This assertion is the only typecheck those files get.",

  async check(eve, t) {
    for (const { spec, names, origins } of eveImports()) {
      // Namespace and default imports carry no named binding to verify, and a
      // specifier that does not resolve is already reported by the contract
      // above — no value in failing twice for one cause.
      const wanted = names.filter((n) => n !== "*" && n !== "default");
      if (wanted.length === 0 || eve.resolvePublic(spec) === null) continue;

      let namespace;
      try {
        namespace = await eve.loadPublic(spec);
      } catch (error) {
        t.ok(false, `"${spec}" can be imported at runtime`, {
          expected: "a loadable module",
          actual: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const exported = new Set(Object.keys(namespace));
      for (const name of wanted) {
        t.contains(exported, name, `${spec} exports \`${name}\` — used by ${origins[0]}`);
      }
    }
  },
};

export default [surface, namedExports];
