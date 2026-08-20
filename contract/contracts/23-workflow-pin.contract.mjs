/**
 * Every `@workflow/*` version this repo declares is an EXACT version.
 *
 * ── The bug this is for ──────────────────────────────────────────────────────
 *
 * templates/default/package.json declared:
 *
 *     "@workflow/world-postgres": "beta"
 *
 * which is a dist-tag, not a version range. A dist-tag names whatever upstream
 * published most recently, so the string in the manifest never changes while the
 * package underneath it does — and upstream ships World **spec** changes inside
 * the `5.0.0-beta.*` line with no semver signal at all.
 *
 * Measured against eve 0.30.8, by installing each one and booting it:
 *
 *   world-postgres 5.0.0-beta.32 → @workflow/world 5.0.0-beta.25 → spec 5
 *       [DEV] server listening at http://127.0.0.1:2000/
 *   world-postgres 5.0.0-beta.34 → @workflow/world 5.0.0-beta.27 → spec 6
 *       [env-runner] worker init failed: This Workflow runtime requires a World
 *       with matching spec version 5, but the configured World declares spec
 *       version 6.
 *       Development worker failed before readiness
 *
 * So `npx create-evestack` produced a project that could not start. Not
 * intermittently and not on some machines: every fresh scaffold, because a fresh
 * scaffold has no lockfile and resolves the tag at install time. This repository
 * could not see it, because pnpm-lock.yaml froze the same declaration at
 * 5.0.0-beta.31 months ago — the checkout that ships the bug is the one checkout
 * immune to it.
 *
 * The `beta` tag moved from `.34` to `.35` during the session that found this.
 * That is the shape of the hazard: the failure arrives on upstream's publish
 * schedule, from a commit nobody made here, and it reaches users before it
 * reaches CI.
 *
 * ── Why the obvious near-fixes are not fixes ─────────────────────────────────
 *
 * `^5.0.0-beta.32` and `~5.0.0-beta.32` both still resolve to `.34` and `.35`.
 * Prerelease identifiers compare lexically within one `5.0.0` triple, so caret
 * and tilde — which pin the major and the minor/patch respectively — constrain
 * nothing that matters here. Anything that leaves npm a choice reintroduces this
 * verbatim, which is why the property asserted below is "exact", not "pinned
 * enough".
 *
 * ── What is deliberately allowed ─────────────────────────────────────────────
 *
 * templates/default's `overrides` block has a `@workflow/world-local` KEY whose
 * value is an object (`{ "undici": "^7.29.0" }`). That is npm's nested-override
 * syntax: the key selects a package to override *inside*, and the object is the
 * override set. It declares no version of `@workflow/world-local` at all, so it
 * is skipped — by checking the value's type, not by naming the package, because
 * a future `"@workflow/world": "beta"` sitting in that same block is a real
 * hazard and must fail.
 *
 * packages/create-evestack/template/ is skipped for the reason repo.mjs skips
 * it: gitignored, regenerated from templates/default at prepack, and a stale
 * local copy would fail a contract about a file nobody committed.
 *
 * ── The second declaration site ──────────────────────────────────────────────
 *
 * The manifest is not the only place a version of this package is chosen.
 * `evestack attach` writes the dependency into a project it did not scaffold,
 * from a constant in packages/create-evestack/attach.mjs — which carried
 * `"beta"` for the same reason and would have kept handing out the broken
 * resolution after templates/default was fixed. A scan of package.json files
 * alone would have gone green over half a bug, so this contract reads that
 * constant out of the source and asserts the two agree.
 *
 * Scope is `repo`: it describes this checkout's declarations, not eve.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";
import { parse } from "../lib/semver.mjs";

/** Dependency fields whose values are version ranges for the named package. */
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * Fields whose values are a package→version map that npm/pnpm force onto the
 * whole tree. An override is a declaration like any other: it decides what gets
 * installed, so a dist-tag here is the same defect wearing a different field
 * name. `pnpm.overrides` is reached through the `pnpm` key.
 */
const OVERRIDE_FIELDS = ["overrides", "resolutions"];

