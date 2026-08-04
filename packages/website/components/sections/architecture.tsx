import { Section, SectionHeading } from "@/components/ui/section";
import { ArchitectureBeams } from "@/components/sections/architecture-beams";
import { architecture } from "@/lib/copy";

/* Node layout is a plain grid; Phase 5 overlays measured SVG beams
   (data-arch-node ids are the anchors). */
export function Architecture() {
  const [agent, postgres, sandbox, dashboard] = architecture.nodes;

  function Node({
    node,
    className = "",
  }: {
    node: (typeof architecture.nodes)[number];
    className?: string;
  }) {
    return (
      <div
        data-arch-node={node.id}
        className={
          "flex w-full max-w-64 flex-col gap-1 rounded-xl border border-border-default bg-background-200 px-5 py-4 " +
          className
        }
      >
        <p className="text-copy-16 font-medium text-gray-1000">{node.title}</p>
        <p className="font-mono text-mono-13 text-gray-700">{node.detail}</p>
      </div>
    );
  }

  return (
    <Section id="architecture">
      <SectionHeading
        id="architecture-heading"
        eyebrow="05 · architecture"
        title={architecture.heading}
        sub={architecture.sub}
      />
      <p className="sr-only">{architecture.srSummary}</p>
      <div
        data-arch-container
        aria-hidden
        className="relative mx-auto grid max-w-4xl grid-cols-1 items-center justify-items-center gap-10 py-6 md:grid-cols-3 md:gap-16"
      >
        <div className="flex w-full flex-col items-center gap-10 md:gap-16">
          <Node node={postgres} />
          <Node node={sandbox} />
        </div>
        <Node node={agent} />
        <Node node={dashboard} />
        <div data-arch-beams className="pointer-events-none absolute inset-0">
          <ArchitectureBeams />
        </div>
      </div>
    </Section>
  );
}
