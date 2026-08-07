/**
 * A route handler must never build a redirect out of the address it is BOUND to.
 *
 * `request.url` in Next is constructed from the bind address, and the Dockerfile
 * runs `next start --hostname 0.0.0.0`. So inside the shipped container
 * `new URL("/", request.url)` is `http://0.0.0.0:4000/` — a URL no browser can
 * come back to. Middleware is exempt in practice, because Next rewrites a
 * middleware redirect to a relative Location; a route handler emits exactly the
 * absolute URL it was given.
 *
 * What it cost, measured on the published 0.1.0 image: sign in with the CORRECT
 * password, receive a valid cookie, and get 303'd to `http://0.0.0.0:4000/`.
 * Followed the way a browser follows it, the final status is **401 Not signed
 * in** — the cookie was issued for the host the user was on, 0.0.0.0 is a
 * different origin, so it never comes back. Sign-out and the sign-in error path
 * had it too, and `integrations/connect` handed the same bind address to Composio
 * as an OAuth callback, so authorising Gmail returned the user to nowhere.
 *
 * A typecheck cannot see any of this: every one of those lines was valid
 * TypeScript against a correct Next API. Nor can a unit test on lib/auth.ts,
 * because the defect was in the callers. So this reads the shipped source.
 *
 * Two things are allowed, and only two:
 *   - a RELATIVE Location for a redirect to this same origin, which the browser
 *     resolves against the URL it actually dialled;
 *   - `publicOrigin(request)` where an ABSOLUTE url is genuinely required, which
 *     reads the request's own host instead of the socket's.
 *
 * ── Why this is a parser and not two regexes ─────────────────────────────────
 *
 * It was two regexes, and a check that forbids a spelling is only worth what it
 * cannot be written around. Those two matched `new URL("/signin", request.url)`
 * and nothing else. Every one of these got past them, and each is a line someone
 * would write without thinking twice:
 *
 *     new URL(`/sessions/${encodeURIComponent(id)}`, request.url)  // `)` inside arg 1
 *     new URL("/signin", req.url)                                  // parameter named req
 *     const u = new URL(request.url); u.origin                     // two steps
 *     new URL(request.url).host                                    // .host, not .origin
 *     const { url } = request; new URL("/signin", url)             // destructured
 *     NextResponse.redirect(new URL(safeNextPath(p), request.url))  // nested call
 *     const parsed = URL.parse(request.url); parsed.host           // URL.parse
 *     const b = new URL(request.url); new URL("/signin", b)        // laundered base
 *
 * A guard with that many ways round it is not a guard. So the argument list of
 * every `new URL(...)` and `URL.parse(...)` is now extracted by counting
 * brackets and skipping string literals, the identifiers that hold the bind
 * address are tracked through aliasing, and the accessors that leak it
 * (`origin`, `host`, `hostname`, `protocol`, `port`) are named explicitly while
 * `searchParams` and `pathname` stay as legal as they have always been.
 *
 * The suite asserts the detector against every shape above, on the way past. A
 * guard whose own coverage is never tested is the thing being fixed here, and it
 * would rot the same way twice otherwise.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { REPO_ROOT } from "../lib/repo.mjs";

/**
 * Every place in the dashboard that can hold a request handler.
 *
 * app/ alone was the original scope, and it was the wrong scope twice over.
 * `publicOrigin` and `isSecureRequest` live in lib/auth.ts and read the bind
 * address there, so the file that documents this rule was the one file never
 * checked against it. And proxy.ts — the middleware, the one file the old
 * exemption named — is not under app/ at all: it sits at the package root, where
 * Next expects it, so the exemption was inert and nobody could tell. Both of
 * those reads are correct and are exempted BY PATH below. The point of widening
 * the scope is that the exemptions are decisions on the record rather than
 * directories this contract happened not to open.
 */
