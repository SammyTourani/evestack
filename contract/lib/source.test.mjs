/**
 * The scanner contract 22 reads route handlers and factory calls with.
 *
 * Its whole reason to exist is that the thing it replaced could not tell "the
 * construct is absent" from "the construct is present and fine" —
 * `source.indexOf(x)` answering -1 and `slice(-1)` answering the last character
 * of the file. So the assertions that matter most here are the NEGATIVE ones:
 * asked for something that is not there, every function must answer null or -1,
 * and never a substring that happens to satisfy the caller's regex.
 *
 *   node --test 'contract/lib/*.test.mjs'
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { callSites, declaredParameters, exportedBinding, isCodePosition, matchBracket, splitArguments } from "./source.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

/* -------------------------------------------------------------------------- */
/* exportedBinding — both export forms, and "not there" as an answer           */
/* -------------------------------------------------------------------------- */

test("finds a function-declaration export and stops at its own closing brace", () => {
  const source = `export async function GET(): Promise<Response> {\n  return one();\n}\nexport function POST() {\n  return two();\n}\n`;
  const found = exportedBinding(source, "GET");
  assert.ok(found);
  assert.match(found.text, /return one\(\)/);
  // The old code sliced to the end of the file, so "the GET handler" silently
  // included every export written below it.
  assert.doesNotMatch(found.text, /return two\(\)/);
});

test("finds an arrow-const export, which the old indexOf did not", () => {
  const source = `export const GET = async (): Promise<Response> => {\n  return one();\n};\n`;
  const found = exportedBinding(source, "GET");
  assert.ok(found, "export const GET = async () => …  must be found");
  assert.match(found.text, /return one\(\)/);
});

test("finds a wrapped export and keeps the body inside it", () => {
  const source = `export const GET = withAuth(async () => {\n  return one();\n});\n`;
  const found = exportedBinding(source, "GET");
  assert.ok(found);
  assert.match(found.text, /return one\(\)/);
});

test("a type annotation containing braces is not mistaken for the body", () => {
  const source = `export const GET: Handler<{ a: string }> = async () => {\n  return one();\n};\n`;
  const found = exportedBinding(source, "GET");
  assert.ok(found);
  assert.match(found.text, /return one\(\)/);
});

test("an absent export is null, not the tail of the file", () => {
  const source = `export async function POST() {\n  return { ok: true };\n}\n`;
  assert.equal(exportedBinding(source, "GET"), null);
});

test("the sentence 'export async function GET' inside a comment is not an export", () => {
  const source = `/**\n * Superseded by POST; there is no export async function GET here any more.\n */\nexport async function POST() { return 1; }\n`;
  assert.equal(exportedBinding(source, "GET"), null);
});

test("a brace inside a comment or a string does not end the body early", () => {
  const source =
    `export async function GET() {\n` +
    `  // a closing brace } in a comment\n` +
    `  const s = "a closing brace } in a string";\n` +
    `  const t = \`and \${"one"} in a template }\`;\n` +
    `  const r = /\\}/;\n` +
    `  return one();\n` +
    `}\n`;
  const found = exportedBinding(source, "GET");
  assert.ok(found);
  assert.match(found.text, /return one\(\)/);
});

/* -------------------------------------------------------------------------- */
/* the defect itself, end to end                                              */
/* -------------------------------------------------------------------------- */

test("an arrow-form handler answering ok from its catch is visible", () => {
  // The exact fixture that proved contract 22's tick was false: rewritten to the
  // arrow form, with `ok: true` in the catch, the old slice(-1) code passed.
  const source =
    `export const GET = async (): Promise<Response> => {\n` +
    `  try {\n` +
    `    return Response.json({ ok: true, database: "up" });\n` +
    `  } catch {\n` +
    `    return Response.json({ ok: true, database: "unreachable" });\n` +
    `  }\n` +
    `};\n`;
  const found = exportedBinding(source, "GET");
  assert.ok(found);
  const afterCatch = found.text.slice(found.text.search(/\}\s*catch\b/));
  assert.match(afterCatch, /\bok:\s*true/, "the ok: true inside the catch must be reachable by the check");
});

test("both real liveness routes are located, and neither answers ok from a catch", () => {
  for (const rel of ["packages/dashboard/app/api/health/route.ts", "packages/dashboard/app/api/health/detail/route.ts"]) {
    const found = exportedBinding(read(rel), "GET");
    assert.ok(found, `${rel}: GET not located`);
    const catchAt = found.text.search(/\}\s*catch\b/);
    assert.notEqual(catchAt, -1, `${rel}: expected a catch in GET; if it lost one, this test is describing the wrong file`);
    assert.doesNotMatch(found.text.slice(catchAt), /\bok:\s*true/, `${rel} answers ok from inside a catch`);
  }
});

