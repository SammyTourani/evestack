import { Section, SectionHeading } from "@/components/ui/section";
import { MonitorsPanel } from "@/components/sections/monitors-panel";
import { observability } from "@/lib/copy";

/* §06: the live monitors panel IS the artwork — percentiles, the real 41.0s
   spike, span waterfall, token bars, log tail, all computed from the same
   demo dataset as the dashboard demo. Backdrop is the site's quiet
   graph-paper motif (established in the integrations hub) — the WebGL
   trace constellation is gone. */
export function Observability() {
  return (
    <Section id="observability" className="relative overflow-hidden">
      {/* graph-paper backdrop, faded toward the edges — both themes */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--ds-border-subtle)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_65%_60%_at_50%_42%,black_30%,transparent_78%)]"
      />
      <div className="relative">
        <SectionHeading
          id="observability-heading"
          eyebrow="06 · observability"
          title={observability.heading}
          sub={observability.sub}
        />
        <figure data-screenshot-tilt className="mx-auto max-w-5xl min-w-0">
          <MonitorsPanel />
          <figcaption className="mt-4 text-center font-mono text-label-12 uppercase text-gray-700">
            read straight from your own postgres — <span data-scramble>100% yours</span>
          </figcaption>
        </figure>
      </div>
    </Section>
  );
}
