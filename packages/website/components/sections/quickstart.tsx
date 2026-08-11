import { Section, SectionHeading } from "@/components/ui/section";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { CommandRow } from "@/components/ui/command-row";
import { AgentPackButton } from "@/components/ui/agent-pack-button";
import { agentPackFiles, agentPackSize } from "@/lib/agent-pack";
import { quickstart, agentPack } from "@/lib/copy";

/* §09 — the fork in the road.

   What was here before: a four-station pipeline that completed itself as you
   scrolled (dots flipping to ✓, an ok-green spine drawing downward, per-step
   receipts rising in) beside a full `npm run verify` receipt — ten check lines
   pre-rendered as dim ghosts that flipped to ink in a cascade. All of it
   correct, none of it deleted lightly. It went because of what it was FOR: it
   argued "this really works" to someone who had already been shown eleven
   sections of evidence, in the one slot on the page where the reader has
   stopped evaluating and started deciding.

   ── the visual pass (round 2) ───────────────────────────────────────────
   The two-card version that replaced it was correct and flat. This round gives
   it the depth and colour the rest of the page has, using the page's OWN
   vocabulary rather than a new one:

     - SpotlightCard, the bento's cursor-tracking lift, tinted per column
       toward the accent that column owns;
     - a raised surface (.path-card) — lit top edge plus a wide soft shadow,
       which is what reads as raised where a border alone reads as drawn;
     - one accent rail per card, fading out at both ends: ok-green for the
       path that ends in a green receipt, blue for the path that ends in the
       ▚ mark's own colour;
     - the dot lattice this site uses behind Observability and the hub,
       masked to an ellipse so it never reaches the section edges.

   Deliberately NOT used: the tri-gradient. It is the hero glow's, and the
   closing CTA's beam, and that scarcity is the reason both land. A third
   instance here would spend it.

   Still no scroll choreography, no timers, no armed state. Everything above is
   paint and hover — the settled render IS the design, which is also what makes
   it identical under reduced motion and no-JS. */
export async function Quickstart() {
  /* Both numbers come off the real artifact at build time. The reference count
     and the byte size are exactly the kind of figure that gets typed once and
     is wrong a week later, and this page's contract is that its numbers are
     reproducible — so they are read, not written. */
  const [bytes, files] = await Promise.all([agentPackSize(), agentPackFiles()]);
  const referenceCount = files.filter((file) => file.path.startsWith("references/")).length;
  const kilobytes = Math.round(bytes / 1024);

  return (
    <Section id="quickstart" className="relative overflow-hidden">
      {/* The lattice, masked to an ellipse behind the cards. Same recipe as
          Observability §07 so the two sections read as one system. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--ds-border-subtle)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_58%_62%_at_50%_52%,black_28%,transparent_76%)]"
      />

      <div className="relative">
        <SectionHeading id="quickstart-heading" eyebrow="07 · start" title={quickstart.heading} />

        <div className="relative mx-auto grid max-w-5xl gap-8 lg:grid-cols-2 lg:gap-14">
          {/* The fork, made literal. Desktop only: stacked, the cards already
              read as a sequence and a divider between them would say "and". */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 hidden h-full w-8 -translate-x-1/2 lg:block"
          >
            <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-border-default to-transparent" />
            <span className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border-subtle bg-background-100 font-mono text-label-12 text-gray-600">
              {quickstart.divider}
            </span>
          </span>

          {/* ── run it yourself ────────────────────────────────────────── */}
          <SpotlightCard
            className="path-card rounded-2xl border border-border-default"
            spotlight="color-mix(in srgb, var(--ds-ok) 9%, transparent)"
            radius={300}
          >
            <span
              aria-hidden
              className="path-card-rail absolute inset-x-0 top-0 h-px"
              style={{ "--rail": "var(--ds-ok)" } as React.CSSProperties}
            />
            <div className="flex h-full flex-col p-6 sm:p-7">
              <h3 className="text-heading-20">{quickstart.commands.title}</h3>
              <p className="mt-1.5 text-copy-14 text-gray-700">{quickstart.commands.hint}</p>

              <div className="mt-6 flex flex-col gap-1.5">
                {quickstart.commands.rows.map((row, i) => (
                  <CommandRow key={row.cmd} pre={row.pre} cmd={row.cmd} step={i + 1} />
                ))}
              </div>

              {/* The one line kept from the deleted receipt panel: the last
                  thing verify.mjs prints, and the whole payoff that panel
                  spent forty lines building toward. */}
              <p className="mt-auto flex items-center gap-2 pt-6 font-mono text-mono-13 text-gray-700">
                <span
                  aria-hidden
                  className="flex h-4 w-4 items-center justify-center rounded-full bg-ok/15 text-[10px] text-ok"
                >
                  ✓
                </span>
                {quickstart.commands.receipt}
              </p>
            </div>
          </SpotlightCard>

          {/* ── hand it to your agent ──────────────────────────────────── */}
          <SpotlightCard
            className="path-card rounded-2xl border border-border-default"
            spotlight="color-mix(in srgb, var(--ds-blue-700) 12%, transparent)"
            radius={300}
          >
            <span
              aria-hidden
              className="path-card-rail absolute inset-x-0 top-0 h-px"
              style={{ "--rail": "var(--ds-blue-700)" } as React.CSSProperties}
            />
            <div className="flex h-full flex-col p-6 sm:p-7">
              <h3 className="text-heading-20">{quickstart.agent.title}</h3>
              <p className="mt-1.5 text-copy-14 text-gray-700">{quickstart.agent.hint}</p>

              {/* A single-hue wash under the primary action — the hero's move
                  at a fraction of its strength, and the reason this column
                  reads as the livelier of the two without any motion. */}
              <div className="relative mt-6">
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-x-6 -inset-y-8 z-0 [background:radial-gradient(ellipse_70%_60%_at_50%_50%,color-mix(in_srgb,var(--ds-blue-700)_18%,transparent),transparent_70%)]"
                />
                <div className="relative z-10">
                  <AgentPackButton size="lg" variant="panel" />
                </div>
              </div>

              {/* What is actually on the clipboard, stated in the tool's own
                  units. A copy button that does not say what it copied is a
                  button people press once and never trust. */}
              <p className="mt-3 text-center font-mono text-label-12 text-gray-600">
                {quickstart.agent.packFormat(referenceCount, kilobytes)}
              </p>

              <ul className="mt-7 flex flex-col gap-3">
                {quickstart.agent.gets.map((line) => (
                  <li key={line} className="flex items-start gap-2.5 text-copy-14 text-gray-900">
                    <span
                      aria-hidden
                      className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-700/12 text-blue-700"
                    >
                      <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.4">
                        <path d="M2.5 8.5 6 12l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    {line}
                  </li>
                ))}
              </ul>

              {/* mt-auto pins this to the bottom so both cards' last lines sit
                  on the same baseline whichever column is taller */}
              <p className="mt-auto pt-6 text-label-12 text-gray-700">
                {quickstart.agent.foot}{" "}
                <a
                  href={agentPack.href}
                  target="_blank"
                  rel="noreferrer"
                  className="whitespace-nowrap text-gray-900 underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-current"
                >
                  {quickstart.agent.read}
                </a>
              </p>
            </div>
          </SpotlightCard>
        </div>
      </div>
    </Section>
  );
}
