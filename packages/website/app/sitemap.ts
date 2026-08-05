import type { MetadataRoute } from "next";
import { source } from "@/lib/docs-source";
import { siteUrl } from "@/lib/site-url";

/* Enumerated from the docs source rather than hand-listed: a new .mdx file
   appears here the moment it appears in the sidebar, and a deleted one stops
   being advertised. A hand-written list is stale the first time someone adds a
   page and forgets. */
export default function sitemap(): MetadataRoute.Sitemap {
  const docs = source.getPages().map((page) => ({
    url: `${siteUrl}${page.url}`,
    changeFrequency: "weekly" as const,
    /* The docs index is the entry point; the rest are peers. */
    priority: page.url === "/docs" ? 0.8 : 0.6,
  }));

  return [
    { url: siteUrl, changeFrequency: "weekly", priority: 1 },
    ...docs,
  ];
}
