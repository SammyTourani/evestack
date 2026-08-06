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
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { REPO_ROOT } from "../lib/repo.mjs";

const APP_DIR = join(REPO_ROOT, "packages", "dashboard", "app");

/**
 * proxy.ts is deliberately not scanned: it is middleware, Next relativizes its
 * redirect for us, and it was verified doing so on the published image
 * (`location: /signin?next=%2Fsessions`). It is listed here rather than simply
 * being outside APP_DIR so that the exemption is a decision on the record.
 */
const EXEMPT = new Set(["proxy.ts"]);

function routeFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !EXEMPT.has(entry.name)) out.push(full);
  }
  return out;
}

/**
 * A redirect target built from `request.url`.
 *
 * Deliberately narrow. `new URL(request.url).searchParams` is fine and common —
 * reading a query string works whatever the host is — so this looks for the two
 * shapes that put the bind address into something a browser or a third party is
 * sent to: a second argument of `request.url` to the URL constructor, and
 * `.origin` read off it.
 */
const OFFENDERS = [
  {
    pattern: /new URL\(\s*[^)]*?,\s*request\.url\s*\)/g,
    why: "resolves a path against the bind address; return a relative Location instead",
  },
  {
    pattern: /new URL\(\s*request\.url\s*\)\s*\.origin/g,
    why: "reads the bind address as an origin; use publicOrigin(request) from @/lib/auth",
  },
];

/**
 * Code with comments removed.
 *
 * Needed because this contract's own first version failed on the very files it
 * had just fixed: the fix carries a comment saying "never write
 * `new URL(path, request.url)`", and a regex over raw source cannot tell an
 * instruction not to do something from doing it. A check that forbids a spelling
 * has to read code, not prose.
 *
 * Block comments go first, then any line whose content begins with `*` or `//` —
 * which is every comment shape in this repo. Deliberately not attempting to strip
 * a trailing comment after code: doing that correctly requires knowing whether a
 * `//` sits inside a string literal, and `"http://…"` is common enough here that
 * a naive cut would corrupt the code it was meant to clean.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//");
    })
    .join("\n");
}

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
    "typechecked against a correct Next API, which is why this is a contract and not a type.",

  async check(eve, t) {
    const files = routeFiles(APP_DIR);
    const found = [];
    for (const file of files) {
      const source = codeOnly(readFileSync(file, "utf8"));
      for (const { pattern, why } of OFFENDERS) {
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index).split("\n").length;
          found.push(`${relative(REPO_ROOT, file)}:${line} — ${match[0].replace(/\s+/g, " ")} (${why})`);
        }
      }
    }

    t.ok(found.length === 0, "no route module resolves a redirect target against request.url", {
      ...(found.length === 0 ? {} : { actual: found.join("\n            ") }),
    });

    // The positive half. A contract that only forbids a spelling passes just as
    // happily on a file that stopped redirecting at all, so require that the
    // sign-in route still answers with a location and that it is a bare path.
    const signIn = codeOnly(
      readFileSync(join(APP_DIR, "api", "auth", "session", "route.ts"), "utf8"),
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
