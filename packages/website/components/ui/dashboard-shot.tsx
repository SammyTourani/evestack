import { withBase } from "@/lib/asset";

/* Real dashboard capture, theme-paired. Explicit dimensions → zero CLS.
   Plain <img> — static export runs images.unoptimized anyway; AVIF/WebP
   pre-baked by scripts/optimize-images.mjs. */
export function DashboardShot({
  name,
  width,
  height,
  alt,
  className,
  eager = false,
}: {
  /** base filename, e.g. "session-detail" → session-detail-{dark,light}@2x.{avif,webp} */
  name: string;
  width: number;
  height: number;
  alt: string;
  className?: string;
  eager?: boolean;
}) {
  const img = (theme: "dark" | "light", visibility: string) => (
    <picture className={visibility}>
      <source srcSet={withBase(`/screenshots/${name}-${theme}@2x.avif`)} type="image/avif" />
      <source srcSet={withBase(`/screenshots/${name}-${theme}@2x.webp`)} type="image/webp" />
      <img
        src={withBase(`/screenshots/${name}-${theme}@2x.webp`)}
        width={width}
        height={height}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        className={className}
      />
    </picture>
  );
  return (
    <>
      {img("dark", "hidden dark:block")}
      {img("light", "block dark:hidden")}
    </>
  );
}
