import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  // Export goes to out/ (Next default). Deliberately NOT distDir:"dist" —
  // that setting also becomes the dev working dir, and dev artifacts would
  // ship inside the published site.
  // Static export has no image optimizer; scripts/optimize-images.mjs pre-bakes AVIF/WebP.
  images: { unoptimized: true },
  transpilePackages: ["three"],
  reactStrictMode: true,
};

export default config;
