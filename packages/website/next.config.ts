import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
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

export default config;
