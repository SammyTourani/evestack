import { Section } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { CommandPill } from "@/components/ui/command-pill";
import { closing, site } from "@/lib/copy";

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
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <span className="border-beam inline-flex rounded-full">
            <CommandPill command={site.command} className="bg-background-100" />
          </span>
          <Button href={site.github} external size="lg" data-magnetic>
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
          — architecture, the self-hosting runbook, and which eve version this is verified
          against.
        </p>
      </div>
    </Section>
  );
}
