/**
 * Reading a construct out of a source file, with "I could not find it" as an
 * answer rather than as a silent all-clear.
 *
 * ── The defect this is for ───────────────────────────────────────────────────
 *
 * contract 22 located a route handler like this:
 *
 *   const handler = source.slice(source.indexOf("export async function GET"));
 *   const afterCatch = handler.slice(handler.indexOf("} catch"));
 *   t.ok(!/ok:\s*true/.test(afterCatch), rel + " does not answer ok from inside a catch")
 *
 * `indexOf` answers -1 when it does not find the thing, and `slice(-1)` is not
 * an error — it is the LAST CHARACTER of the string. So a route written
 * `export const GET = async () => …`, a form this repository already uses and
 * nothing forbids, reduced both slices to a single newline, the regex trivially
 * passed, and the suite printed a green tick whose text is an affirmative safety
 * claim about a file it never read. Measured: with `{ ok: true, database:
 * "unreachable" }` inside the catch and the export in arrow form, the suite
 * reported "does not answer ok from inside a catch" and exited 0.
 *
 * A grep that cannot tell "absent" from "present and fine" is not a check. So
 * every function here returns `null` for "not found", never a substring that
 * happens to satisfy the caller's regex, and callers are expected to assert on
 * that null rather than fall through it.
 *
 * ── Why a scanner and not a regex ────────────────────────────────────────────
 *
 * The two things contract 22 needs — the text of one exported handler, and the
 * argument list of every call to one factory — are both bracket-structured, and
 * both live in files full of prose comments and template literals that contain
 * braces, quotes and the word `catch`. A regex over that either under-matches
 * (the bug above) or silently over-matches into the next declaration. The
 * scanner below skips comments, strings, template literals (including nested
 * `${…}`) and regex literals, so a brace inside a sentence is a sentence.
 *
 * It is not a JavaScript parser and does not pretend to be one. It knows enough
 * to balance brackets in first-party source, which is the whole job; anything it
 * cannot balance it reports as -1 or null, which its callers turn into a red
 * assertion rather than into a pass.
 */

const CLOSING = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);
const IDENT = /[A-Za-z0-9_$]/;

/**
 * Keywords after which a `/` opens a regex literal rather than dividing. After
 * anything else that ends an expression — an identifier, a number, `)`, `]` —
 * a slash is division.
 */
const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function skipQuoted(source, i) {
  const quote = source[i];
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === "\\") {
      j += 2;
      continue;
    }
    if (source[j] === quote) return j + 1;
    j += 1;
  }
  return source.length; // unterminated: consume the rest rather than loop
}

function skipTemplate(source, i) {
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === "\\") {
      j += 2;
      continue;
    }
    if (source[j] === "`") return j + 1;
    if (source[j] === "$" && source[j + 1] === "{") {
      // The interpolation is arbitrary code and may itself contain a template.
      const close = matchBracket(source, j + 1);
      if (close === -1) return source.length;
      j = close + 1;
      continue;
    }
    j += 1;
  }
  return source.length;
}

function startsRegex(source, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j])) j -= 1;
  if (j < 0) return true;
  if (IDENT.test(source[j])) {
    let k = j;
    while (k >= 0 && IDENT.test(source[k])) k -= 1;
    return REGEX_AFTER.has(source.slice(k + 1, j + 1));
  }
  return "(,=:[!&|?{};+-*%^~<>".includes(source[j]);
}

