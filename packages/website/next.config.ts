import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

/* Security headers. These are the concrete thing static export on GitHub
   Pages could not do at all — Pages serves no custom headers, so the site
   shipped with none. Deliberately no CSP yet: the hero runs WebGL through
   blob: workers and the theme script is inline, so a strict policy needs its
   own measured pass rather than a guess bolted onto a hosting migration. */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
];

const config: NextConfig = {
  /* No `output: "export"` and no basePath: the site is served from the root
     of a Vercel project, which is also what makes headers() below possible.
     Both settings existed only for GitHub Pages, which is retired. */
  images: {
    /* scripts/optimize-images.mjs already pre-bakes AVIF/WebP at the exact
       sizes the layout uses, so the optimizer would re-encode already-optimal
       files and spend transformations for nothing. */
    unoptimized: true,
  },
  transpilePackages: ["three"],
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

/* Compiles the repo-root docs/ tree (see source.config.ts) into the .source
   bundle the /docs route loads. */
export default createMDX()(config);
