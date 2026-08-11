/**
 * Every path this repo points a reader at must exist.
 *
 * This contract exists because the failure it catches kept happening and was
 * always found by a human reading, never by a machine:
 *
 *   - `llms.txt` — the file published specifically so that language models index
 *     evestack accurately — advertised `docs/compatibility.mdx`, a rendered
 *     `/compat` page, and `contract/history/*.json` for hours after all three
 *     were deleted. It also never listed `docs/proactive.mdx`, which did exist.
 *   - `contract/README.md`, `contract/run.mjs` and `contract/lib/eve.mjs` all
 *     referenced `contract/record.mjs`, which is not in the repository.
 *   - The commit that was supposed to finish this cleanup is titled "Drop the
 *     last reference to the removed compat-page workflow". It was not the last
 *     reference. Nobody grepped.
 *
 * Every one of those is a `readdirSync` away from being caught, so the honest
 * fix is not another careful cleanup pass — it is this file.
 *
 * Scope is `repo`: it describes this checkout, not eve, so certifying an
 * arbitrary eve release must skip it rather than fail it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo.mjs";

/** Documents that carry links a stranger or a crawler will follow. */
const LINK_SOURCES = ["llms.txt", "README.md", "RELEASING.md", "contract/README.md"];

/**
 * Repo-relative paths appearing in prose. Deliberately narrow: it matches paths
 * under directories this repo owns and that end in a real file extension, so a
 * sentence like "see contract/" or a glob like `registry/r/{name}.json` is not
 * mistaken for a promise about one file.
 *
 * The leading lookbehind is load-bearing. `\b` matches immediately after a `/`,
 * so without it the first version of this contract read
 * `node_modules/eve/docs/patterns/multi-tenant-memory.md` — a file that ships
 * inside eve and is correctly cited by both llms.txt and README.md — as a
 * broken repo link, and reported two failures against documentation that was
 * right. A path is only this repo's promise when it starts a path.
 */
const PATH_PATTERN =
  /(?<![A-Za-z0-9._/-])((?:docs|packages|contract|templates|registry|scripts|\.github)\/[A-Za-z0-9._/-]*\.[a-z]{2,4})\b/g;

/**
 * Root-level files, which the pattern above cannot see.
 *
 * It requires a known directory to start the path, so every file at the
 * repository root — CHANGELOG.md, SECURITY.md, RELEASING.md, llms.txt — was
 * invisible to this contract. Measured: pointing README.md's own
 * `[CHANGELOG.md](./CHANGELOG.md)` at a file that does not exist left the suite
 * green. The contract's opening sentence promises every documented path exists,
 * and it was checking a subset without saying so.
 *
 * Anchored on the markdown LINK form rather than on bare words, because a bare
 * `CHANGELOG.md` in prose is a mention and `](./CHANGELOG.md)` is a promise the
 * reader can click. The absence of a slash is what makes it root-level; anything
 * with one is either already covered above or an external URL, and a URL cannot
 * match `[A-Za-z][A-Za-z0-9._-]*` past its scheme colon.
 */
const ROOT_LINK_PATTERN = /\]\((?:\.\/)?([A-Za-z][A-Za-z0-9._-]*\.[a-z]{2,4})\)/g;

/** Paths that legitimately do not resolve on disk. */
const EXEMPT = new Set([
  // Written by `pnpm install`, never committed.
  "packages/create-evestack/template/package.json",
]);

/** A `{name}` style placeholder is a URL template, not a path. */
const isTemplate = (path) => path.includes("{") || path.includes("*");

/** Raw-content URLs for this repo's own `main`; the tail is a repo path. */
const RAW_PREFIX =
  /https:\/\/raw\.githubusercontent\.com\/SammyTourani\/evestack\/main\//g;

/**
 * Two normalisations, both needed, and they pull in opposite directions.
 *
 * llms.txt cites its pages as absolute raw URLs, so the repo path sits *after*
 * a `/` and only counts once the prefix is stripped. Meanwhile prose cites
 * files inside the installed eve package as `node_modules/eve/docs/...`, and
 * those must not be read as promises about this checkout. Stripping the first
 * and deleting the second is what separates them; doing neither, or only one,
 * produces confident failures against documentation that is correct.
 */
function linksIn(file) {
  const full = join(REPO_ROOT, file);
  if (!existsSync(full)) return [];
  const text = readFileSync(full, "utf8")
    .replace(RAW_PREFIX, "")
    .replace(/\bnode_modules\/\S*/g, "");
  const prefixed = text.match(PATH_PATTERN) ?? [];
  const rootLevel = [...text.matchAll(ROOT_LINK_PATTERN)].map((m) => m[1]);
  return [...new Set([...prefixed, ...rootLevel])].filter(
    (path) => !isTemplate(path) && !EXEMPT.has(path),
  );
}

export default {
  id: "docs/every-documented-path-exists",
  title: "every repo path named in llms.txt, the READMEs and RELEASING.md is on disk",
  scope: "repo",
  assumption:
    "A path written into prose is a promise that the file is there. llms.txt in particular is " +
    "consumed by machines that cannot tell a stale link from a live one.",
  evestackUse:
    "llms.txt advertised docs/compatibility.mdx, /compat and contract/history/*.json after all " +
    "three were deleted, and omitted docs/proactive.mdx which existed. contract/README.md, " +
    "contract/run.mjs and contract/lib/eve.mjs all pointed at contract/record.mjs, which is not " +
    "in the repository. Each was found by a person reading carefully; none by CI.",

  async check(_eve, t) {
    for (const source of LINK_SOURCES) {
      for (const path of linksIn(source)) {
        t.ok(
          existsSync(join(REPO_ROOT, path)),
          `${source} points at \`${path}\`, and it exists`,
          { expected: `${path} on disk`, actual: "missing" },
        );
      }
    }

    // The other direction. A docs page that nothing links to is invisible to
    // exactly the readers llms.txt exists to serve, which is how proactive.mdx
    // went unlisted.
    const onDisk = readdirSync(join(REPO_ROOT, "docs"))
      .filter((name) => name.endsWith(".mdx"))
      .map((name) => `docs/${name}`);
    const advertised = new Set(linksIn("llms.txt"));

    for (const page of onDisk) {
      t.ok(advertised.has(page), `llms.txt lists \`${page}\``, {
        expected: "listed in llms.txt",
        actual: "on disk but advertised nowhere",
      });
    }

    /*
     * The landing page's capability cards, which carry the same promise in a
     * stronger form. `packages/website/lib/copy.ts` says of them: "Each of these
     * is a shipped file, named so the claim is checkable." Nothing was checking
     * it — and the claim went stale the moment dashboard v2 turned app/page.tsx
     * from a session list into an overview, leaving the Session list card
     * pointing a reader at a file that renders something else.
     *
     * Existence only. Whether the file renders what the card SAYS is a judgement
     * no assertion can make; whether it is still there is exactly the part that
     * rots silently when a page is moved.
     */
    const copy = readFileSync(join(REPO_ROOT, "packages/website/lib/copy.ts"), "utf8");
    const sources = [...copy.matchAll(/^\s*source:\s*"([^"]+)"/gm)].map((m) => m[1]);

    // A capability list that silently emptied would pass every assertion below
    // by having none to make.
    t.ok(sources.length >= 4, `copy.ts still names ${sources.length} source files`, {
      expected: "at least 4",
      actual: String(sources.length),
    });

    for (const path of sources) {
      t.ok(
        existsSync(join(REPO_ROOT, path)),
        `the landing page's capability card points at \`${path}\`, and it exists`,
        { expected: `${path} on disk`, actual: "missing" },
      );
    }
  },
};
