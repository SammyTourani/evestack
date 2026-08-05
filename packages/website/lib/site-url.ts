/* The canonical origin, resolved once.

   NEXT_PUBLIC_SITE_URL is set on Vercel for production and preview. The
   VERCEL_URL fallback covers deployments that predate it (and any new
   environment where someone forgets), so absolute URLs degrade to the correct
   deployment rather than to localhost — the failure mode that once shipped an
   og:image pointing at http://localhost:3000. */
export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
