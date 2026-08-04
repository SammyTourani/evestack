import { cn } from "@/lib/utils";

export function Badge({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border-subtle px-3 py-1 font-mono text-label-12 uppercase text-gray-900",
        className,
      )}
    >
      {children}
    </span>
  );
}
