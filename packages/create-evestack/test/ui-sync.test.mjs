/**
 * The design system exists in two places. This is what keeps them one file.
 *
 *   packages/create-evestack/ui.mjs      imported by shared/create/attach, and
 *                                        by `evestack` via the ./ui export
 *   templates/default/scripts/ui.mjs     copied into every scaffolded project,
 *                                        imported by its checks/verify/dev
 *
 * A scaffolded project cannot import from create-evestack — it is standalone —
 * so a second copy is unavoidable. What is avoidable is the two drifting, which
 * is exactly what happened to `packages/create-evestack/template/` when it was
 * tracked (see .gitignore, which records why it no longer is).
 *
 * Byte-identical, not "equivalent": the moment this allows a divergence it stops
 * being a test and becomes a convention nobody checks.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_COPY = join(HERE, "..", "ui.mjs");
const TEMPLATE_COPY = join(HERE, "..", "..", "..", "templates", "default", "scripts", "ui.mjs");

test("ui.mjs is byte-identical in both places", () => {
  // Skipped outside the monorepo: a published tarball has template/scripts/ui.mjs
  // but not templates/default, and this test is about the source tree.
  if (!existsSync(TEMPLATE_COPY)) return;

  const pkg = readFileSync(PACKAGE_COPY, "utf8");
  const tpl = readFileSync(TEMPLATE_COPY, "utf8");

  assert.equal(
    pkg,
    tpl,
    "packages/create-evestack/ui.mjs and templates/default/scripts/ui.mjs have diverged.\n" +
      "  The first is the source of truth. Copy it over the second:\n" +
      "    cp packages/create-evestack/ui.mjs templates/default/scripts/ui.mjs",
  );
});

test("ui.mjs emits no escapes when colour is off", async () => {
  // Imported in a child so the module-level colour decision is made against a
  // clean environment — it is decided once, at import, on purpose.
  const { execFileSync } = await import("node:child_process");
  const script = `
    const ui = await import(${JSON.stringify(PACKAGE_COPY)});
    process.stdout.write(String(ui.color) + "\\n");
    process.stdout.write(ui.c.red("red") + ui.c.brand("brand") + ui.g.OK + "\\n");
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined },
    encoding: "utf8",
  });

  assert.match(out, /^false\n/, "NO_COLOR=1 must turn colour off");
  assert.doesNotMatch(out, /\x1b\[/, "no escape sequence may survive NO_COLOR");
});

test("visible() measures past the escapes it is given", async () => {
  const ui = await import("../ui.mjs");
  assert.equal(ui.visible("\x1b[31mred\x1b[0m"), 3);
  assert.equal(ui.visible("plain"), 5);
  // The property every table alignment depends on: a coloured cell and an
  // uncoloured one of the same text pad to the same width.
  assert.equal(ui.visible(ui.c.red("abc")), ui.visible("abc"));
});
