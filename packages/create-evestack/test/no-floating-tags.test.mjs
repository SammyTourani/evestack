/**
 * The scaffold's dependencies must be pinned to versions, never to dist-tags.
 *
 * This is the test for the bug that broke every new install without anyone
 * touching the repository.
 *
 * `templates/default/package.json` carried `"@workflow/world-postgres": "beta"`.
 * A dist-tag is not a version — it is a pointer npm moves — so the scaffold did
 * not install what it was tested against, it installed whatever `beta` pointed
 * at on the day you ran it. The day it moved from `5.0.0-beta.32` to
 * `5.0.0-beta.42`, the World's declared spec version went from 5 to 7 while the
 * pinned `eve@^0.30.8` still required 5, and every fresh project died at its
 * first `npm run dev`:
 *
 *   This Workflow runtime requires a World with matching spec version 5, but
 *   the configured World declares spec version 7.
 *
 * Nothing in the repository changed. Nothing in CI failed. The published
 * scaffolder simply began producing broken projects, and it kept producing them
 * for as long as a cached copy of a `"beta"`-carrying version stayed reachable.
 *
 * The class of bug matters more than the one instance: a scaffolder's whole job
 * is to hand someone a working tree, and it cannot do that while any part of
 * what it installs is decided after it was tested. Ranges are fine — `^` and
 * `~` still resolve within a release line someone chose. A bare tag is not a
 * choice, it is a subscription.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The scaffold's manifest, as published — synced from templates/default. */
function templateManifest() {
  return JSON.parse(readFileSync(join(HERE, "..", "template", "package.json"), "utf8"));
}

/**
 * A specifier npm resolves to a version, rather than one that names it.
 *
 * Deliberately a shape test and not a list of known tag names. `latest`, `beta`
 * and `next` are the common ones, but a registry can carry any tag, and the
 * failure has nothing to do with which word it is — it is that the word is
 * resolved at install time. Anything that does not begin with a digit, a range
 * operator, a `v`, or a protocol is a tag.
 */
function isFloatingTag(specifier) {
  if (typeof specifier !== "string" || specifier === "") return false;
  // Protocols name an exact source: workspace:, file:, link:, npm:, git+…, a URL.
  if (/^[a-z+]+:/i.test(specifier)) return false;
  if (specifier === "*") return true;
  return !/^[\^~><=v\d]/.test(specifier);
}

test("isFloatingTag knows a tag from a range", () => {
  for (const tag of ["beta", "latest", "next", "canary", "*"]) {
    assert.equal(isFloatingTag(tag), true, `${tag} is a tag`);
  }
  for (const version of ["5.0.0-beta.32", "^7.0.38", "~4.1.0", ">=2 <3", "4.x", "v1.2.3"]) {
    assert.equal(isFloatingTag(version), false, `${version} names a version`);
  }
  for (const proto of ["workspace:*", "file:../x", "npm:pkg@1.0.0", "git+https://e.com/r.git"]) {
    assert.equal(isFloatingTag(proto), false, `${proto} names an exact source`);
  }
});

test("nothing the scaffold installs is chosen by a dist-tag", () => {
  const manifest = templateManifest();
  const offenders = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (isFloatingTag(specifier)) offenders.push(`${field}.${name} = ${JSON.stringify(specifier)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a dist-tag here means the published scaffold installs whatever the tag points at " +
      "on the day someone runs it, which is how every new project broke without a commit",
  );
});

test("the World adapter in particular is pinned exactly", () => {
  // The one that actually broke, and the one with the least margin: eve embeds a
  // World spec version and refuses to start against an adapter declaring any
  // other one, so even a `^` here would be a range across an incompatibility.
  const { dependencies } = templateManifest();
  const world = dependencies["@workflow/world-postgres"];

  assert.ok(world, "the scaffold needs a World adapter");
  assert.match(
    world,
    /^\d+\.\d+\.\d+(-[\w.]+)?$/,
    `"@workflow/world-postgres": ${JSON.stringify(world)} must be one exact version`,
  );
});