function skipRegex(source, i) {
  let j = i + 1;
  let inClass = false;
  while (j < source.length) {
    const ch = source[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    // A regex literal cannot span a line. Hitting one means the heuristic above
    // was wrong and this slash was division; treat it as an ordinary character.
    if (ch === "\n") return i + 1;
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      j += 1;
      while (j < source.length && /[dgimsuvy]/.test(source[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return source.length;
}

/**
 * If `source[i]` opens a comment, string, template or regex literal, the index
 * just past it; otherwise `i` unchanged. Callers loop on the "unchanged" answer
 * to mean "this is ordinary code, look at it".
 */
export function skipNonCode(source, i) {
  const ch = source[i];
  if (ch === "/" && source[i + 1] === "/") {
    const nl = source.indexOf("\n", i);
    return nl === -1 ? source.length : nl;
  }
  if (ch === "/" && source[i + 1] === "*") {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (ch === '"' || ch === "'") return skipQuoted(source, i);
  if (ch === "`") return skipTemplate(source, i);
  if (ch === "/" && startsRegex(source, i)) return skipRegex(source, i);
  return i;
}

/**
 * Index of the bracket closing the one at `open`, or -1 if the source does not
 * balance. `source[open]` must be `(`, `[` or `{`.
 */
export function matchBracket(source, open) {
  if (CLOSING[source[open]] === undefined) return -1;
  const stack = [];
  let i = open;
  while (i < source.length) {
    const skipped = skipNonCode(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = source[i];
    if (CLOSING[ch] !== undefined) {
      stack.push(CLOSING[ch]);
      i += 1;
      continue;
    }
    if (CLOSERS.has(ch)) {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * The top-level arguments of the call whose `(` is at `open`, as trimmed source
 * text, or null if the parentheses do not balance.
 *
 * Text, not values: the point is to answer "is the seventh argument literally
 * `true`", which is a question about what was written. Evaluating it would need
 * the module's scope and would answer a different question.
 */
export function splitArguments(source, open) {
  const close = matchBracket(source, open);
  if (close === -1 || source[open] !== "(") return null;

  const args = [];
  let start = open + 1;
  let i = open + 1;
  while (i < close) {
    const skipped = skipNonCode(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = source[i];
    if (CLOSING[ch] !== undefined) {
      const inner = matchBracket(source, i);
      if (inner === -1) return null;
      i = inner + 1;
      continue;
    }
    if (ch === ",") {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  const last = source.slice(start, close).trim();
  // `f(a, b,)` is two arguments and a trailing comma, not three.
  if (last !== "") args.push(last);
  return args;
}

/**
 * Every call to `callee` in `source`, as `{ index, args }`.
 *
 * Only real call sites: a mention inside a comment or a string is skipped, a
 * property call (`x.callee(…)`) is not this function, and a longer identifier
 * that merely ends in the name (`buildCallee(…)`) is not either.
 */
export function callSites(source, callee) {
  const sites = [];
  let i = 0;
  while (i < source.length) {
    const skipped = skipNonCode(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (!IDENT.test(source[i])) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < source.length && IDENT.test(source[end])) end += 1;
    const word = source.slice(i, end);
    const before = i === 0 ? "" : source[i - 1];
    if (word === callee && before !== "." && !IDENT.test(before)) {
      let paren = end;
      while (paren < source.length && /\s/.test(source[paren])) paren += 1;
      if (source[paren] === "(") {
        const args = splitArguments(source, paren);
        if (args !== null) sites.push({ index: i, args });
      }
    }
    i = end;
    continue;
  }
  return sites;
}

/**
 * True when `index` is ordinary code rather than a character inside a comment,
 * a string or a template literal.
 *
 * Every locator here runs its regex through this. Without it, the sentence
 * "export async function GET" in the doc comment above a handler is a perfectly
 * good match, and the scan then balances braces starting from the middle of a
 * paragraph — which is the same class of answer as `slice(-1)`: confident,
 * cheap and about the wrong bytes.
 */
export function isCodePosition(source, index) {
  let i = 0;
  while (i < source.length && i <= index) {
    const skipped = skipNonCode(source, i);
    if (skipped !== i) {
      if (index < skipped) return false;
      i = skipped;
      continue;
    }
    if (i === index) return true;
    i += 1;
  }
  return i === index;
}

/** The first match of `pattern` that is real code, or null. */
function firstCodeMatch(source, pattern) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of source.matchAll(global)) {
    if (isCodePosition(source, match.index)) return match;
  }
  return null;
}

/**
 * The parameter list of a `const NAME = (…) => …` / `function NAME(…)`
 * declaration, as trimmed source text, or null.
 *
 * This is how a caller checks a positional argument WITHOUT memorising the
 * position: read the parameter names out of the declaration, find the one you
 * mean, and index the call sites by that. A reordered signature then fails
 * loudly instead of silently reading the wrong column — which is the difference
 * between a check and a coincidence.
 */
export function declaredParameters(source, name) {
  const patterns = [
    new RegExp(`(?:^|[^\\w$.])(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`),
  ];
  for (const pattern of patterns) {
    const match = firstCodeMatch(source, pattern);
    if (match === null) continue;
    const open = source.indexOf("(", match.index + match[0].length - 1);
    if (open === -1) continue;
    const args = splitArguments(source, open);
    if (args !== null) return args;
  }
  return null;
}

/**
 * The full source text of an exported binding, from `export` to the end of its
 * body, or null if no such export is written in this file.
 *
 * Both forms are found, because both are used in this repository and nothing
 * chooses between them — there is no ESLint config in the repo at all:
 *
 *   export async function GET(): Promise<Response> { … }
 *   export const GET = async (): Promise<Response> => { … }
 *   export const GET = withAuth(async () => { … });
 *
 * The returned text STOPS at the end of the binding. The old code sliced to the
 * end of the file, so an assertion about "the GET handler" was really an
 * assertion about the handler plus every export written below it.
 */
export function exportedBinding(source, name) {
  const asDeclaration = firstCodeMatch(source, new RegExp(`(?:^|\\n)[ \\t]*export\\s+(?:async\\s+)?function\\s+${name}\\b`));
  const asAssignment = firstCodeMatch(source, new RegExp(`(?:^|\\n)[ \\t]*export\\s+(?:const|let|var)\\s+${name}\\b`));
  const match = asDeclaration ?? asAssignment;
  if (match === null) return null;

  const start = source.indexOf("export", match.index);

  // For `export const NAME: SomeType<{ a: string }> = …` the first `{` belongs
  // to the type annotation, not to the body, so scanning for the body starts
  // after the top-level `=`. A function declaration has no `=` to find.
  let from = start;
  if (asDeclaration === null) {
    const equals = topLevelAssignment(source, start);
    if (equals === -1) return null;
    from = equals + 1;
  }

  let i = from;
  while (i < source.length) {
    const skipped = skipNonCode(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = source[i];
    if (ch === "(" || ch === "[") {
      const close = matchBracket(source, i);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (ch === "{") {
      const close = matchBracket(source, i);
      if (close === -1) return null;
      return { start, end: close + 1, text: source.slice(start, close + 1) };
    }
    // A concise arrow body (`export const GET = () => Response.json(…);`) has no
    // block at all; it ends at its semicolon.
    if (ch === ";") return { start, end: i + 1, text: source.slice(start, i + 1) };
    i += 1;
  }
  return null;
}

/** Index of the `=` that assigns this declaration, skipping `==`, `=>` and `!=`. */
function topLevelAssignment(source, start) {
  let i = start;
  while (i < source.length) {
    const skipped = skipNonCode(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = source[i];
    if (CLOSING[ch] !== undefined) {
      const close = matchBracket(source, i);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (ch === ";") return -1; // the declaration ended without assigning anything
    if (ch === "=" && source[i + 1] !== "=" && source[i + 1] !== ">" && !"=!<>+-*/%&|^".includes(source[i - 1])) {
      return i;
    }
    i += 1;
  }
  return -1;
}
