import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

const config: NextConfig = {
  /* Vercel gets a real Next app; everywhere else still static-exports.
     `VERCEL` is set by their build image, so one config serves both targets
     and GitHub Pages keeps working as a fallback. Export is what forbids
     headers() and redirects() — the two things worth having on Vercel. */
  output: process.env.VERCEL ? undefined : "export",
  // GitHub Pages serves at /<repo>; CI sets NEXT_PUBLIC_BASE_PATH=/evestack.
  // Unset in dev so localhost:3000 and every QA script keep root paths.
  // Raw <img>/<a> URLs that bypass Next go through lib/asset.ts withBase().
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  // Export goes to out/ (Next default). Deliberately NOT distDir:"dist" —
  // that setting also becomes the dev working dir, and dev artifacts would
  // ship inside the published site.
  // Static export has no image optimizer; scripts/optimize-images.mjs pre-bakes AVIF/WebP.
  images: { unoptimized: true },
  transpilePackages: ["three"],
  reactStrictMode: true,
};

/* Compiles the repo-root docs/ tree (see source.config.ts) into the .source
   bundle the /docs route loads. */
export default createMDX()(config);
