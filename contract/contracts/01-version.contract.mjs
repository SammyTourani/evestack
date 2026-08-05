/**
 * Meta-contract: the eve the suite just interrogated is the eve we ship.
 *
 * Without this, every other contract could pass against a version nobody
 * installs — which is precisely the failure mode of an automated upgrade job
 * that bumps one manifest and leaves four behind.
 */
import { eveVersionRanges } from "../lib/repo.mjs";
import { UnsupportedRangeError, parse, satisfies } from "../lib/semver.mjs";

export default {
  id: "version/installed-satisfies-every-declared-range",
  title: "the installed eve satisfies every eve range this repo declares",

  /**
   * The only repo-scoped contract in the suite: every other one asks "does eve
   * still behave this way", while this one asks "is this checkout's install
   * self-consistent". That distinction matters when certifying a release we do
   * not pin — 0.30.2 does not satisfy `^0.30.6` and never will, so running this
   * against it manufactures a red row that says nothing about 0.30.2. The
   * runner skips repo-scoped contracts whenever it is pointed at an eve other
   * than the installed one.
   */
  scope: "repo",
  assumption: "One eve version satisfies templates/default, both publishable packages' peer ranges, and the scaffolder.",
  evestackUse:
    "evestack declares eve in several manifests at once: templates/default pins the version users install, " +
    "@evestack/composio and @evestack/sandbox-opensandbox declare peer ranges that decide whether npm lets " +
    "users install them beside their eve, and packages/create-evestack ships templates/default verbatim. " +
    "A version that satisfies one and not the others produces an install that resolves in this repo and " +
    "fails at `npx create-evestack` — or, worse, a published peer range that quietly promises support for " +
    "an eve nothing here has ever been tested against.",

  async check(eve, t) {
    t.ok(
      parse(eve.version) !== null,
      `eve reports a parseable version (${eve.version})`,
      parse(eve.version) === null ? { actual: eve.version, expected: "semver" } : {},
    );

    const ranges = eveVersionRanges();
    t.ok(ranges.length > 0, `found ${ranges.length} declared eve ranges across the repo's manifests`);

    for (const { file, field, range } of ranges) {
      // `workspace:` and dist-tags are not version ranges and cannot be checked
      // here; they are also not how eve is ever declared, so seeing one means
      // someone changed the dependency style and this contract should be told.
      let holds;
      try {
        holds = satisfies(eve.version, range);
      } catch (error) {
        t.ok(false, `${file} → ${field}.eve = "${range}" is a range this suite can evaluate`, {
          actual: error instanceof UnsupportedRangeError ? error.message : String(error),
          expected: "a plain semver range",
        });
        continue;
      }
      t.ok(holds, `eve ${eve.version} satisfies ${field}.eve = "${range}" in ${file}`, {
        ...(holds ? {} : { expected: range, actual: eve.version }),
      });
    }

    // The scaffolder ships templates/default, so the two pins are the same
    // string by construction — unless someone edits one by hand.
    const templatePin = ranges.find((r) => r.file.endsWith("templates/default/package.json") && r.field === "dependencies");
    t.ok(templatePin !== undefined, "templates/default declares eve as a direct dependency");
  },
};
