import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/ui/github-icon";
import { CommandPill } from "@/components/ui/command-pill";
import { AgentPackButton } from "@/components/ui/agent-pack-button";
import { HeroClient } from "@/components/sections/hero-client";
import { HeroGlyphField } from "@/components/sections/hero-glyph-field";
import { site, architecture } from "@/lib/copy";

/* §1+§2. 340vh scroll range + sticky viewport: native scroll, scrub-ready
   (the disassembly timeline runs against #hero; a short dwell after the
   last bar lands lets the labeled diagram read before handoff). The copy
   is RSC — the h1 is the LCP element. */
export function Hero() {
  return (
    /* 340vh (2026-08-11). This number is the disassembly's PLAYBACK SPEED, not
       the page's length, and the arithmetic is worth stating because it is not
       what it looks like.

       ScrollTrigger runs `top top` → `bottom bottom`, so the wheel distance
       that covers progress 0→1 is:

           usable scroll = section height − viewport height = (N − 100)vh

       That subtraction is why the knob is so much more sensitive than it
       appears. 220vh gave 120vh of scroll; 340vh gives 240vh, exactly double.
       And it is why cutting this to 150vh earlier was so bad: 50vh of scroll,
       a twelfth of what it is now, so the slabs snapped apart in a flick and
       read as a glitch rather than a reveal.

       The beat map is unchanged and unaffected: it is expressed in fractions
       of the scrub (slab-choreo.ts), so every beat stretches with this. The
       last real tween ends at 0.895, leaving ~34vh of dwell on the finished
       diagram before the section hands off.

       To make the animation FASTER without shortening the page, or the page
       shorter without speeding it up, retime slab-choreo.ts. Do not reach for
       this number for either. */
    <section id="hero" aria-labelledby="hero-heading" className="relative h-[340vh]">
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
