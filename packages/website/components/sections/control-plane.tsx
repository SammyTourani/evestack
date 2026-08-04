import { Section, SectionHeading } from "@/components/ui/section";
import { control } from "@/lib/copy";

/* Static: all three approval states visible (reduced-motion truth).
   Phase 5 animates them as a loop and shows one at a time. */
export function ControlPlane() {
  return (
    <Section id="control">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <SectionHeading
          id="control-heading"
          align="left"
          eyebrow="07 · control"
          title={control.heading}
          sub={control.sub}
        />
        <div data-approval-demo className="flex flex-col gap-3">
          {control.demo.states.map((state) => (
            <div
              key={state}
              data-approval-state={state}
              className="flex items-center justify-between gap-4 rounded-xl border border-border-default bg-background-200 px-5 py-4"
            >
              <div className="flex min-w-0 flex-col gap-0.5 font-mono text-mono-13">
                <p className="text-gray-1000">{control.demo.tool}</p>
                <p className="truncate text-gray-700">{control.demo.args}</p>
              </div>
              <span
                data-approval-pill
                className={
                  "shrink-0 rounded-full border px-3 py-1 font-mono text-label-12 uppercase " +
                  (state === "requested"
                    ? "border-warn/40 text-warn"
                    : state === "approved"
                      ? "border-ok/40 text-ok"
                      : "border-border-subtle text-gray-700")
                }
              >
                {state}
              </span>
            </div>
          ))}
          {/* Live decision point: the choreography parks the demo on
             "requested" until one of these is pressed (or 4s passes).
             Motion-only affordance — reduced-motion shows all states. */}
          <div
            data-approval-actions
            className="hidden items-center gap-2 font-mono text-mono-13 motion-safe:flex"
          >
            <span className="text-gray-700">your call:</span>
            <button
              type="button"
              data-approval-approve
              className="rounded-full border border-ok/40 px-4 py-1.5 text-ok transition-colors hover:bg-ok/10"
            >
              approve
            </button>
            <button
              type="button"
              data-approval-deny
              className="rounded-full border border-border-default px-4 py-1.5 text-gray-700 transition-colors hover:border-err/40 hover:text-err"
            >
              deny
            </button>
          </div>
        </div>
      </div>
    </Section>
  );
}
