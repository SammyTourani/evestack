import { Section, SectionHeading } from "@/components/ui/section";
import { DashboardShot } from "@/components/ui/dashboard-shot";
import { observability, scrambleStat } from "@/lib/copy";

/* §06: the artwork is now the SHIPPED DASHBOARD, not a drawing of one.
   `public/screenshots/{sessions,session-detail}-{dark,light}@2x.{avif,webp}`
   are captures of packages/dashboard, produced by scripts/capture-screenshots
   .mjs → scripts/optimize-images.mjs from assets/screenshots-raw/.

   What used to be here was <MonitorsPanel />: an invented "Observability /
   Monitors" screen with p50/p75/p95/p99 chips, error and timeout rates, a
   runs-over-time chart, session search and pagination — presented in a tilted
   <figure data-screenshot-tilt> captioned as if it were read from Postgres.
   The dashboard has no Monitors route, no Traces route and no percentile code
   at all; its nav is Sessions, Chat, Schedules, Memory, Skills, Approvals,
   Integrations (packages/dashboard/app/layout.tsx:19-27). The component and its
   `.mon` styles are deleted. `data-screenshot-tilt` stays on the figure below
   because that attribute is finally describing a screenshot.

   Backdrop is the site's quiet graph-paper motif, established in the
   integrations hub. */
export function Observability() {
  const { sessions, detail } = observability.shots;

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
          <div className="overflow-hidden rounded-xl border border-border-default bg-background-200">
            <DashboardShot
              name={sessions.name}
              width={sessions.width}
              height={sessions.height}
              alt={sessions.alt}
              className="block h-auto w-full"
            />
          </div>
          <figcaption className="mt-4 text-center font-mono text-label-12 uppercase text-gray-700">
            {sessions.caption} <span data-scramble>{scrambleStat}</span>
          </figcaption>
        </figure>

        <div className="mx-auto mt-16 grid max-w-5xl min-w-0 items-start gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <figure className="min-w-0">
            <div className="overflow-hidden rounded-xl border border-border-default bg-background-200">
              <DashboardShot
                name={detail.name}
                width={detail.width}
                height={detail.height}
                alt={detail.alt}
                className="block h-auto w-full"
              />
            </div>
            <figcaption className="mt-3 font-mono text-label-12 uppercase text-gray-700">
              {detail.caption}
            </figcaption>
          </figure>

          <dl className="flex flex-col gap-6">
            {observability.capabilities.map((cap) => (
              <div key={cap.title} className="flex flex-col gap-1.5">
                <dt className="text-copy-16 font-medium text-gray-1000">{cap.title}</dt>
                <dd className="text-copy-14 text-gray-900">
                  {cap.body}
                  {/* The file that renders it, so the claim is one grep from
                      being checked rather than one screenshot from being
                      believed. */}
                  <span className="mt-1.5 block font-mono text-label-12 text-gray-700">
                    {cap.source}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mx-auto mt-16 max-w-5xl min-w-0">
          <p className="font-mono text-label-12 uppercase text-gray-700">
            Span tree, one model call
          </p>
          <ol className="mt-3 flex flex-col gap-1 font-mono text-mono-13">
            {observability.spanTree.map((span, i) => (
              <li
                key={`${span.name}-${i}`}
                style={{ paddingLeft: `${span.depth * 1.25}rem` }}
                className="flex items-baseline gap-2 text-gray-1000"
              >
                <span aria-hidden className="text-gray-600">
                  {span.depth === 0 ? "▚" : "└"}
                </span>
                {span.name}
                {span.note ? (
                  <span className="text-label-12 uppercase text-gray-600">{span.note}</span>
                ) : null}
              </li>
            ))}
          </ol>
          {/* The span tree above is what the agent emits, not a screenshot of a
              page — the OTLP endpoint stores these spans and nothing renders
              them yet. Said plainly so the tree is not mistaken for UI. */}
          <p className="mt-4 max-w-2xl text-copy-14 text-gray-700">
            The tree an agent emits per model call. evestack&rsquo;s OTLP endpoint ingests it into
            your Postgres — prompt bodies and tool arguments included, which the SQL tags do not
            carry — and it is queryable today. It is storage, not yet a screen: the pages above are
            the ones that exist.
          </p>
        </div>
      </div>
    </Section>
  );
}
