import { Section, SectionHeading } from "@/components/ui/section";
import { MonitorsPanel } from "@/components/sections/monitors-panel";
import { ApprovalDemo } from "@/components/sections/approval-demo";
import { observability, control } from "@/lib/copy";

/* §04 Dashboard: the live monitors panel IS the artwork — percentiles, the real
   41.0s spike, span waterfall, token bars, log tail, all computed from the same
   demo dataset as the dashboard demo. Backdrop is the site's quiet graph-paper
   motif (established in the integrations hub).

   THE APPROVAL DEMO MOVED IN HERE (2026-08-10). It had its own section, §07
   "Observability you can act on", 62 words and a full screen of scroll for one
   idea. Watching your agents and being able to stop them are not two features,
   they are one feature seen from both ends, and separating them meant the page
   made its single most reassuring promise ("it asks before it acts") a screen
   and a half after the section where a reader was already thinking about
   control. It reads as the payoff of this section now instead of as a footnote
   to the next one. */
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
          eyebrow="03 · dashboard"
          title={observability.heading}
          sub={observability.sub}
        />
        <figure data-screenshot-tilt className="mx-auto max-w-5xl min-w-0">
          <MonitorsPanel />
          <figcaption className="mt-4 text-center font-mono text-label-12 uppercase text-gray-700">
            read from your own database, <span data-scramble>100% yours</span>
          </figcaption>
        </figure>

        {/* The four claims this section makes, each naming the file that backs
            it. This list lived unrendered in copy.ts for a long time and I
            deleted it as dead weight, which contract 16 caught: it requires at
            least four `source:` paths and then asserts each exists, so the
            list is the carrier of a repo invariant rather than decoration.
            Rendering it is the fix that keeps both the page and the invariant
            honest, and the paths cost one quiet mono line each. */}
        <ul className="mx-auto mt-14 grid max-w-5xl gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {observability.capabilities.map((capability) => (
            <li key={capability.title} className="flex flex-col gap-2">
              <h3 className="text-copy-16 font-medium text-gray-1000">{capability.title}</h3>
              <p className="text-copy-14 text-gray-900">{capability.body}</p>
              <code className="mt-1 break-all font-mono text-label-12 text-gray-600">
                {capability.source}
              </code>
            </li>
          ))}
        </ul>

        {/* The second half of the same idea. Kept visually subordinate to the
            panel above: a hairline rule, then a two-column block at the width
            of the panel, so it reads as part of this section rather than as a
            new one that forgot its heading. */}
        <div className="mx-auto mt-16 max-w-5xl border-t border-border-subtle pt-12">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="flex flex-col gap-4">
              <h3 className="text-heading-32">{control.heading}</h3>
              <p className="max-w-md text-copy-16 text-gray-900">{control.sub}</p>
            </div>
            <ApprovalDemo />
          </div>
        </div>
      </div>
    </Section>
  );
}
