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
  return [...new Set(text.match(PATH_PATTERN) ?? [])].filter(
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
  },
};
