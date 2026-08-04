import { Section, SectionHeading } from "@/components/ui/section";
import { CopyButton } from "@/components/ui/copy-button";
import { quickstart } from "@/lib/copy";

export function Quickstart() {
  return (
    <Section id="quickstart">
      <SectionHeading id="quickstart-heading" eyebrow="09 · quickstart" title={quickstart.heading} />
      <ol className="grid gap-6 md:grid-cols-3" data-reveal="stagger">
        {quickstart.steps.map((step, i) => (
          <li
            key={step.title}
            className="flex flex-col gap-4 rounded-xl border border-border-default bg-background-200 p-6"
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex h-7 w-7 items-center justify-center rounded-full border border-border-default font-mono text-mono-13 text-gray-900"
              >
                {i + 1}
              </span>
              <h3 className="text-heading-20">{step.title}</h3>
            </div>
            <p className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-background-100 px-4 py-3 font-mono text-mono-13">
              <span className="truncate">
                <span className="text-gray-600">$ </span>
                <span className="text-gray-1000">{step.code}</span>
              </span>
              <CopyButton text={step.code} />
            </p>
            <p className="text-copy-14 text-gray-900">{step.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