/** Every manifest in this repository, repo-relative. */
function manifests() {
  const found = ["package.json"];
  for (const top of ["packages", "templates"]) {
    let entries;
    try {
      entries = readdirSync(join(REPO_ROOT, top), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      found.push(join(top, entry.name, "package.json"));
    }
  }
  return found;
}

/**
 * Every `@workflow/*` version string a manifest declares, wherever it declares
 * it. Override blocks nest, so this walks them rather than reading one level:
 * npm's nested form puts a second override map under a package key, and a
 * dist-tag two levels down installs exactly as hard as one at the top.
 */
function workflowDeclarations(manifest, file) {
  const out = [];

  for (const field of DEP_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith("@workflow/")) continue;
      out.push({ file, where: field, name, range });
    }
  }

  const walkOverrides = (node, where) => {
    for (const [name, value] of Object.entries(node ?? {})) {
      if (typeof value === "string") {
        if (name.startsWith("@workflow/")) out.push({ file, where, name, range: value });
      } else if (value !== null && typeof value === "object") {
        // A selector key, not a version — see the header. Recurse: the versions
        // live one level further down.
        walkOverrides(value, `${where}.${name}`);
      }
    }
  };
  for (const field of OVERRIDE_FIELDS) walkOverrides(manifest[field], field);
  walkOverrides(manifest.pnpm?.overrides, "pnpm.overrides");

  return out;
}

/**
 * The version `evestack attach` writes for @workflow/world-postgres.
 *
 * Read out of the source rather than imported, because attach.mjs runs a wizard
 * on import-adjacent module scope and this contract must stay offline and
 * side-effect free. Deliberately narrow: it matches the push site, takes the
 * identifier from it, and resolves that identifier's `const` — so renaming the
 * constant is fine and *deleting* the mechanism is a failure rather than a
 * silent pass.
 */
const ATTACH_SOURCE = join("packages", "create-evestack", "attach.mjs");

