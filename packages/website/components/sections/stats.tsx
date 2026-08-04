import { Section } from "@/components/ui/section";
import { CountUp } from "@/components/ui/count-up";
import { stats } from "@/lib/copy";

export function Stats() {
  return (
    <Section id="stats" labelledBy="stats-heading">
      <h2 id="stats-heading" className="sr-only">
        Verified numbers
      </h2>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border-subtle bg-border-subtle lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="flex flex-col gap-2 bg-background-100 p-8"
          >
            <dd
              className={
                "font-mono text-heading-40 " +
                ("accent" in stat && stat.accent ? "text-ok" : "text-gray-1000")
              }
            >
              <CountUp
                value={stat.value}
                prefix={"prefix" in stat ? stat.prefix : ""}
                suffix={"suffix" in stat ? stat.suffix : ""}
                decimals={"decimals" in stat ? stat.decimals : 0}
              />
            </dd>
            <dt className="text-copy-14 text-gray-900">{stat.label}</dt>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-center font-mono text-label-12 uppercase text-gray-700">
        one real user message, measured in Postgres — see FINDINGS.md
      </p>
    </Section>
  );
}
