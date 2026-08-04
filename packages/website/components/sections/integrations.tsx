import { Section, SectionHeading } from "@/components/ui/section";
import { MarqueeRows } from "@/components/ui/marquee-rows";
import { IntegrationHub } from "@/components/sections/integration-hub";
import { integrations } from "@/lib/copy";

/* §08: the hub (tools beaming real Composio calls into the agent) over a
   full-bleed colored-logo marquee. Brand marks = nominative use, generated
   locally by scripts/gen-logos.mjs with official brand colors. */
export function Integrations() {
  return (
    <Section id="integrations" containerClassName="max-w-none px-0 md:px-0">
      <div className="site-container">
        <SectionHeading
          id="integrations-heading"
          eyebrow="08 · integrations"
          title={integrations.heading}
          sub={integrations.sub}
        />
        <div data-reveal="stagger" className="mx-auto mb-14 max-w-4xl">
          <IntegrationHub />
        </div>
      </div>
      <MarqueeRows rows={integrations.rows} />
    </Section>
  );
}
