import { Section, SectionHeading } from "@/components/ui/section";
import { ArchitectureBeams } from "@/components/sections/architecture-beams";
import { CodeCard } from "@/components/ui/code-card";
import { getCodeSamples } from "@/lib/code-samples";
import { highlight } from "@/lib/shiki";
import { architecture } from "@/lib/copy";

/* §06 How it works. Node layout is a plain grid; the choreography chunk
   overlays measured SVG beams (data-arch-node ids are the anchors).

   THE CODE CARDS MOVED IN HERE (2026-08-10), from a section of their own
   headed "The code is the pitch". Two problems with that section standing
   alone: it was the eighth of twelve, so a reader met the diagram of the
   system three screens before the files that implement it, and its heading
   only lands for the slice of visitors who read code first and marketing
   never. As the second half of "how it works" the cards do the job the old
   section was reaching for, which is to show that the diagram above is not an
   illustration, without asking for a screen of their own to do it. */
export async function Architecture() {
  const [agent, postgres, sandbox, dashboard] = architecture.nodes;
  const samples = await getCodeSamples();
  const highlighted = await Promise.all(
    samples.map(async (s) => ({ ...s, html: await highlight(s.code, s.lang) })),
  );

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
        eyebrow="05 · how it works"
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

      {/* The same four pieces, as the files that actually create them. Read
          from the repository at build time by lib/code-samples.ts, so this
          block cannot drift from the code it claims to show. */}
      <div className="mt-16 border-t border-border-subtle pt-12">
        <p className="mb-10 text-center text-copy-16 text-gray-900">
          {architecture.codeLead}
        </p>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3" data-reveal="decode">
          {highlighted.map((s) => (
            <div key={s.filename} className="flex min-w-0 flex-col gap-3">
              {/* No fixed height: the samples are curated to 16 lines each in
                  code-samples.ts, so the cards size to content and stay equal. */}
              <CodeCard filename={s.filename} html={s.html} rawCode={s.code} />
              <p className="px-1 text-copy-14 text-gray-700">{s.note}</p>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
