import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

export function CommandPill({ command, className }: { command: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-12 items-center gap-3 rounded-full border border-border-default bg-background-200 pl-5 pr-3",
        className,
      )}
    >
      <span aria-hidden className="font-mono text-mono-13 text-gray-600">
        $
      </span>
      <code className="font-mono text-mono-13 text-gray-1000">{command}</code>
      <CopyButton text={command} />
    </span>
  );
}
