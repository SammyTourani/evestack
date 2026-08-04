import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

/* Pre-highlighted Shiki HTML in a filename-bar card. Server Component —
   zero client JS for syntax highlighting. */
export function CodeCard({
  filename,
  html,
  rawCode,
  badge,
  className,
}: {
  filename: string;
  html: string;
  rawCode: string;
  badge?: string;
  className?: string;
}) {
  return (
    <figure
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-default bg-background-200",
        className,
      )}
    >
      <figcaption className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4">
        <span className="flex items-center gap-2 truncate">
          <span className="font-mono text-mono-13 text-gray-900">{filename}</span>
          {badge ? (
            <span className="rounded-full border border-border-subtle px-2 py-0.5 font-mono text-label-12 text-gray-700">
              {badge}
            </span>
          ) : null}
        </span>
        <CopyButton text={rawCode} />
      </figcaption>
      <div
        tabIndex={0}
        role="region"
        aria-label={filename}
        className="code-scroll min-h-0 min-w-0 flex-1 overflow-auto p-4 font-mono text-mono-13 [&_pre]:bg-transparent!"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </figure>
  );
}
