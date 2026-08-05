import { compatHtml } from "./compat.generated";

/**
 * The public eve-compatibility matrix, served at /compat.
 *
 * It is a self-contained HTML document produced by contract/render-compat.mjs
 * from the committed reports in contract/history/ — no external CSS, JS, fonts
 * or images — so it is returned verbatim rather than rebuilt as React. The page
 * has to stay droppable onto any static host, and re-implementing it in JSX
 * would create a second renderer that can disagree with the first.
 *
 * force-static so the generated string is baked at build time: nothing is read
 * from disk at request time, and the route costs the same as a static file.
 */
export const dynamic = "force-static";

export function GET() {
  return new Response(compatHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The matrix changes only when a contract run is recorded, which is a
      // deploy. Cached at the edge, revalidated on each deploy like the rest
      // of the site.
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
