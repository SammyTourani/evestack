import { Section, SectionHeading } from "@/components/ui/section";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { GridCross } from "@/components/ui/grid-cross";
import { features, observability } from "@/lib/copy";

/* Static resting frames for each cell demo — server-rendered truth.
   Phase 5 mounts small looping animations over these. */
function CellDemo({ kind }: { kind: (typeof features.cells)[number]["demo"] }) {
  switch (kind) {
    case "events":
      return (
        <div data-demo="events" className="flex flex-col gap-1 font-mono text-mono-13">
          {["run_created", "step_started", "ai.streamText", "step_completed"].map((e, i) => (
            <p key={e} className={i === 3 ? "text-gray-1000" : "text-gray-700"}>
              <span className="text-gray-600">{String(i + 35).padStart(2, "0")} </span>
              {e}
            </p>
          ))}
        </div>
      );
    case "cost":
      return (
        <p data-demo="cost" className="font-mono text-heading-32 text-ok">
          $0.00
          <span className="mt-1 block font-mono text-label-12 uppercase text-gray-700">
            infrastructure / month
          </span>
        </p>
      );
    case "privacy":
      return (
        <div data-demo="privacy" className="flex flex-col gap-2 font-mono text-mono-13">
          <p className="text-gray-1000">EVESTACK_TRACE_CONTENT=off</p>
          <p className="text-gray-700">
            prompt: <span className="tracking-widest text-gray-500">••••••••••••</span>
          </p>
          <p className="text-gray-700">
            result: <span className="tracking-widest text-gray-500">••••••••</span>
          </p>
        </div>
      );
    case "spans":
      return (
        <div data-demo="spans" className="flex flex-col gap-1 font-mono text-mono-13">
          {observability.spanTree.slice(0, 5).map((span) => (
            <p key={span.name + span.depth} style={{ paddingLeft: span.depth * 14 }}>
              <span className="text-gray-600">{span.depth > 0 ? "└ " : ""}</span>
              <span className={span.depth === 0 ? "text-gray-1000" : "text-gray-900"}>
                {span.name}
              </span>
            </p>
          ))}
        </div>
      );
    case "approval":
      return (
        <div
          data-demo="approval"
          className="flex flex-col gap-3 rounded-lg border border-border-subtle p-3 font-mono text-mono-13"
        >
          <p className="text-gray-1000">
            send_email <span className="text-warn">wants approval</span>
          </p>
          <div className="flex gap-2">
            <span className="rounded-full border border-border-default px-3 py-1 text-ok">
              approve
            </span>
            <span className="rounded-full border border-border-default px-3 py-1 text-gray-700">
              deny
            </span>
          </div>
        </div>
      );
    case "restart":
      return (
        <p data-demo="restart" className="font-mono text-mono-13 text-gray-900">
          <span
            aria-hidden
            className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-ok motion-reduce:animate-none"
          />
          [world-postgres] Re-enqueued 2 active run(s) on startup
        </p>
      );
  }
}

export function FeaturesBento() {
  return (
    <Section id="features">
      <SectionHeading id="features-heading" eyebrow="04 · features" title={features.heading} sub={features.sub} />
      <ul
        data-reveal="stagger"
        className="relative grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border-subtle bg-border-subtle md:grid-cols-2 lg:grid-cols-3"
      >
        {features.cells.map((cell, i) => (
          <li key={cell.title} className="relative min-w-0">
            {/* '+' crosses at internal intersections (skip first row/col) */}
            {i % 3 !== 0 ? <GridCross className="hidden lg:block" /> : null}
            {i >= 3 ? <GridCross className="hidden lg:block" /> : null}
            <SpotlightCard className="h-full">
              <div className="flex h-full flex-col justify-between gap-6 p-7 transition-transform duration-300 ease-out group-hover:-translate-y-0.5 motion-reduce:transition-none">
                <div className="flex flex-col gap-2">
                  <h3 className="text-heading-20">{cell.title}</h3>
                  <p className="text-copy-14 text-gray-900">{cell.body}</p>
                </div>
                <CellDemo kind={cell.demo} />
              </div>
            </SpotlightCard>
          </li>
        ))}
      </ul>
    </Section>
  );
}
