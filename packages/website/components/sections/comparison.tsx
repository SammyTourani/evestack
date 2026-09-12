import { Section, SectionHeading } from "@/components/ui/section";
import { comparison } from "@/lib/copy";

export function Comparison() {
  /* The card list below labels its two sides out of the same array the table's
     <th>s use, so the phone and the desktop cannot drift apart. */
  const [, hostedCol, oursCol] = comparison.columns;
  return (
    <Section id="compare">
      <SectionHeading id="compare-heading" eyebrow="06 · compare" title={comparison.heading} sub={comparison.sub} />
      {/* PHONE PRESENTATION (< 48rem). The table below has a 640px floor and a
          phone gives it 353, so on an iPhone it was a sideways-scrolling strip
          whose third column — the evestack column, the one the table exists to
          show — began 26px off the right edge, with every visible cell cut
          mid-word. It was the worst overflow on the page at 267px.

          Same six rows, same two sides, one card each, with the sides labelled
          out of comparison.columns so there is still exactly one copy source.
          The card keeps the table's argument rather than re-deciding it: the
          hosted side is unfilled like the table's second column, and the
          evestack side is the filled, strongly-bordered, tick-marked block the
          third column is.

          Deliberately NO data-reveal and NO data-check in here. The row cascade
          and the check-pop in choreography.tsx are keyed to the TABLE
          ([data-reveal='rows'] tbody tr, and a document-wide [data-check]), so a
          data-check on these SVGs would be given scale:0 on load by a gsap
          fromTo whose trigger is display:none on a phone — the ticks would
          simply never arrive. Cards render at rest, which is also the right
          answer for the no-JS pass. */}
      <ul
        aria-label="Managed versus self-hosted comparison"
        className="flex flex-col gap-3 md:hidden"
      >
        {comparison.rows.map(([label, hosted, ours]) => (
          <li key={label} className="rounded-xl border border-border-subtle p-4">
            <h3 className="text-copy-14 text-gray-1000">{label}</h3>
            <dl className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <dt className="font-mono text-label-12 uppercase text-gray-700">{hostedCol}</dt>
                <dd className="text-copy-14 text-gray-700">{hosted}</dd>
              </div>
              <div className="flex flex-col gap-1.5 rounded-lg border border-border-strong bg-background-200 p-3">
                <dt className="flex items-center gap-2 font-mono text-label-12 uppercase text-gray-1000">
                  <span aria-hidden className="text-blue-700">
                    ▚
                  </span>
                  {oursCol}
                </dt>
                <dd className="flex items-start gap-2.5 text-copy-14 text-gray-1000">
                  <svg
                    viewBox="0 0 16 16"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="var(--ds-ok)"
                    strokeWidth="2"
                    aria-hidden
                    className="mt-1 shrink-0"
                  >
                    <path d="M2.5 8.5 6 12l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {ours}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <div
        tabIndex={0}
        role="region"
        aria-label="Managed versus self-hosted comparison"
        className="hidden overflow-x-auto md:block"
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
    </Section>
  );
}
