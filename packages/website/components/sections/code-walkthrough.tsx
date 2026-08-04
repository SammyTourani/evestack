import { Section, SectionHeading } from "@/components/ui/section";
import { CodeCard } from "@/components/ui/code-card";
import { getCodeSamples } from "@/lib/code-samples";
import { highlight } from "@/lib/shiki";

export async function CodeWalkthrough() {
  const samples = await getCodeSamples();
  const highlighted = await Promise.all(
    samples.map(async (s) => ({ ...s, html: await highlight(s.code, s.lang) })),
  );

  return (
    <Section id="code">
      <SectionHeading
        id="code-heading"
        eyebrow="03 · the code"
        title="The code is the pitch"
        sub="Real files, read from the repository at build time — the page can never drift from the code."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3" data-reveal="stagger">
        {highlighted.map((s) => (
          <div key={s.filename} className="flex min-w-0 flex-col gap-3">
            <CodeCard filename={s.filename} html={s.html} rawCode={s.code} />
            <p className="px-1 text-copy-14 text-gray-700">{s.note}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