function attachPin() {
  const source = readFileSync(join(REPO_ROOT, ATTACH_SOURCE), "utf8");

  const push = /\[\s*"@workflow\/world-postgres"\s*,\s*([A-Za-z_$][\w$]*|"[^"]*")\s*\]/.exec(source);
  if (push === null) return { found: false, reason: "no [\"@workflow/world-postgres\", …] pair in the source" };

  const token = push[1];
  if (token.startsWith('"')) return { found: true, via: "an inline literal", value: token.slice(1, -1) };

  const declaration = new RegExp(`const\\s+${token}\\s*=\\s*"([^"]*)"`).exec(source);
  if (declaration === null) {
    return { found: false, reason: `the pair names ${token}, and no \`const ${token} = "…"\` declares it` };
  }
  return { found: true, via: `const ${token}`, value: declaration[1] };
}

export default {
  id: "deps/workflow-packages-are-exact-versions",
  title: "no @workflow/* version in this repo is a dist-tag or a floating range",
  scope: "repo",
  assumption:
    "Upstream changes the World spec version inside the 5.0.0-beta.* line without a semver bump. " +
    "eve 0.30.8's Workflow runtime requires World spec 5; world-postgres 5.0.0-beta.32 pulls " +
    "@workflow/world 5.0.0-beta.25 (spec 5) and boots, while 5.0.0-beta.34 pulls 5.0.0-beta.27 " +
    "(spec 6) and dies at startup. Anything that leaves npm a choice between them therefore " +
    "decides at install time whether a user's project runs.",
  evestackUse:
    "templates/default is the manifest every scaffolded project installs, and packages/" +
    "create-evestack ships it verbatim, so a dist-tag there is a dist-tag in every `npx " +
    "create-evestack` on the day upstream publishes. `evestack attach` writes the same " +
    "dependency into projects evestack did not scaffold, from its own constant. Neither is " +
    "protected by pnpm-lock.yaml: a scaffolded project has no lockfile, which is exactly why " +
    "this repository's own install kept working while every new user's did not.",

  async check(_eve, t) {
    let manifestsRead = 0;
    let declarationsSeen = 0;
    let templatePin;

    for (const file of manifests()) {
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8"));
      } catch {
        continue; // not every packages/* directory has to be a package
      }
      manifestsRead += 1;

      for (const { where, name, range } of workflowDeclarations(manifest, file)) {
        declarationsSeen += 1;
        if (file === join("templates", "default", "package.json") && name === "@workflow/world-postgres") {
          templatePin = range;
        }

        // `parse` is the suite's own semver reader and returns null for anything
        // that is not a bare version: "beta" and "latest" fail it because they
        // are not versions at all, and "^5.0.0-beta.32" / "~5.0.0-beta.32" /
        // ">=5.0.0-beta.32" fail it because the operator is not part of the
        // grammar it accepts. That is the whole test.
        const exact = parse(range) !== null;
        t.ok(exact, `${file} → ${where}."${name}" = "${range}" is an exact version`, {
          ...(exact
            ? {}
            : {
                expected: 'an exact version, e.g. "5.0.0-beta.32"',
                actual:
                  `"${range}" — a dist-tag or a range, so npm picks the version at install time. ` +
                  "Upstream moves the World spec inside 5.0.0-beta.*, so the pick decides whether " +
                  "a freshly scaffolded project boots or dies with `This Workflow runtime requires " +
                  "a World with matching spec version 5, but the configured World declares spec " +
                  "version 6`. ^ and ~ are not fixes: both still admit 5.0.0-beta.34.",
              }),
        });
      }
    }

    // ---- the scaffolder's own copy of the same decision ---------------------

    const attach = attachPin();
    t.ok(attach.found, `${ATTACH_SOURCE} still writes @workflow/world-postgres from a readable constant`, {
      ...(attach.found
        ? {}
        : {
            expected: 'newDeps.push(["@workflow/world-postgres", SOME_CONST]) with a `const SOME_CONST = "…"`',
            actual: `${attach.reason}. The scan cannot see the version attach writes, so it is unchecked.`,
          }),
    });

    if (attach.found) {
      const exact = parse(attach.value) !== null;
      t.ok(exact, `${ATTACH_SOURCE} → ${attach.via} = "${attach.value}" is an exact version`, {
        ...(exact
          ? {}
          : {
              expected: 'an exact version, e.g. "5.0.0-beta.32"',
              actual:
                `"${attach.value}" — \`evestack attach\` would write this into an existing ` +
                "project's package.json, so a fixed template still leaves attach handing out a " +
                "resolution that dies at boot.",
            }),
      });

      // Not `t.equal`: neither side is the "expected" one. templates/default is
      // what a fresh scaffold installs and attach.mjs is what an existing
      // project gets, they are two answers to one question, and a report that
      // labelled either as correct would send the reader to fix the wrong file.
      const agree = attach.value === templatePin;
      t.ok(
        agree,
        `${ATTACH_SOURCE} and templates/default declare the same @workflow/world-postgres version`,
        {
          ...(agree
            ? {}
            : {
                expected: "one version in both places",
                actual:
                  `attach writes "${attach.value}", templates/default declares "${templatePin}". ` +
                  "A scaffolded project and an attached project would then run different worlds, " +
                  "and only one of them was booted before shipping.",
              }),
        },
      );
    }

    // ---- ANTI-VACUITY -------------------------------------------------------
    //
    // Every assertion above is inside a loop over things this contract found for
    // itself. A rename, a moved manifest or a tightened regex makes it find
    // nothing and report a clean green run — which is the failure mode the
    // suite's own doctrine calls a defect rather than a test. These three say
    // what "found nothing" looks like out loud.

    t.ok(manifestsRead >= 10, `read ${manifestsRead} package.json manifests`, {
      expected: ">= 10 — the root, templates/default and eight packages/*",
      actual: `${manifestsRead}; the manifest walk is broken and the checks above are vacuous`,
    });

    t.ok(declarationsSeen >= 1, `found ${declarationsSeen} @workflow/* version declaration(s) to check`, {
      expected: ">= 1",
      actual: `${declarationsSeen}; nothing was inspected, so this contract asserted nothing`,
    });

    t.ok(
      templatePin !== undefined,
      "templates/default declares @workflow/world-postgres as a direct dependency",
      {
        expected: "dependencies.\"@workflow/world-postgres\" in templates/default/package.json",
        actual:
          "absent. Either the durable world was dropped from the template — which is a much " +
          "larger change than this contract — or the scan stopped finding it.",
      },
    );
  },
};