const SCAN_TARGETS = [
  // Depth 0 only: proxy.ts and next.config.ts, not app/ and lib/ twice over.
  { dir: join("packages", "dashboard"), recursive: false },
  { dir: join("packages", "dashboard", "app"), recursive: true },
  { dir: join("packages", "dashboard", "lib"), recursive: true },
];

/**
 * The two offences, separate because they are exempted separately: permission to
 * READ the bind address as a last resort is not permission to REDIRECT to it.
 */
const REDIRECT_TARGET = {
  id: "redirect-target",
  why: "resolves a path against the bind address; return a relative Location instead",
};
const BIND_ADDRESS_READ = {
  id: "bind-address-read",
  why: "reads the bind address as an origin; use publicOrigin(request) from @/lib/auth",
};

/**
 * Exempt by repo-relative PATH, and only from the offence named.
 *
 * The previous exemption was the basename `proxy.ts`, matched anywhere in the
 * tree — so a future `app/api/whatever/proxy.ts` would have inherited middleware's
 * exemption silently, which is precisely the accident this contract exists to
 * stop. A path cannot be inherited by accident.
 *
 *   proxy.ts       Middleware, at the package root because that is where Next
 *                  looks for it. Next relativizes its redirect for us, verified
 *                  on the published image (`location: /signin?next=%2Fsessions`),
 *                  so the `new URL("/signin", request.url)` behind its 303 is the
 *                  one place that spelling is not a bug.
 *   lib/auth.ts    `expectedHosts`, `publicOrigin` and `isSecureRequest` are where
 *                  the last-resort read is SUPPOSED to live: after
 *                  EVESTACK_PUBLIC_URL, after the Host header, for a runtime that
 *                  sends no Host at all. Exempt from reading the bind address.
 *                  NOT exempt from redirecting to it — that has no correct use
 *                  anywhere, including here.
 */
const EXEMPT = new Map([
  [join("packages", "dashboard", "proxy.ts"), new Set([REDIRECT_TARGET.id, BIND_ADDRESS_READ.id])],
  [join("packages", "dashboard", "lib", "auth.ts"), new Set([BIND_ADDRESS_READ.id])],
]);

function sourceFiles(dir, recursive, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) sourceFiles(full, recursive, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Code with comments removed, and every remaining line still on its own line.
 *
 * Needed because this contract's own first version failed on the very files it
 * had just fixed: the fix carries a comment saying "never write
 * `new URL(path, request.url)`", and a check over raw source cannot tell an
 * instruction not to do something from doing it. A check that forbids a spelling
 * has to read code, not prose.
 *
 * Block comments become the newlines they spanned and a comment line becomes an
 * empty one, rather than both being deleted outright — that is new, and it is
 * what makes the line number in a finding the line number in the file. The
 * earlier version reported positions in a text with the comments cut out, which
 * in a file like lib/auth.ts is a hundred lines away from the code it names.
 *
 * Deliberately not attempting to strip a trailing comment after code: doing that
 * correctly requires knowing whether a `//` sits inside a string literal, and
 * `"http://…"` is common enough here that a naive cut would corrupt the code it
 * was meant to clean.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => "\n".repeat((block.match(/\n/g) ?? []).length))
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("*") || trimmed.startsWith("//") ? "" : line;
    })
    .join("\n");
}

/** Reads of these leak the socket's address. `searchParams` and `pathname` do not. */
const HOSTISH = /^(?:origin|host|hostname|protocol|port)$/;

