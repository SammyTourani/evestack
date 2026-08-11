import { control } from "@/lib/copy";

/* The approve/deny demo, lifted out of the deleted ControlPlane section so it
   can sit inside §Dashboard.

   Unchanged behaviour: static markup renders all three states, which is the
   reduced-motion and no-JS truth; the choreography chunk parks it on
   "requested" and waits for a real click (or 4s) before advancing. The
   data-approval-* hooks are what choreography.tsx binds to, so they are load
   bearing names, not styling. */
export function ApprovalDemo() {
  return (
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
      {/* Live decision point: the choreography parks the demo on "requested"
          until one of these is pressed (or 4s passes). Motion-only affordance —
          reduced-motion shows all states. */}
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
  );
}
