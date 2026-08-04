import { cn } from "@/lib/utils";

/* The Geist '+' mark at hairline-grid intersections. Positioned by the parent
   at a cell corner; centered on the intersection point. */
export function GridCross({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-20 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2",
        className,
      )}
    >
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-gray-500" />
      <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-gray-500" />
    </span>
  );
}
