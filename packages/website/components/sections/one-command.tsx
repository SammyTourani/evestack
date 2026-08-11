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
            eyebrow="01 · setup"
            title={terminal.caption}
            /* Was: "npx evestack create writes your env, generates
               credentials, and prints the three commands that finish the job:
               Postgres up, bootstrap, dev. Kill the stack, restart it, sessions
               pick up where they left off."

               Sammy read this one out loud as the example of copy nobody can
               parse, and he was right: "writes your env", "bootstrap", "kill
               the stack" are four bits of in-house shorthand in two sentences.
               Same three facts, said the way you would say them to someone
               sitting next to you. */
            sub="It asks you a few questions, then builds the project and sets up a password for your dashboard. When it finishes it prints the last three commands to run. Turn everything off and back on whenever you like, because your agents carry on from where they stopped."
          />
          {/* The three jobs in this line are the three rows in the panel to
              the right, so the abstract claim and the concrete evidence are
              on screen together. Sits above the ports because "what would I
              use this for" is a bigger question than "which ports". */}
          <p className="mb-8 text-copy-14 text-gray-700">{terminal.examples}</p>
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
            {/* Real macOS traffic lights. They were three identical grey dots,
                which reads as a wireframe of a terminal rather than as one. */}
            <figcaption className="flex h-12 items-center gap-2 border-b border-border-subtle px-4">
              <span aria-hidden className="flex gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]" />
              </span>
              <span className="ml-2 font-mono text-mono-13 text-gray-700">evestack</span>
            </figcaption>
            {/* Every line is a clipping wrapper plus a caret, so the whole
                terminal can be typed out rather than faded in line by line.

                The reveal animates the WRAPPER'S WIDTH, not split characters.
                SplitText would mean ~450 spans across nine lines, each one a
                chance to break `whitespace-pre` or the screen-reader reading
                order. Growing an overflow-hidden inline-block does the same
                thing visually, needs no DOM surgery, and the caret sitting
                after it rides the growing edge for free, which is the detail
                that makes it read as typing instead of as a wipe.

                Settled truth (no-JS, reduced motion, pre-animation SSR): every
                line at natural width with the caret on the LAST line, which is
                what a finished terminal looks like. globals.css owns that. */}
            <div
              data-term
              tabIndex={0}
              role="region"
              aria-label="Terminal: creating and starting evestack"
              className="flex flex-col gap-1.5 overflow-x-auto p-5 font-mono text-mono-13"
            >
              <p data-terminal-line data-kind="cmd">
                <span data-term-text className="whitespace-pre">
                  <span aria-hidden className="text-gray-600">
                    $&nbsp;
                  </span>
                  <span className="text-gray-1000">{terminal.prompt}</span>
                </span>
                <span data-term-caret aria-hidden className="terminal-cursor" />
              </p>
              {terminal.lines.map((line) => (
                <p key={line.text} data-terminal-line data-kind={line.kind} className="text-gray-900">
                  <span data-term-text className="whitespace-pre">
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
                  </span>
                  <span data-term-caret aria-hidden className="terminal-cursor" />
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