/** Past the end of a string or template literal, `${…}` and nesting included. */
function skipLiteral(code, at) {
  const quote = code[at];
  let i = at + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === "`" && ch === "$" && code[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < code.length && depth > 0) {
        const inner = code[i];
        if (inner === '"' || inner === "'" || inner === "`") {
          i = skipLiteral(code, i);
          continue;
        }
        if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return code.length;
}

/**
 * The arguments of the call whose `(` is at `open`, split on TOP-LEVEL commas.
 *
 * Brackets are counted and string literals are skipped, which is the whole
 * reason this is not a regex: the argument that hides the bug is routinely a
 * template literal with a call inside it, and `[^)]*?` stops at the first `)`
 * it meets — including the one belonging to `encodeURIComponent(id)`.
 */
function argumentList(code, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let i = open;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteral(code, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const last = code.slice(start, i).trim();
        if (last !== "" || args.length > 0) args.push(last);
        return { args, end: i };
      }
      i += 1;
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(code.slice(start, i).trim());
      start = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  // Unbalanced source is a compile error, not a redirect bug. Nothing to say.
  return null;
}

/**
 * Names that hold the bind address because someone copied it out of the request.
 *
 * `const { url } = request` and `const url = request.url` both put `0.0.0.0:4000`
 * into a plain identifier, and every check that only knows the spelling
 * `request.url` is blind from that line on.
 *
 * Scope-blind on purpose: a name that holds the bind address anywhere in a file
 * is treated as holding it everywhere in that file. Following scopes properly
 * means a TypeScript AST, and the trade is the right way round — a false positive
 * costs one rename, and the false negative it prevents is the bug this whole file
 * exists for.
 */
function bindAddressNames(code) {
  const names = new Set();
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:request|req)\s*\.\s*url\b/g,
  )) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s*\{[^{}]*?\burl\b\s*(?::\s*([A-Za-z_$][\w$]*))?[^{}]*\}\s*=\s*(?:request|req)\b/g,
  )) {
    names.add(m[1] ?? "url");
  }
  return names;
}

function isBindAddress(expression, names) {
  const text = expression.trim();
  if (/^(?:request|req)\s*\.\s*url$/.test(text)) return true;
  return names.has(text);
}

/** `const NAME = new URL(...)` — the left-hand side, when there is one. */
function declaredName(code, index) {
  const before = code.slice(Math.max(0, index - 200), index);
  return /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(before)?.[1] ?? null;
}

/** `const { origin, host } = new URL(...)` — the keys, when it is destructured. */
function destructuredKeys(code, index) {
  const before = code.slice(Math.max(0, index - 200), index);
  const braces = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?$/.exec(before);
  if (!braces) return [];
  return braces[1]
    .split(",")
    .map((part) => part.split(":")[0].trim())
    .filter(Boolean);
}

/** `.origin` / `?.host` read straight off the closing paren. */
function accessorAfter(code, end) {
  const read = /^\s*\??\s*\.\s*([A-Za-z_$][\w$]*)/.exec(code.slice(end + 1));
  return read && HOSTISH.test(read[1]) ? read[1] : null;
}

function readsHostish(code, name) {
  return new RegExp(`\\b${name}\\s*\\??\\s*\\.\\s*(?:origin|host|hostname|protocol|port)\\b`).test(
    code,
  );
}

/**
 * Every offence in one file's source, with the line it is on.
 *
 * Exported shape rather than a boolean because the failure message has to name
 * the line and the spelling; "something in this directory is wrong" sends the
 * reader to grep.
 */
