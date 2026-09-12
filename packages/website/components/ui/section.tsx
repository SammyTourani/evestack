import { cn } from "@/lib/utils";

export function Section({
  id,
  className,
  containerClassName,
  labelledBy,
  rule = true,
  children,
}: {
  id: string;
  className?: string;
  containerClassName?: string;
  /** id of the heading element inside; defaults to `${id}-heading` */
  labelledBy?: string;
  /** hairline top border between sections */
  rule?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy ?? `${id}-heading`}
      className={cn("scroll-mt-16 py-14 md:py-20", rule && "section-rule", className)}
    >
      <div className={cn("site-container", containerClassName)}>{children}</div>
    </section>
  );
}

/** Centered h2 + subcopy block used by most sections. */
export function SectionHeading({
  id,
  title,
  sub,
  eyebrow,
  align = "center",
}: {
  id: string;
  title: string;
  sub?: string;
  /** mono index marker, e.g. "01" — quiet Vercel-style section numbering */
  eyebrow?: string;
  align?: "center" | "left";
}) {
  return (
    <div
      className={cn(
        /* py-14/mb-10 below md, and today's exact py-20/mb-14 from md up. The
           rhythm was set for a 1440px canvas: at 393pt those two numbers alone
           spent ~430px — half a phone screen — on air between sections, on a
           page that was already 18 screens long. Nothing is removed, the
           spacing is just measured for the screen it is on. */
        "mb-10 flex flex-col gap-4 md:mb-14",
        align === "center" && "items-center text-center",
      )}
    >
      {eyebrow ? (
        <p aria-hidden className="flex items-center gap-3 font-mono text-label-12 uppercase text-gray-700">
          <span className="inline-block h-px w-6 bg-border-strong" />
          {eyebrow}
          {align === "center" ? <span className="inline-block h-px w-6 bg-border-strong" /> : null}
        </p>
      ) : null}
      <h2
        id={id}
        data-reveal="lines"
        className="max-w-3xl text-balance text-heading-32 md:text-heading-40"
      >
        {title}
      </h2>
      {sub ? (
        <p className={cn("max-w-2xl text-copy-16 text-gray-900", align === "center" && "text-balance")}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}
