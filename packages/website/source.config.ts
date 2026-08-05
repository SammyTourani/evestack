import { defineDocs, defineConfig } from "fumadocs-mdx/config";

/* Docs content lives at the REPO ROOT (../../docs), not inside this package —
   same arrangement eve itself uses. The website is only the renderer, so the
   docs stay editable (and reviewable) without knowing a Next app exists. */
export const docs = defineDocs({
  dir: "../../docs",
  /* Explicit globs: docs/ also holds a maintainer README.md (not a published
     page) and would otherwise publish it at /docs/README. Only .mdx is
     content, and only meta.json is navigation. */
  docs: { files: ["**/*.mdx"] },
  meta: { files: ["**/meta.json"] },
});

export default defineConfig();
