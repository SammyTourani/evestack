import { Section } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { CommandPill } from "@/components/ui/command-pill";
import { closing, site } from "@/lib/copy";

export function ClosingCta() {
  return (
    <Section id="get-started" labelledBy="closing-heading">
      <div className="flex flex-col items-center gap-8 py-12 text-center">
        <h2
          id="closing-heading"
          data-reveal="lines"
          className="max-w-3xl text-balance text-heading-40 md:text-heading-48"
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
      </div>
    </Section>
  );
}
