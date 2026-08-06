import { Section, SectionHeading } from "@/components/ui/section";
import { comparison } from "@/lib/copy";

export function Comparison() {
  return (
    <Section id="compare">
      <SectionHeading id="compare-heading" eyebrow="02 · compare" title={comparison.heading} sub={comparison.sub} />
      <div
        tabIndex={0}
        role="region"
        aria-label="Managed versus self-hosted comparison"
        className="overflow-x-auto"
      >
        <table
          data-reveal="rows"
          className="w-full min-w-[640px] border-separate border-spacing-0 text-copy-14"
        >
          <thead>
            <tr>
              {comparison.columns.map((col, i) => (
                <th
                  key={i}
                  scope="col"
                  className={
                    "border-b border-border-default px-5 py-4 text-left font-mono text-label-12 uppercase " +
                    (i === 2 ? "text-gray-1000" : "text-gray-700")
                  }
                >
                  {i === 2 ? (
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden className="text-blue-700">
                        ▚
                      </span>
                      {col}
                    </span>
                  ) : (
                    col
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map(([label, hosted, ours], r) => {
              const last = r === comparison.rows.length - 1;
              return (
                <tr key={label} className="transition-colors hover:bg-gray-100/40">
                  <th
                    scope="row"
                    className={
                      "px-5 py-4 text-left font-normal text-gray-900 " +
                      (last ? "" : "border-b border-border-subtle")
                    }
                  >
                    {label}
                  </th>
                  <td
                    className={
                      "px-5 py-4 text-gray-700 " + (last ? "" : "border-b border-border-subtle")
                    }
                  >
                    {hosted}
                  </td>
                  <td
                    className={
                      "bg-background-200 px-5 py-4 text-gray-1000 " +
                      (last ? "rounded-b-xl border-x border-b border-border-strong" : "border-x border-border-strong") +
                      (r === 0 ? " rounded-t-xl border-t" : "")
                    }
                  >
                    <span className="flex items-center gap-2.5">
                      <svg
                        data-check
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="var(--ds-ok)"
                        strokeWidth="2"
                        aria-hidden
                        className="shrink-0"
                      >
                        <path d="M2.5 8.5 6 12l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {ours}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Every superscript in the Managed column resolves here. A comparison
          table that characterises someone else's product without citing it is
          a table nobody has to believe — these are their docs, linked. */}
      <ol className="mt-6 flex flex-col gap-2 text-copy-14 text-gray-700">
        {comparison.footnotes.map((note) => (
          <li key={note.marker} className="flex gap-2">
            <span aria-hidden className="shrink-0 font-mono text-label-12">
              {note.marker}.
            </span>
            <span>
              {note.text}{" "}
              <a
                href={note.href}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-border-strong underline-offset-4 transition-colors hover:text-gray-1000"
              >
                {note.href.replace("https://", "")}
              </a>
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
