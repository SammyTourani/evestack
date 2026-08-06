/* GitHub Pages serves the site under /<repo>. `basePath` in next.config
   rewrites next/link hrefs and every /_next asset automatically, but raw
   <img>/<source>/<a> URLs bypass Next — those few go through withBase().
   NEXT_PUBLIC_BASE_PATH is inlined at build time; empty in dev. */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const withBase = (path: string) => `${BASE_PATH}${path}`;
