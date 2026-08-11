import { Section } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { CommandPill } from "@/components/ui/command-pill";
import { AgentPackButton } from "@/components/ui/agent-pack-button";
import { closing, site } from "@/lib/copy";

/* The closing CTA now carries all three ways to start, which is what the §Two
   ways in section existed to do (deleted 2026-08-11).

   That section spent a full screen and two large cards drawing a fork between
   "run these commands" and "hand it to your agent", one screen above a closing
   CTA that was already offering the command. It was the same decision twice,
   and the second time with more furniture. Here the three routes sit on one
   row at the moment a reader has finished and is deciding, which is the moment
   the fork was really for.

   Order is deliberate: the command first because it is the front door, the
   agent pack second because it is the newer path and the one people do not
   know to look for, GitHub last because it is not a way to start. */
export function ClosingCta() {
  return (
    <Section id="get-started" labelledBy="closing-heading">
      <div className="flex flex-col items-center gap-8 py-12 text-center">
        {/* No data-reveal here, deliberately. This heading is painted by a
            gradient through background-clip:text, and SplitText re-wraps each
            line in a fresh element that inherits `color: transparent` without
            the background — so the line reveal rendered it as a hollow
            outline until the split reverted. See the guard in choreography. */}
        <h2
          id="closing-heading"
          className="engraved-heading max-w-3xl text-balance text-heading-40 md:text-heading-48"
        >
          {closing.heading}
        </h2>
        <p className="text-copy-16 text-gray-900">{closing.sub}</p>
        {/* The beam stays on the command alone. It is the site's one animated
            border and the reason it reads as the primary action; putting it
            round two things would make it decoration. The agent button brings
            its own blue, so the two accents sit beside each other without
            competing.

            No data-magnetic on the GitHub button any more: it now has a
            neighbour whose popover opens on hover, and a control that slides
            toward the cursor next to one that opens on approach made the whole
            row feel unstable. */}
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <span className="border-beam inline-flex rounded-full">
            <CommandPill command={site.command} className="bg-background-100" />
          </span>
          <AgentPackButton size="lg" />
          <Button href={site.github} external variant="secondary" size="lg">
            Star on GitHub
          </Button>
        </div>
        <p className="text-copy-14 text-gray-700">
          Or read the{" "}
          <a
            href="/docs"
            className="text-gray-1000 underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-current"
          >
            documentation
          </a>{" "}
          first. It covers how the pieces fit together, how to run this on a server rather
          than a laptop, and how to fix it when something breaks.
        </p>
      </div>
    </Section>
  );
}
