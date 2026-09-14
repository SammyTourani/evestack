import { Section, SectionHeading } from "@/components/ui/section";
import { ArchitectureBeams } from "@/components/sections/architecture-beams";
import { CodeCard } from "@/components/ui/code-card";
import { CopyButton } from "@/components/ui/copy-button";
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
          "flex w-full max-w-64 flex-col gap-1 rounded-xl border border-border-default bg-background-200 px-4 py-3 md:px-5 md:py-4 " +
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
        className="relative mx-auto grid max-w-4xl grid-cols-1 items-center justify-items-center gap-3 py-2 md:grid-cols-3 md:gap-16 md:py-6"
      >
        <div className="contents md:flex md:w-full md:flex-col md:items-center md:gap-16">
          <Node node={postgres} />
          <Node node={sandbox} />
        </div>
        <Node node={agent} className="order-first md:order-none" />
        <Node node={dashboard} />
        <div data-arch-beams className="pointer-events-none absolute inset-0 hidden md:block">
          <ArchitectureBeams />
        </div>
      </div>

      {/* PHONE: THIS DIAGRAM IS A SECOND TELLING, SO IT DOES NOT RUN HERE.
          The hero's disassembly already names these same four pieces with these
          same four ports — dashboard :4000, agent runtime :2000, Postgres
          :5433, sandbox docker.sock — as its payoff frame, about eight screens
          earlier. On a wide canvas the repetition is a diagram restating a
          headline and it reads as structure; on a phone it is the same list
          twice, and the second one costs 600px. So below md this section keeps
          its heading and the three real files underneath, which is the part
          the hero cannot show. The relationships list below goes with the
          diagram it annotates, for the same reason.

          Below md the node grid above is ONE centred column, and every route in
          architecture-beams.tsx is written for the three-column layout. "Left
          edge of the agent → right edge of Postgres" becomes a full-width
          diagonal drawn straight across the cards stacked in between, and the
          dashboard → Postgres "arc over the top" degenerates into a vertical
          line, because stacked cards share a centre x and the cubic's two
          control points and its endpoint all collapse onto it. The labels go
          with it: "saves every step" lands on the sandbox card and "reads
          history" lands at y=0, where the SVG's overflow eats it. What an
          iPhone actually showed was a dashed line ruled down the middle of all
          four cards with a pulse riding it.

          So the phone gets the four relationships as text instead — the same
          four, from the same array, in the same order. It is a sibling of the
          container rather than a child on purpose: ArchitectureBeams measures
          [data-arch-container]'s own rect to build its viewBox, so a new child
          would move the desktop beams. aria-hidden to match the diagram; the
          srSummary paragraph above is still the accessible truth. */}
      <ul aria-hidden className="mx-auto mt-3 flex max-w-64 flex-col gap-1.5 font-mono text-mono-13 text-gray-700 md:hidden">
        {architecture.beams.map((beam) => {
          const title = (id: string) =>
            architecture.nodes.find((node) => node.id === id)?.title ?? id;
          return (
            <li
              key={`${beam.from}-${beam.to}`}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <span className="text-gray-1000">{title(beam.from)}</span>
              <span aria-hidden>→</span>
              <span className="text-gray-1000">{title(beam.to)}</span>
              <span>{beam.label}</span>
            </li>
          );
        })}
      </ul>

      {/* The same four pieces, as the files that actually create them. Read
          from the repository at build time by lib/code-samples.ts, so this
          block cannot drift from the code it claims to show. */}
      <div className="mt-10 border-t border-border-subtle pt-8 md:mt-16 md:pt-12">
        <p className="mb-8 hidden text-copy-16 text-gray-900 md:mb-10 md:block md:text-center">
          {architecture.codeLead}
        </p>

        {/* PHONE (< 48rem): all three files, one open. Three 15-line samples
            back to back was 1,375px — 1.6 phone screens of source before the
            section ended. Cutting to one and linking out was the other option
            and throws away two of the three claims the notes make, so instead
            the first arrives open and the other two are one tap away.

            Native <details>, so it costs no JS and works with no JS. The body
            keeps `code-scroll` and overflow-auto: at 375pt the samples measure
            310-317px into a 301px box, and the <details> root is
            overflow-hidden, so without a scroll region the code would be
            clipped mid-token — the exact bug class the phone pass removed. */}
        <div className="flex flex-col gap-3 md:hidden">
          {highlighted.map((s, i) => (
            <details
              key={s.filename}
              open={i === 0}
              className="group overflow-hidden rounded-xl border border-border-default bg-background-200"
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-mono text-mono-13 text-gray-900">{s.filename}</span>
                  <span className="hidden text-copy-14 text-gray-700 md:block">{s.note}</span>
                </span>
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden
                  className="shrink-0 text-gray-700 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                >
                  <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <div
                tabIndex={0}
                role="region"
                aria-label={s.filename}
                className="code-scroll overflow-auto border-t border-border-subtle p-4 font-mono text-[12px] leading-[18px] [&_pre]:bg-transparent!"
                dangerouslySetInnerHTML={{ __html: s.html }}
              />
              <div className="flex justify-end border-t border-border-subtle px-3 py-2">
                <CopyButton text={s.code} />
              </div>
            </details>
          ))}
        </div>

        <div className="hidden gap-6 md:grid md:grid-cols-1 lg:grid-cols-3" data-reveal="decode">
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
