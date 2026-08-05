import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-url";

/* Without this the site served no /robots.txt at all. Crawlers default to
   "allowed" on a 404, so nothing was blocked — but there was also nowhere to
   advertise the sitemap, which is the only way the 18 docs pages get found
   without a full link crawl. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
