/**
 * The glyph set Windows gets, and the collision it had.
 *
 * `ui.mjs` drops to ASCII when `EVESTACK_ASCII` is set, and — the case this
 * file is really about — automatically on win32 outside Windows Terminal:
 *
 *     unicode = !(EVESTACK_ASCII !== undefined ||
 *                 (platform === "win32" && !WT_SESSION && !TERM_PROGRAM))
 *
 * So the ASCII path is the DEFAULT for a Windows user on the classic console,
 * which makes it the path least likely to be looked at and the one most likely
 * to be wrong. It was: the empty checkbox rendered `-`, and `g.sep` is also `-`
 * without unicode, so a single row read
 *
 *     > - Web Chat                 - Add the built-in Next.js Web Chat channel.
 *
 * with one character serving as the empty box, the separator before every
 * description, and the separator between every step in the header. Exactly the
 * `·` collision that was fixed for the Unicode set, reintroduced by its
 * fallback and three-way rather than two.
 *
 * Both sets are asserted, because a glyph set is only correct as a set.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Read the marks back from a child process, because `unicode` is decided once
 * at import from the environment — which is the behaviour under test.
 */
function marksUnder(env) {
  const script = `
    const { MARKS } = await import(${JSON.stringify(join(HERE, "..", "wizard.mjs"))});
    const { g, unicode } = await import(${JSON.stringify(join(HERE, "..", "ui.mjs"))});
    process.stdout.write(JSON.stringify({ ...MARKS, sep: g.sep, ok: g.ok, skip: g.skip, unicode }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    }),
  );
}

test("the ASCII fallback is actually reached", () => {
  assert.equal(marksUnder({ EVESTACK_ASCII: "1" }).unicode, false);
  assert.equal(marksUnder({ EVESTACK_ASCII: undefined }).unicode, true);
});

test("no glyph on a row means two different things — ASCII", () => {
  const m = marksUnder({ EVESTACK_ASCII: "1" });

  // The four that can appear on one rendered row: the gutter bar, the empty
  // checkbox, the tick that replaces it, and the separator before the note.
  const onARow = [m.gutter, m.empty, m.ok, m.sep];
  assert.equal(
    new Set(onARow).size,
    onARow.length,
    `ASCII glyphs collide on a single row: ${JSON.stringify(onARow)}`,
  );
  // The specific regression: empty box vs the separator that follows the label.
  assert.notEqual(m.empty, m.sep, "the empty checkbox is the description separator again");
});

test("no glyph on a row means two different things — Unicode", () => {
  const m = marksUnder({ EVESTACK_ASCII: undefined });

  const onARow = [m.gutter, m.empty, m.ok, m.sep];
  assert.equal(new Set(onARow).size, onARow.length, JSON.stringify(onARow));
  assert.notEqual(m.empty, m.sep);
});

test("every mark is a single column in both sets", () => {
  // The list pads against printable width. A two-character mark would shift one
  // row's columns out of line with every other row's.
  for (const env of [{ EVESTACK_ASCII: "1" }, { EVESTACK_ASCII: undefined }]) {
    const m = marksUnder(env);
    for (const [name, glyph] of Object.entries(m)) {
      if (name === "unicode") continue;
      assert.equal([...glyph].length, 1, `${name} is ${JSON.stringify(glyph)}, not one column`);
    }
  }
});

test("the ASCII set is actually ASCII", () => {
  // A fallback that still emits a multi-byte character is not a fallback. This
  // is the assertion that would catch someone "fixing" a glyph by reaching for
  // a prettier one.
  const m = marksUnder({ EVESTACK_ASCII: "1" });
  for (const [name, glyph] of Object.entries(m)) {
    if (name === "unicode") continue;
    assert.ok(/^[\x20-\x7e]$/.test(glyph), `${name} is ${JSON.stringify(glyph)}, not printable ASCII`);
  }
});
