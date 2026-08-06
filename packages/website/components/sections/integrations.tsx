import { Section, SectionHeading } from "@/components/ui/section";
import { LogoMarquee } from "@/components/ui/marquee-rows";
import { IntegrationHub } from "@/components/sections/integration-hub";
import { integrations } from "@/lib/copy";

/* §08: the hub (tools beaming real Composio calls into the agent) over a
   full-bleed Stripe-style logo marquee. Brand marks = nominative use,
   generated locally by scripts/gen-logos.mjs with official brand colors. */
export function Integrations() {
  return (
    <Section id="integrations" containerClassName="max-w-none px-0 md:px-0">
      <div className="site-container">
        <SectionHeading
          id="integrations-heading"
          eyebrow="03 · integrations"
          title={integrations.heading}
          sub={integrations.sub}
        />
        <div data-reveal="stagger" className="mx-auto mb-8 max-w-4xl">
          <IntegrationHub />
        </div>
        {/* The site's motto is "Everything runs on your network." This section
            is the exception, so the exception is stated in this section rather
            than left for a reader to find in the docs. */}
        <p className="mx-auto mb-16 max-w-2xl text-balance text-center text-copy-14 text-gray-700">
          {integrations.caveat.text}{" "}
          <a
            href={integrations.caveat.href}
            className="underline decoration-border-strong underline-offset-4 transition-colors hover:text-gray-1000"
          >
            {integrations.caveat.linkLabel} →
          </a>
        </p>
      </div>
      <LogoMarquee items={integrations.marquee} />
    </Section>
  );
}