/* -------------------------------------------------------------------------- */
/* call sites and arguments                                                   */
/* -------------------------------------------------------------------------- */

test("arguments are split at the top level only", () => {
  const source = `f(a, [b, c], { d: 1, e: 2 }, g(h, i), \`t \${j}, k\`, "l, m")`;
  const args = splitArguments(source, source.indexOf("("));
  assert.deepEqual(args, ["a", "[b, c]", "{ d: 1, e: 2 }", "g(h, i)", "`t ${j}, k`", '"l, m"']);
});

test("a trailing comma is not an extra argument", () => {
  const source = `f(\n  a,\n  true,\n)`;
  assert.deepEqual(splitArguments(source, source.indexOf("(")), ["a", "true"]);
});

test("call sites exclude mentions in comments and strings, and property calls", () => {
  const source =
    `// finding("in a comment", 1)\n` +
    `const s = 'finding("in a string", 2)';\n` +
    `x.finding("a method", 3);\n` +
    `buildfinding("a longer name", 4);\n` +
    `finding("the real one", 5);\n`;
  const sites = callSites(source, "finding");
  assert.equal(sites.length, 1);
  assert.equal(sites[0].args[0], '"the real one"');
});

test("the blind flag is read by position, and a bare `true,` elsewhere does not count", () => {
  // The two ways the old `line.trim() === "true,"` counter was wrong, in one
  // fixture: an unrelated array of `true` literals, and a finding whose blind
  // argument is absent.
  const source =
    `const finding = (id, severity, title, action, evidence = [], detail = [], blind = false) => ({ id, blind });\n` +
    `const UNRELATED = [\n  true,\n  true,\n  true,\n  true,\n];\n` +
    `finding("marked", W, "t", "a", [], [], true);\n` +
    `finding("unmarked", W, "t", "a", [], []);\n`;
  const blindAt = declaredParameters(source, "finding").findIndex((p) => /^blind\b/.test(p));
  assert.equal(blindAt, 6);
  const marked = callSites(source, "finding").filter((call) => call.args[blindAt] === "true");
  assert.deepEqual(marked.map((call) => call.args[0]), ['"marked"']);
});

test("the real findings.mjs has its blind flag in the seventh position and six calls carrying it", () => {
  const source = read("packages/evestack-cli/src/findings.mjs");
  const parameters = declaredParameters(source, "finding");
  assert.ok(parameters, "findings.mjs no longer declares a finding() factory this contract can read");
  const blindAt = parameters.findIndex((p) => /^blind\b/.test(p));
  assert.notEqual(blindAt, -1, `no blind parameter in (${parameters.join(", ")})`);
  const sites = callSites(source, "finding");
  assert.ok(sites.length >= 10, `only ${sites.length} finding() call sites parsed; the scanner lost its grip on the file`);
  const marked = sites.filter((call) => call.args[blindAt] === "true");
  assert.ok(marked.length >= 6, `only ${marked.length} findings carry the blind flag`);
});

test("a signature reordered so blind is no longer seventh is detected, not miscounted", () => {
  const source =
    `const finding = (id, blind = false, severity, title) => ({ id, blind });\n` + `finding("x", true, W, "t");\n`;
  const blindAt = declaredParameters(source, "finding").findIndex((p) => /^blind\b/.test(p));
  assert.equal(blindAt, 1, "the position must come from the declaration, not from memory");
});

/* -------------------------------------------------------------------------- */
/* the primitives                                                             */
/* -------------------------------------------------------------------------- */

test("matchBracket answers -1 rather than a plausible index when the source does not balance", () => {
  assert.equal(matchBracket("f(a, b", 1), -1);
  assert.equal(matchBracket("f(a, b]", 1), -1);
  assert.equal(matchBracket("not a bracket", 0), -1);
});

test("splitArguments answers null on an unbalanced call", () => {
  assert.equal(splitArguments("f(a, b", 1), null);
});

test("isCodePosition tells code from comment, string and template", () => {
  const source = `const a = "x"; // y\nconst b = \`z\`;\n`;
  assert.equal(isCodePosition(source, source.indexOf("const a")), true);
  assert.equal(isCodePosition(source, source.indexOf("x")), false);
  assert.equal(isCodePosition(source, source.indexOf("y")), false);
  assert.equal(isCodePosition(source, source.indexOf("z")), false);
  assert.equal(isCodePosition(source, source.indexOf("const b")), true);
});

test("a division sign is not read as a regex literal", () => {
  // If `(a + b) / 2` were treated as opening a regex, the scan would swallow the
  // rest of the line and the body would end in the wrong place.
  const source = `export function GET() {\n  const half = (a + b) / 2;\n  return half;\n}\n`;
  const found = exportedBinding(source, "GET");
  assert.ok(found);
  assert.match(found.text, /return half/);
});