export function offences(source) {
  const code = codeOnly(source);
  const aliases = bindAddressNames(code);

  const sites = [];
  for (const m of code.matchAll(/\bnew\s+URL\s*\(|\bURL\s*\.\s*parse\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const parsed = argumentList(code, open);
    if (parsed) sites.push({ index: m.index, args: parsed.args, end: parsed.end });
  }

  // A URL object built FROM the bind address is the bind address. `const u = new
  // URL(request.url)` followed by `new URL(path, u)` is the original bug with an
  // extra line in front of it.
  const parsedFromBindAddress = new Set();
  for (const site of sites) {
    if (site.args.length === 1 && isBindAddress(site.args[0], aliases)) {
      const name = declaredName(code, site.index);
      if (name) parsedFromBindAddress.add(name);
    }
  }
  const isBase = (expression) => {
    const text = expression.trim();
    if (isBindAddress(text, aliases)) return true;
    return parsedFromBindAddress.has(text.replace(/\s*\.\s*(?:href|toString\(\))$/, ""));
  };

  const found = [];
  for (const site of sites) {
    const at = {
      line: code.slice(0, site.index).split("\n").length,
      code: code.slice(site.index, site.end + 1).replace(/\s+/g, " "),
    };

    if (site.args.length > 1 && isBase(site.args[site.args.length - 1])) {
      found.push({ ...at, offence: REDIRECT_TARGET });
      continue;
    }
    if (site.args.length === 1 && isBindAddress(site.args[0], aliases)) {
      const name = declaredName(code, site.index);
      const leaks =
        accessorAfter(code, site.end) !== null ||
        (name !== null && readsHostish(code, name)) ||
        destructuredKeys(code, site.index).some((key) => HOSTISH.test(key));
      if (leaks) found.push({ ...at, offence: BIND_ADDRESS_READ });
    }
  }
  return found;
}

/**
 * The detector's own coverage, asserted every run.
 *
 * Each `catches` entry is a shape that got past the two regexes this replaced.
 * Each `allows` entry is a spelling that has to stay legal, because a guard that
 * fails them is one someone routes around instead of obeying — reading a query
 * string works whatever the host is, and `publicOrigin(request)` is the whole
 * point of the fix.
 */
const DETECTOR_CASES = [
  {
    catches: true,
    name: 'new URL("/signin", request.url)',
    source: 'return NextResponse.redirect(new URL("/signin", request.url));',
  },
  {
    catches: true,
    name: "a template literal containing a `)`",
    source: "return NextResponse.redirect(new URL(`/sessions/${encodeURIComponent(id)}`, request.url));",
  },
  {
    catches: true,
    name: "a parameter named req rather than request",
    source: 'return NextResponse.redirect(new URL("/signin", req.url));',
  },
  {
    catches: true,
    name: "the two-step `const u = new URL(request.url); u.origin`",
    source: "const u = new URL(request.url);\nreturn Response.redirect(`${u.origin}/integrations`, 303);",
  },
  {
    catches: true,
    name: "new URL(request.url).host — .host rather than .origin",
    source: 'const allowed = new URL(request.url).host === "localhost:4000";',
  },
  {
    catches: true,
    name: "a destructured `const { url } = request`",
    source: 'const { url } = request;\nreturn NextResponse.redirect(new URL("/signin", url));',
  },
  {
    catches: true,
    name: "NextResponse.redirect(new URL(safeNextPath(p), request.url))",
    source: "return NextResponse.redirect(new URL(safeNextPath(next), request.url));",
  },
  {
    catches: true,
    name: "URL.parse(request.url) read for a host",
    source: "const parsed = URL.parse(request.url);\nif (parsed?.host) hosts.push(parsed.host);",
  },
  {
    catches: true,
    name: "a URL object reused as the base",
    source: 'const base = new URL(request.url);\nreturn NextResponse.redirect(new URL("/signin", base));',
  },
  {
    catches: true,
    name: "a destructured origin",
    source: "const { origin } = new URL(request.url);\nreturn Response.redirect(`${origin}/`, 303);",
  },
  {
    catches: false,
    name: "new URL(request.url).searchParams",
    source: 'const format = new URL(request.url).searchParams.get("format");',
  },
  {
    catches: false,
    name: "the two-step search-params read every route does",
    source: 'const url = new URL(request.url);\nconst limit = url.searchParams.get("limit");',
  },
  {
    catches: false,
    name: "a relative Location",
    source: "return new Response(null, { status: 303, headers: { location: safeNextPath(next) } });",
  },
  {
    catches: false,
    name: "publicOrigin(request) for an absolute url",
    source: "return Response.redirect(`${publicOrigin(request)}/integrations?connected=1`, 303);",
  },
  {
    catches: false,
    name: "a comment that names the forbidden spelling",
    source:
      "// Never new URL(path, request.url) — see the note in lib/auth.ts.\n" +
      'const url = new URL(request.url);\nurl.searchParams.get("next");',
  },
  {
    catches: false,
    name: "a base that is not the bind address",
    source: 'const target = new URL(next, "https://evestack.example");',
  },
];

const noBindAddressRedirects = {
  id: "dashboard/redirects-never-name-the-bind-address",
  title: "no route handler builds a redirect or callback url from request.url",
  assumption:
    "A redirect out of a Next route handler is emitted with exactly the Location it was given, and " +
    "`request.url` is built from the address the server is bound to.",
  evestackUse:
    "The Dockerfile runs `next start --hostname 0.0.0.0`, so every absolute URL a route handler derives " +
    "from `request.url` names 0.0.0.0 inside the shipped image. Measured on the published 0.1.0: signing " +
    "in with the CORRECT password 303'd to http://0.0.0.0:4000/ and answered 401 Not signed in, because " +
    "the cookie was issued for the host the user was actually on. Sign-out and the sign-in error path had " +
    "it too, and integrations/connect handed the same value to Composio as an OAuth callback. All of it " +
    "typechecked against a correct Next API, which is why this is a contract and not a type. app/ and " +
    "lib/ are both read, and the two files allowed to touch the bind address are exempted by path and " +
    "by which offence they are allowed — not by basename.",

  async check(eve, t) {
    // The guard's own coverage first. Every one of these shapes was a live hole
    // in the version this replaced, so they are assertions rather than a comment
    // claiming they are handled.
    for (const { catches, name, source } of DETECTOR_CASES) {
      const hits = offences(source);
      t.ok(catches ? hits.length > 0 : hits.length === 0, `detector ${catches ? "flags" : "allows"}: ${name}`, {
        expected: catches ? "flagged" : "not flagged",
        actual: hits.length > 0 ? hits.map((hit) => hit.offence.id).join(", ") : "nothing flagged",
      });
    }

    // An exemption for a file that has moved is a stale record, and the reader
    // of this file would take it for a live decision.
    for (const path of EXEMPT.keys()) {
      t.ok(existsSync(join(REPO_ROOT, path)), `the exemption for \`${path}\` still names a real file`, {
        expected: `${path} on disk`,
        actual: "missing",
      });
    }

    const found = [];
    for (const { dir, recursive } of SCAN_TARGETS) {
      for (const file of sourceFiles(join(REPO_ROOT, dir), recursive)) {
        const path = relative(REPO_ROOT, file);
        const allowed = EXEMPT.get(path);
        for (const hit of offences(readFileSync(file, "utf8"))) {
          if (allowed?.has(hit.offence.id)) continue;
          found.push(`${path}:${hit.line} — ${hit.code} (${hit.offence.why})`);
        }
      }
    }

    t.ok(found.length === 0, "no dashboard module resolves a redirect target or an origin against request.url", {
      ...(found.length === 0 ? {} : { actual: found.join("\n            ") }),
    });

    // The positive half. A contract that only forbids a spelling passes just as
    // happily on a file that stopped redirecting at all, so require that the
    // sign-in route still answers with a location and that it is a bare path.
    const signIn = codeOnly(
      readFileSync(
        join(REPO_ROOT, "packages", "dashboard", "app", "api", "auth", "session", "route.ts"),
        "utf8",
      ),
    );
    t.ok(
      /headers:\s*\{\s*location\b/.test(signIn) || /location:\s*"\//.test(signIn),
      "the sign-in route still sets a Location, and sets it to a path",
    );
    t.ok(
      /safeNextPath/.test(signIn),
      "and still passes the destination through safeNextPath, so a relative Location cannot jump hosts",
    );
  },
};

export default [noBindAddressRedirects];
