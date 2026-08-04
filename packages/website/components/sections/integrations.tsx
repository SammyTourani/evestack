import { Section, SectionHeading } from "@/components/ui/section";
import { MarqueeRows } from "@/components/ui/marquee-rows";
import { integrations } from "@/lib/copy";

/* Text chips only — no third-party logos, zero trademark exposure. */
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
      </div>
      <MarqueeRows chips={integrations.chips} />
    </Section>
  );
}
