import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/ui/github-icon";
import { CommandPill } from "@/components/ui/command-pill";
import { AgentPackButton } from "@/components/ui/agent-pack-button";
import { HeroClient } from "@/components/sections/hero-client";
import { HeroGlyphField } from "@/components/sections/hero-glyph-field";
import { site, architecture } from "@/lib/copy";

/* §1+§2. 220vh scroll range + sticky viewport: native scroll, scrub-ready
   (the disassembly timeline runs against #hero; a short dwell after the
   last bar lands lets the labeled diagram read before handoff). The copy
   is RSC — the h1 is the LCP element. */
export function Hero() {
  return (
    /* 220vh → 150vh (2026-08-10). The scrub is normalised across the section's
       own height, so the disassembly still plays in full; it simply needs less
       wheel to get through. At 220vh a first-time visitor spent two and a bit
       screens on one headline before the page said anything else, which is the
       most expensive real estate on the site. The dwell after the last bar
       lands is now ~15vh rather than ~22vh, which is still long enough to read
       the four labels. */
    <section id="hero" aria-labelledby="hero-heading" className="relative h-[150vh]">
      {/* Layer labels for the scroll disassembly — real DOM, screen-reader
          visible list in every mode */}
      <p className="sr-only">{architecture.srSummary}</p>

      <div className="sticky top-0 flex h-svh flex-col items-center justify-center overflow-hidden">
        {/* Ambient ASCII glyph field framing the copy + 3D stack (eve.dev
            imprint port; masked out of the center, fades on scroll) */}
        <HeroGlyphField />

        {/* Tri-gradient glow — the site's ONE gradient moment; survives every
            fallback rung */}
        <div
          aria-hidden
          className="hero-glow pointer-events-none absolute left-1/2 top-1/2 z-0 h-[560px] w-[900px] max-w-[120vw] -translate-x-1/2 -translate-y-1/2"
        />

        <HeroClient>
          {/* Sammy asked for "how it's open source" to be obvious in the hero,
              and it genuinely was not: the eyebrow existed in copy.ts and no
              element rendered it, so the only place the word open source
              appeared above the fold was nowhere.

              A quiet mono line, not the badge that used to sit here and was
              cut for clutter. It reads as a label on the product rather than
              as a decoration competing with the headline. */}
          <p
            data-hero="eyebrow"
            className="font-mono text-label-12 uppercase tracking-wide text-gray-700"
          >
            {site.eyebrow}
          </p>
          <h1
            id="hero-heading"
            className="max-w-4xl text-balance text-heading-40 sm:text-heading-48 lg:text-heading-56"
          >
            {site.tagline}
          </h1>
          <p
            data-hero="sub"
            className="max-w-2xl text-balance text-copy-16 text-gray-900 md:text-copy-18"
          >
            {site.subhead}
          </p>
          {/* The why, quieter than the subhead and directly under it, so the
              order a reader takes it in is: what it is, what you get, why you
              would want it. Any louder and it competes with the promise it is
              justifying. */}
          <p data-hero="why" className="max-w-xl text-balance text-copy-14 text-gray-700">
            {site.why}
          </p>
          {/* Two front doors, side by side: the command for a human, the pack
              for the agent a growing share of visitors will hand this to
              instead of reading it themselves.

              This slot used to hold a "Get started" button that scrolled to
              §quickstart. It was the most redundant control on the page — the
              site header carries the same button, and the command pill six
              pixels to its left already IS getting started. Swapping it costs
              nothing and buys the one path the site had no entry point for.

              No data-magnetic here, deliberately: the pointer-follow transform
              would drag the button's popover around with it. */}
          <div data-hero="ctas" className="mt-2 flex flex-col items-center gap-4 sm:flex-row">
            <CommandPill command={site.command} />
            <AgentPackButton size="lg" />
            <Button href={site.github} external variant="ghost" size="lg">
              <GitHubIcon />
              Star on GitHub
            </Button>
          </div>

        </HeroClient>

        {/* ground the hero into the page */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-40 bg-gradient-to-b from-transparent to-background-100"
        />
      </div>
    </section>
  );
}
