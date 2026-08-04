import { Section, SectionHeading } from "@/components/ui/section";
import { DashboardDemo } from "@/components/sections/dashboard-demo";
import { terminal } from "@/lib/copy";

/* Server-renders the FINAL terminal state (a11y + no-JS truth).
   Phase 5 choreography hides lines with gsap.set and reveals them stepped,
   then crossfades to the dashboard screenshot. */
export function OneCommand() {
  return (
    <Section id="one-command">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          <SectionHeading
            id="one-command-heading"
            align="left"
            eyebrow="01 · one command"
            title={terminal.caption}
            sub="npx create-evestack writes your env, generates credentials, and prints the three commands that finish the job: Postgres up, bootstrap, dev. Kill the stack, restart it — sessions pick up where they left off."
          />
          <dl className="grid grid-cols-3 gap-6 font-mono text-mono-13">
            <div className="flex flex-col gap-1">
              <dt className="text-gray-700">agent</dt>
              <dd className="text-gray-1000">:2000</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-gray-700">dashboard</dt>
              <dd className="text-gray-1000">:4000</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-gray-700">postgres</dt>
              <dd className="text-gray-1000">:5433</dd>
            </div>
          </dl>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <figure
            data-terminal
            className="overflow-hidden rounded-xl border border-border-default bg-background-200"
          >
            <figcaption className="flex h-12 items-center gap-2 border-b border-border-subtle px-4">
              <span aria-hidden className="flex gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-gray-300" />
                <span className="h-2.5 w-2.5 rounded-full bg-gray-300" />
                <span className="h-2.5 w-2.5 rounded-full bg-gray-300" />
              </span>
              <span className="ml-2 font-mono text-mono-13 text-gray-700">evestack</span>
            </figcaption>
            <div
              tabIndex={0}
              role="region"
              aria-label="Terminal: scaffolding and starting evestack"
              className="flex flex-col gap-1.5 overflow-x-auto p-5 font-mono text-mono-13"
            >
              <p>
                <span aria-hidden className="text-gray-600">
                  $&nbsp;
                </span>
                <span className="sr-only">{terminal.prompt}</span>
                <span data-terminal-prompt aria-hidden className="text-gray-1000">
                  {terminal.prompt}
                </span>
                <span
                  aria-hidden
                  className="terminal-cursor ml-1 inline-block h-[1.05em] w-[0.55em] translate-y-[0.18em] bg-gray-1000"
                />
              </p>
              {terminal.lines.map((line) => (
                <p key={line.text} data-terminal-line className="whitespace-pre text-gray-900">
                  {line.kind === "cmd" ? (
                    <>
                      <span aria-hidden className="text-gray-600">
                        $&nbsp;
                      </span>
                      <span className="text-gray-1000">{line.text}</span>
                    </>
                  ) : line.kind === "dim" ? (
                    <span className="text-gray-700">{line.text}</span>
                  ) : (
                    <>
                      <span className="text-ok">✓ </span>
                      {line.text}
                    </>
                  )}
                </p>
              ))}
            </div>
          </figure>

          {/* what the command buys you: a live, interactive dashboard */}
          <div data-terminal-result>
            <DashboardDemo />
          </div>
        </div>
      </div>
    </Section>
  );
}
