import { Section, SectionHeading } from "@/components/ui/section";
import { TraceStage } from "@/components/three/trace/trace-stage";
import { DashboardShot } from "@/components/ui/dashboard-shot";
import { observability } from "@/lib/copy";

/* Screenshot slot renders the styled span tree until Phase 6 swaps in real
   dashboard captures (hidden dark:block picture pairs). */
export function Observability() {
  return (
    <Section id="observability" className="relative overflow-hidden">
      <TraceStage />
      <div className="relative">
        <SectionHeading
          id="observability-heading"
          eyebrow="06 · observability"
          title={observability.heading}
          sub={observability.sub}
        />
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="flex flex-col gap-6">
            <p className="text-copy-16 text-gray-900">
              Every span the framework emits, in your own database. The tree below is a real
              session, captured from a live run.
            </p>
            <div className="flex flex-col gap-1.5 rounded-xl border border-border-subtle bg-background-200 p-5 font-mono text-mono-13">
              {observability.spanTree.map((span, i) => (
                <p key={i} style={{ paddingLeft: span.depth * 16 }} className="whitespace-nowrap">
                  <span className="text-gray-600">{span.depth > 0 ? "└─ " : ""}</span>
                  <span className={span.depth === 0 ? "text-gray-1000" : "text-gray-900"}>
                    {span.name}
                  </span>
                  {span.note ? (
                    <span className="ml-2 rounded-full border border-border-subtle px-1.5 py-0.5 text-label-12 text-gray-700">
                      {span.note}
                    </span>
                  ) : null}
                </p>
              ))}
            </div>
          </div>

          <figure data-screenshot-tilt className="min-w-0">
            <div className="overflow-hidden rounded-xl border border-border-default bg-background-200 shadow-2xl">
              <DashboardShot
                name="session-detail"
                width={1440}
                height={680}
                alt="evestack dashboard session view: a real run with 5,123 input and 3,704 output tokens, 4,608 cached reads, and $0.0077 computed model spend"
                className="w-full"
              />
            </div>
            <figcaption className="mt-3 text-center font-mono text-label-12 uppercase text-gray-700">
              read straight from your own postgres — <span data-scramble>100% yours</span>
            </figcaption>
          </figure>
        </div>
      </div>
    </Section>
  );
}
