import { Section, SectionHeading } from "@/components/ui/section";
import { MonitorsPanel } from "@/components/sections/monitors-panel";
import { DashboardShot } from "@/components/ui/dashboard-shot";
import { ApprovalDemo } from "@/components/sections/approval-demo";
import { observability, control, site } from "@/lib/copy";

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
            interactive illustration, <span data-scramble>example data</span>
          </figcaption>
        </figure>

        <div className="mx-auto mt-10 max-w-5xl">
          <h3 className="text-heading-32">A repository brief you can check</h3>
          <p className="mt-3 max-w-3xl text-copy-16 text-gray-900">
            Ask what changed, what needs attention, and which sources support
            each finding. Review the result, then save the task as a routine.
            Missing access should be reported in the brief.
          </p>
          <figure className="mt-6 overflow-hidden rounded-xl border border-border-default bg-background-200">
            <DashboardShot
              {...observability.shots.detail}
              className="h-auto w-full"
            />
            <figcaption className="border-t border-border-subtle p-4 text-copy-14 text-gray-700">
              {observability.shots.detail.caption}{" "}
              <a
                className="inline-flex min-h-11 items-center underline underline-offset-4"
                href="/docs/first-task"
              >
                Try the walkthrough.
              </a>
            </figcaption>
          </figure>
        </div>

        {/* The four capability paragraphs that were here are gone (2026-08-11,
            Sammy: "way too much text"). He was right; they restated in prose
            what the panel above already shows, directly under the panel.

            What survives is the checkable half. Contract 16 requires copy.ts to
            name at least four dashboard source files and asserts each exists,
            because a claim about the dashboard should point at the file behind
            it. That is worth keeping and costs one quiet line here instead of
            four paragraphs: the same four paths, linked, for the reader who
            wants to go and look. */}
        <p className="mx-auto mt-8 hidden max-w-5xl flex-wrap items-center justify-center gap-x-4 gap-y-2 font-mono text-label-12 text-gray-600 md:flex">
          <span className="text-gray-700">built by</span>
          {observability.capabilities.map((capability) => (
            <a
              key={capability.source}
              href={`${site.github}/blob/main/${capability.source}`}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-border-subtle underline-offset-4 transition-colors hover:text-gray-1000 hover:decoration-current max-md:py-3.5"
            >
              {capability.source.replace("packages/dashboard/", "")}
            </a>
          ))}
        </p>

        {/* The second half of the same idea. Kept visually subordinate to the
            panel above: a hairline rule, then a two-column block at the width
            of the panel, so it reads as part of this section rather than as a
            new one that forgot its heading. */}
        <div className="mx-auto mt-10 max-w-5xl border-t border-border-subtle pt-8 md:mt-16 md:pt-12">
          {/* grid-cols-1 is not decoration, and removing it re-breaks the phone.
              Below lg there is no grid-template-columns, so the single implicit
              track is `auto` — and an auto track is sized by its largest item's
              MIN-CONTENT. ApprovalDemo's min-content is 496px, because the args
              line carries `truncate`, `truncate` sets white-space: nowrap, and a
              nowrap string contributes its full width to intrinsic sizing. The
              `min-w-0` on that row's inner column removes the flex automatic
              minimum but does nothing to a min-content contribution, so it could
              not help. The track went to 496px inside a 353px container, both
              children stretched to match, and this section's own
              `overflow-hidden` (line 21) deleted the 143px that stuck out — the
              control paragraph was cut mid-sentence on every iPhone.

              `grid-cols-1` compiles to repeat(1, minmax(0,1fr)), which gives the
              track a zero minimum and a definite width; min-w-0 and truncate then
              do the job they were always written to do. It is inert at lg, where
              lg:grid-cols-2 wins, and inert at every width where the content
              already fits — which is why the desktop is untouched. */}
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
            <div className="flex flex-col gap-4">
              <h3 className="text-heading-32">{control.heading}</h3>
              <p className="hidden max-w-md text-copy-16 text-gray-900 md:block">
                {control.sub}
              </p>
            </div>
            <ApprovalDemo />
          </div>
        </div>
      </div>
    </Section>
  );
}
