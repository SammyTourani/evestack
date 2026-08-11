"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { useGSAP } from "@gsap/react";
import { useLenis } from "lenis/react";
import { scrollState } from "@/components/three/shared/scroll-state";

gsap.registerPlugin(ScrollTrigger, SplitText, ScrambleTextPlugin, useGSAP);

/* The page's choreography orchestrator (lazy chunk — gsap lives here). All motion lives inside
   gsap.matchMedia('(prefers-reduced-motion: no-preference)') and manipulates
   server-rendered DOM via data attributes — content is never authored hidden,
   so no-JS and reduced-motion users always see final states. */

function LenisSync() {
  const lenis = useLenis();
  useEffect(() => {
    if (!lenis) return;
    // Canonical Lenis ↔ ScrollTrigger wiring — exactly once
    const onScroll = () => ScrollTrigger.update();
    lenis.on("scroll", onScroll);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      lenis.off("scroll", onScroll);
      gsap.ticker.remove(tick);
    };
  }, [lenis]);
  return null;
}

function Choreography() {
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    let alive = true;
    document.fonts.ready.then(() => {
      if (alive) setFontsReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useGSAP(
    () => {
      if (!fontsReady) return;

      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        /* one signal tears down every listener this callback attaches */
        const uiAbort = new AbortController();
        /* ── No hero entrance, deliberately ──────────────────────────────
           The headline, sub and CTAs are server-rendered and MUST be legible
           in the first frame. There used to be a GSAP intro here that hid
           them (autoAlpha 0 / SplitText yPercent 110) and played them back
           in over ~1.6s, which meant the most important copy on the site
           arrived last and a refresh flashed an empty hero.

           The motion people actually notice is behind the copy: the slabs
           assemble in the 3D stage and the glyph field settles. Those still
           run. Do not reintroduce an opacity-0 start on anything inside
           [data-hero-copy] — it also makes the h1, which is the LCP element,
           paint late for no benefit. The scroll-driven fade below is a
           different thing and stays. */

        /* ── Hero disassembly scrub (0..1 across the 190vh section) ── */
        const labels = gsap.utils.toArray<HTMLElement>("[data-layer-label]");
        const spine = document.querySelector<SVGPathElement>("[data-hero-spine]");
        const heroCopy = document.querySelector<HTMLElement>("[data-hero-copy]");

        const annotations = document.querySelector<HTMLElement>("[data-hero-annotations]");
        if (spine) {
          const len = spine.getTotalLength();
          gsap.set(spine, { strokeDasharray: len, strokeDashoffset: len });
        }
        gsap.set(labels, { autoAlpha: 0, x: -10 });

        const scrub = gsap.timeline({
          scrollTrigger: {
            trigger: "#hero",
            start: "top top",
            end: "bottom bottom",
            scrub: true,
            onUpdate: (self) => {
              scrollState.heroProgress = self.progress;
            },
            onLeaveBack: () => {
              scrollState.heroProgress = 0;
            },
          },
          defaults: { ease: "none" },
        });
        // timeline positions ≡ progress fractions (duration 1).
        // Beat map mirrors stack-mark.tsx: unglyph 0.10–0.38, explode
        // 0.34–0.895 (stagger 0.045, travel-then-widen).
        if (heroCopy) {
          scrub.fromTo(heroCopy, { y: 0, autoAlpha: 1 }, { y: -40, autoAlpha: 0, duration: 0.1 }, 0);
        }
        if (annotations) {
          scrub.to(annotations, { autoAlpha: 1, duration: 0.02 }, 0.52);
        }
        if (spine) {
          scrub.to(spine, { strokeDashoffset: 0, duration: 0.26, ease: "power1.inOut" }, 0.54);
        }
        // labels cascade strictly TOP → BOTTOM (user-locked: dashboard,
        // agent runtime, Postgres, sandbox) — a steady reading rhythm,
        // independent of the bars' deal order. Bars are ≥97% into their
        // rows by the time their label lands, so nothing points at air.
        labels.forEach((label, i) => {
          scrub.to(label, { autoAlpha: 1, x: 0, duration: 0.08 }, 0.68 + i * 0.045);
        });
        // Anchor: ScrollTrigger scrubs across the timeline's DURATION, so
        // positions only read as progress fractions if the total is exactly
        // 1 — pin it (last real tween ends at 0.84).
        scrub.set({}, {}, 1);

        /* ── Site-wide reveals ─────────────────────────────────────── */
        gsap.utils.toArray<HTMLElement>("[data-reveal='lines']").forEach((el) => {
          // skip elements inside the hero (choreographed above)
          if (el.closest("#hero")) return;
          /* NEVER line-split text painted through background-clip:text.
             SplitText re-wraps each line in a new element; the gradient lives
             on the original box, so the clones inherit `color: transparent`
             with nothing painting them and the heading renders as a hollow
             -webkit-text-stroke outline until the split reverts. This bit the
             closing CTA. Guarding here means adding data-reveal to a
             gradient-clipped heading can never resurrect it. */
          const clip = getComputedStyle(el);
          if (clip.webkitBackgroundClip === "text" || clip.backgroundClip === "text") return;
          const split = SplitText.create(el, { type: "lines", mask: "lines" });
          gsap.fromTo(
            split.lines,
            { yPercent: 100 },
            {
              yPercent: 0,
              duration: 0.8,
              ease: "expo.out",
              stagger: 0.08,
              scrollTrigger: { trigger: el, start: "top 80%", once: true },
              onComplete: () => split.revert(),
            },
          );
        });

        gsap.utils.toArray<HTMLElement>("[data-reveal='stagger']").forEach((el) => {
          gsap.fromTo(
            el.children,
            { autoAlpha: 0, y: 24 },
            {
              autoAlpha: 1,
              y: 0,
              duration: 0.7,
              ease: "power2.out",
              stagger: 0.07,
              scrollTrigger: { trigger: el, start: "top 80%", once: true },
              onComplete: () => gsap.set(el.children, { clearProps: "all" }),
            },
          );
        });

        /* blur-decode reveal (Exa's grammar) — content de-focuses into
           legibility; used where the payload is dense text (code cards) */
        gsap.utils.toArray<HTMLElement>("[data-reveal='decode']").forEach((el) => {
          gsap.fromTo(
            el.children,
            { autoAlpha: 0, y: 16, filter: "blur(8px)" },
            {
              autoAlpha: 1,
              y: 0,
              filter: "blur(0px)",
              duration: 0.7,
              ease: "power2.out",
              stagger: 0.12,
              scrollTrigger: { trigger: el, start: "top 80%", once: true },
              onComplete: () => gsap.set(el.children, { clearProps: "all" }),
            },
          );
        });

        /* evestack-column checks pop after the row cascade */
        const checks = gsap.utils.toArray<SVGElement>("[data-check]");
        if (checks.length) {
          gsap.fromTo(
            checks,
            { scale: 0, transformOrigin: "center" },
            {
              scale: 1,
              duration: 0.45,
              ease: "back.out(2.2)",
              stagger: 0.05,
              delay: 0.7,
              scrollTrigger: { trigger: "[data-reveal='rows']", start: "top 75%", once: true },
              onComplete: () => gsap.set(checks, { clearProps: "all" }),
            },
          );
        }

        gsap.utils.toArray<HTMLElement>("[data-reveal='rows'] tbody tr").forEach((row, i) => {
          gsap.fromTo(
            row,
            { autoAlpha: 0, y: 12 },
            {
              autoAlpha: 1,
              y: 0,
              duration: 0.5,
              ease: "power2.out",
              delay: (i % 8) * 0.06,
              scrollTrigger: { trigger: row.closest("[data-reveal='rows']"), start: "top 75%", once: true },
              onComplete: () => gsap.set(row, { clearProps: "all" }),
            },
          );
        });

        /* ── Terminal typing (§1) ──────────────────────────────────────
           The WHOLE terminal types out now, line after line, with one caret
           riding the edge of whatever is currently being written. It used to
           type only the first line and then fade the other eight in as a
           cascade, which is a different thing pretending to be typing: the
           output arrived as whole blocks and the caret sat marooned at the end
           of line one while it happened.

           Mechanism, and why it is not SplitText: each line is an
           overflow-hidden wrapper whose width animates from 0 to its measured
           natural width, with the caret immediately after it. Splitting nine
           lines into ~450 character spans is nine chances to break
           `whitespace-pre` and one guaranteed fight with the screen-reader
           reading order; growing a box does the same job, and the caret rides
           the growing edge for free because it is simply the next inline
           element.

           Two speeds, because a terminal has two speakers. A `cmd` line is a
           person at a keyboard (~38ms/char, with a beat afterwards while the
           machine thinks). Everything else is the machine answering, which is
           far too fast to read as typing and is meant to be (~6ms/char). */
        const terminal = document.querySelector<HTMLElement>("[data-terminal]");
        const termBody = terminal?.querySelector<HTMLElement>("[data-term]");
        if (terminal && termBody) {
          const lines = gsap.utils.toArray<HTMLElement>("[data-terminal-line]", termBody);
          /* Same policy as the hero entrance: if this chunk initializes with
             the terminal already at/past its trigger line (mid-page reload,
             anchor link below it), the settled SSR content has been visible —
             skip the hide-and-replay entirely rather than blank it. */
          const alreadyRevealed =
            terminal.getBoundingClientRect().top < window.innerHeight * 0.7;

          if (!alreadyRevealed && lines.length > 0) {
            /* Measure BEFORE anything is hidden. Widths are read once, in one
               pass, so this cannot interleave reads and writes into a layout
               thrash across nine elements. */
            const parts = lines.map((line) => {
              const text = line.querySelector<HTMLElement>("[data-term-text]");
              const caret = line.querySelector<HTMLElement>(".terminal-cursor");
              const chars = (text?.textContent ?? "").length;
              return { text, caret, chars, isCmd: line.dataset.kind === "cmd" };
            });
            const widths = parts.map(({ text }) => text?.offsetWidth ?? 0);

            /* Hidden state applies NOW, at setup, not inside the timeline. A
               timeline-internal .set() only runs when the trigger fires at
               "top 70%", so settled SSR content would flash fully formed while
               the card scrolls up to the trigger, then blank and replay. These
               eager sets live inside the no-preference matchMedia scope, so
               no-JS and reduced-motion users never get content hidden. */
            termBody.setAttribute("data-typing", "");
            parts.forEach(({ text }) => text && gsap.set(text, { width: 0 }));

            const termTl = gsap.timeline({
              scrollTrigger: { trigger: terminal, start: "top 70%", once: true },
            });

            parts.forEach((part, i) => {
              const { text, caret, chars, isCmd } = part;
              if (!text) return;
              /* Capped so a long machine line cannot stall the sequence, and
                 floored so a two-word line still reads as typed rather than
                 as a flash. */
              const duration = isCmd
                ? Math.min(1.15, Math.max(0.3, chars * 0.038))
                : Math.min(0.5, Math.max(0.16, chars * 0.006));

              /* .call() rather than gsap.set({attr}) because GSAP's attr plugin
                 has no way to REMOVE an attribute, and `data-on=""` removed by
                 setting it to "false" would still match [data-on] in CSS. */
              if (caret) termTl.call(() => caret.setAttribute("data-on", ""));
              termTl.to(text, { width: widths[i], duration, ease: "none" });
              if (caret) termTl.call(() => caret.removeAttribute("data-on"));
              /* The beat. After a command the machine pauses before it
                 answers; between two output lines it barely pauses at all. */
              termTl.to({}, { duration: isCmd ? 0.32 : 0.09 });
            });

            /* Hand control back to CSS: widths return to natural (so the
               terminal stays responsive) and the settled rule puts the caret
               on the last line, where a finished terminal leaves it. */
            termTl.add(() => {
              parts.forEach(({ text }) => text && gsap.set(text, { clearProps: "width" }));
              termBody.removeAttribute("data-typing");
            });
          }
        }

        /* ── The dashboard under the terminal (§3) ──────────────────────
           This reveals on ITS OWN position in the viewport, never on the
           terminal's typing timeline. It used to be the last beat of termTl,
           roughly 2.4s after the terminal hit its trigger, so anyone who
           scrolled down at a normal pace arrived to a blank box and waited
           out a timer they could not see. It is the payoff of the section —
           it should be there when its space is. */
        const result = document.querySelector<HTMLElement>("[data-terminal-result]");
        if (result) {
          /* Same late-arrival policy as everything else: if this chunk loads
             with the dashboard already on screen, leave the settled SSR
             content alone rather than hiding and replaying it. */
          const START = 0.92; // fraction of viewport height, matches the trigger below
          if (result.getBoundingClientRect().top >= window.innerHeight * START) {
            gsap.set(result, { autoAlpha: 0, y: 16 });
            gsap.to(result, {
              autoAlpha: 1,
              y: 0,
              duration: 0.5,
              ease: "power2.out",
              scrollTrigger: { trigger: result, start: `top ${START * 100}%`, once: true },
              onComplete: () => gsap.set(result, { clearProps: "all" }),
            });
          }
        }

        /* ── Approval demo (§10): the demo PARKS at the decision.
           Warp's approvalGate pattern — the timeline genuinely waits for a
           human (approve/deny buttons), with a 4s grace resume so passive
           viewers still get the story. Finite either way (WCAG 2.2.2);
           the parked "thinking" shimmer is bounded by the grace window. */
        const approvalDemo = document.querySelector<HTMLElement>("[data-approval-demo]");
        const approvalStates = gsap.utils.toArray<HTMLElement>("[data-approval-state]");
        if (approvalDemo && approvalStates.length === 3) {
          const actions = approvalDemo.querySelector<HTMLElement>("[data-approval-actions]");
          const approveBtn = approvalDemo.querySelector<HTMLElement>("[data-approval-approve]");
          const denyBtn = approvalDemo.querySelector<HTMLElement>("[data-approval-deny]");
          const requestedPill = approvalStates[0].querySelector<HTMLElement>("[data-approval-pill]");
          let decided = false;
          let graceTimer = 0;

          const spotlight = (i: number) =>
            gsap.to(approvalStates, {
              autoAlpha: (j: number) => (j === i ? 1 : 0.35),
              scale: (j: number) => (j === i ? 1 : 0.985),
              duration: 0.35,
              ease: "power2.inOut",
            });

          const pass = gsap.timeline({
            scrollTrigger: { trigger: approvalDemo, start: "top 75%", once: true },
          });
          if (actions) pass.set(actions, { autoAlpha: 0 }, 0);
          pass.add(spotlight(0));
          pass.to({}, { duration: 0.6 });
          pass.call(() => {
            // PARK — the runtime is waiting on a human, so is the page
            approvalDemo.setAttribute("data-parked", "");
            if (actions) gsap.to(actions, { autoAlpha: 1, duration: 0.35 });
            pass.pause();
            graceTimer = window.setTimeout(() => resolveGate(true), 4000);
          });
          // approved path (played on resume)
          pass.add(spotlight(1));
          pass.to({}, { duration: 1.1 });
          pass.add(spotlight(2));
          pass.to({}, { duration: 1.6 });
          pass.to(approvalStates, { autoAlpha: 1, scale: 1, duration: 0.4, ease: "power2.inOut" });
          if (actions) pass.to(actions, { autoAlpha: 0, duration: 0.3 }, "<");

          const resolveGate = (approved: boolean) => {
            if (decided) return;
            decided = true;
            window.clearTimeout(graceTimer);
            approvalDemo.removeAttribute("data-parked");
            if (approved) {
              pass.play();
              return;
            }
            // denied: nothing runs — the pill says so, the outcomes stay dim
            if (requestedPill) {
              requestedPill.textContent = "denied";
              requestedPill.classList.remove("border-warn/40", "text-warn");
              requestedPill.classList.add("border-err/40", "text-err");
            }
            pass.kill();
            gsap.to(approvalStates[0], { autoAlpha: 1, scale: 1, duration: 0.3 });
            gsap.to(approvalStates.slice(1), { autoAlpha: 0.35, scale: 0.985, duration: 0.3 });
            if (actions) gsap.to(actions, { autoAlpha: 0, duration: 0.3, delay: 0.6 });
          };
          approveBtn?.addEventListener("click", () => resolveGate(true), { signal: uiAbort.signal });
          denyBtn?.addEventListener("click", () => resolveGate(false), { signal: uiAbort.signal });
          uiAbort.signal.addEventListener("abort", () => window.clearTimeout(graceTimer));
        }

        /* ── Screenshot perspective tilt (§8) ──────────────────────── */
        gsap.utils.toArray<HTMLElement>("[data-screenshot-tilt]").forEach((el) => {
          gsap.set(el.parentElement, { perspective: 1200 });
          gsap.fromTo(
            el,
            { rotateX: 9, y: 40, scale: 0.97, transformOrigin: "center bottom" },
            {
              rotateX: 0,
              y: 0,
              scale: 1,
              ease: "none",
              scrollTrigger: { trigger: el, start: "top 90%", end: "top 40%", scrub: 0.6 },
            },
          );
        });

        /* ── The one scramble stat ─────────────────────────────────── */
        const scramble = document.querySelector<HTMLElement>("[data-scramble]");
        if (scramble) {
          const finalText = scramble.textContent ?? "";
          gsap.to(scramble, {
            duration: 0.9,
            scrambleText: { text: finalText, chars: "▖▘▝▗▚▞01", speed: 0.4 },
            scrollTrigger: { trigger: scramble, start: "top 75%", once: true },
          });
        }

        /* ── Magnetic buttons ──────────────────────────────────────── */
        gsap.utils.toArray<HTMLElement>("[data-magnetic]").forEach((el) => {
          const xTo = gsap.quickTo(el, "x", { duration: 0.4, ease: "power3.out" });
          const yTo = gsap.quickTo(el, "y", { duration: 0.4, ease: "power3.out" });
          const onMove = (e: PointerEvent) => {
            const rect = el.getBoundingClientRect();
            const dx = e.clientX - (rect.left + rect.width / 2);
            const dy = e.clientY - (rect.top + rect.height / 2);
            xTo(gsap.utils.clamp(-12, 12, dx * 0.25));
            yTo(gsap.utils.clamp(-12, 12, dy * 0.25));
          };
          const onLeave = () => {
            xTo(0);
            yTo(0);
          };
          el.addEventListener("pointermove", onMove, { signal: uiAbort.signal });
          el.addEventListener("pointerleave", onLeave, { signal: uiAbort.signal });
        });

        /* ── Bento event-ticker mini (finite — WCAG 2.2.2) ─────────── */
        const ticker = document.querySelector<HTMLElement>("[data-demo='events']");
        if (ticker) {
          gsap.to(ticker.children, {
            autoAlpha: 0.35,
            duration: 0.5,
            stagger: { each: 0.5, repeat: 5, yoyo: true },
            scrollTrigger: { trigger: ticker, start: "top 85%", once: true },
          });
        }

        /* ── Header scrollspy ──────────────────────────────────────── */
        /* Match on the hash, not the whole href: since the site gained a
           /docs route the header links are home-absolute (/#compare), and
           feeding that to querySelector throws on an invalid selector. */
        document
          .querySelectorAll<HTMLAnchorElement>("[data-scrollspy] a[href*='#']")
          .forEach((link) => {
            const target = link.hash ? document.querySelector(link.hash) : null;
            if (!target) return;
            ScrollTrigger.create({
              trigger: target,
              start: "top center",
              end: "bottom center",
              onToggle: (self) => {
                if (self.isActive) link.setAttribute("data-active", "");
                else link.removeAttribute("data-active");
              },
            });
          });

        /* refresh after images decode (fonts already awaited) */
        const refresh = () => ScrollTrigger.refresh();
        window.addEventListener("load", refresh);
        return () => {
          uiAbort.abort();
          window.removeEventListener("load", refresh);
        };
      });

      return () => mm.revert();
    },
    { dependencies: [fontsReady] },
  );

  return null;
}


export default function ChoreographyRoot({ onReady }: { onReady?: () => void }) {
  /* Signal MotionRoot that the raf driver is live — only then may Lenis
     arm smoothWheel (see motion-root.tsx). */
  useEffect(() => {
    onReady?.();
  }, [onReady]);

  return (
    <>
      <LenisSync />
      <Choreography />
    </>
  );
}
