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
    /* PHONE RUNWAY (< 40rem): 185svh, which is 1,576px instead of 2,897px at
       393x852 — a phone screen and a half off the top of the page, on a device
       where this is also the slowest thing to scroll past.

       185 rather than the 220 this started at, and the two numbers are not
       independent of the mark's size. The phone diagram is 0.577 of a 16rem box
       (hero-client.tsx), so the bars travel a shorter distance than the desktop
       composition's do; a shorter runway over a shorter travel is close to
       speed-NEUTRAL rather than a speed-up. 170svh is the floor — below that
       the same travel starts reading as the flick the comment above warns
       about at 150vh. Do not cut this number without also checking the mark. The beat map in slab-choreo.ts is expressed in
       fractions of the scrub, so every beat stretches with this and nothing
       needs retiming.

       svh rather than vh, and that part is not cosmetic: the pinned child is
       already `h-svh`, and iOS Safari resolves `vh` against the LARGE viewport
       (URL bar hidden) and `svh` against the small one. Mixing them makes the
       section and its own sticky child disagree by the height of the toolbar,
       so the (N - 100) arithmetic in the comment above stops being true on the
       one platform this rule exists for. The breakpoint is sm to match the
       stage geometry in hero-client.tsx, so the whole hero changes shape at
       one width rather than two. */
    <section
      id="hero"
      aria-labelledby="hero-heading"
      className="relative h-[185svh] sm:h-[340vh]"
    >
      {/* Layer labels for the scroll disassembly — real DOM, screen-reader
          visible list in every mode */}
      <p className="sr-only">{architecture.srSummary}</p>

      <div data-hero-pane className="sticky top-0 flex h-svh flex-col items-center justify-center overflow-hidden">
        {/* Ambient ASCII glyph field framing the copy + 3D stack (eve.dev
            imprint port; masked out of the center, fades on scroll) */}
        <HeroGlyphField />

        {/* Tri-gradient glow — the site's ONE gradient moment; survives every
            fallback rung */}
        <div
          aria-hidden
          /* The glow is painted INSIDE this box, so the box has to be at least as big
              as the gradient wants to be or it clips. At 393x852 the desktop
              constants gave a 472x560 box inside an 852px pane and the phone
              gradient's 62vh ellipse was cut off square: 146px of flat black
              above the glow and a matching band below, with a visible
              horizontal seam where the colour stopped. Filling the pane on a
              phone costs nothing — the element is empty, aria-hidden and
              pointer-events-none — and it is what lets the one gradient moment
              on this site actually reach the edges of the screen it is on. */
          className="hero-glow pointer-events-none absolute left-1/2 top-1/2 z-0 h-full w-full max-w-none -translate-x-1/2 -translate-y-1/2 md:h-[560px] md:w-[900px] md:max-w-[120vw]"
        />

        <HeroClient>
          {/* Two lines, broken where copy.ts says rather than wherever the
              measure happens to run out.

              `block` per line instead of a <br>: a break element is invisible
              to `text-wrap: balance` and to any future SplitText, and it puts
              the line structure in the markup where it can be styled. The
              spans carry no width of their own, so each line still wraps on
              its own if a narrow viewport needs it to.

              text-balance moves from the h1 to each span. On the h1 it would
              re-break the whole headline and undo the split; on a span it only
              acts when that line is too wide for the viewport, which is a
              phone. Without it "on your own machine." breaks to "on your own"
              plus an orphaned "machine."; with it the two halves even out. */}
          <h1
            id="hero-heading"
            className="max-w-4xl text-heading-40 sm:text-heading-48 lg:text-heading-56"
          >
            {site.taglineLines.map((line, i) => (
              <span key={line} className="block text-balance">
                {line}
                {/* The space belongs to the text, not the layout. Two adjacent
                    block spans concatenate with nothing between them, so the
                    accessible name came out "Run AI agentson your own machine."
                    and that is what a screen reader would have said. A trailing
                    space collapses in a block box, so it costs nothing visually
                    and restores the sentence. Caught by the smoke test that
                    compares the h1 against the canonical tagline. */}
                {i < site.taglineLines.length - 1 ? " " : null}
              </span>
            ))}
          </h1>
          <p
            data-hero="sub"
            className="hidden max-w-xl text-balance text-copy-16 text-gray-900 md:block md:text-copy-18"
          >
            {site.subhead}
          </p>
          {/* On a phone these were three independently-centred pills of three
              different widths — 242 / 239 / 184 — ragging down both sides and
              taking 21% of the screen. `items-stretch` inside a fixed measure
              does the equalising; the w-full props are belt and braces and
              matter only for AgentPackButton, whose shell would otherwise
              shrink-wrap inside a stretched root. Every sm: value is today's
              exact string, so the desktop row is untouched. */}
          <div
            data-hero="ctas"
            className="mt-0 flex w-full max-w-[19.5rem] flex-col items-stretch gap-2.5 sm:mt-2 sm:w-auto sm:max-w-none sm:flex-row sm:items-center sm:gap-4"
          >
            <CommandPill command={site.command} className="w-full sm:w-auto" />
            <AgentPackButton size="lg" className="w-full sm:w-auto" />
            <Button href={site.github} external variant="ghost" size="lg" className="w-full sm:w-auto">
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
