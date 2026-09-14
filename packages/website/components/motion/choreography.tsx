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

        /* Read once, deliberately, rather than as a matchMedia condition.
           Re-keying on a live resize would revert and replay the whole
           choreography — SplitText re-splitting settled headings, the terminal
           re-arming — which is a flicker the desktop has never had. A phone in
           landscape is 852pt wide and keeps the desktop keying, which is the
           right answer there anyway. */
        const phone = window.matchMedia("(max-width: 47.999rem)").matches;
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
        const spine =
          document.querySelector<SVGPathElement>("[data-hero-spine]");
        const heroCopy =
          document.querySelector<HTMLElement>("[data-hero-copy]");

        const annotations = document.querySelector<HTMLElement>(
          "[data-hero-annotations]",
        );
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
        /* PHONE: THE DIAGRAM SETTLES DOWNWARD AS IT EXPLODES.
           The stage is lifted ~7rem so the assembled mark clears the headline
           at rest. Once the scrub starts, the copy fades out — and that lift
           becomes pure dead space under the finished diagram, which is the band
           Sammy kept pointing at between "sandbox docker.sock" and §01. It is
           not scroll length, it is empty pixels inside the last frame.

           So the lift is spent rather than held: the group slides DOWN 170px
           across the disassembly, which lands the finished diagram and its
           legend near the middle of the payoff frame instead of pinned to the
           top third. Measured at 390x844 the dead band under "sandbox
           docker.sock" goes 247px -> ~77px, and at 390x664 the top bar stops
           tucking under the header.

           The sign is easy to get wrong: --stage-shift is added inside a
           NEGATED translate, so a positive value moves the group UP and makes
           the band bigger. Down is negative. GSAP writes `transform` and
           Tailwind's -translate-* compile to `translate`, which are separate
           properties that compose — so this adds to the lift rather than
           fighting it, and nothing has to restate the base position. */
        if (phone) {
          scrub.fromTo(
            "[data-hero-stage]",
            { "--stage-shift": "0px" },
            { "--stage-shift": "-170px", ease: "none", duration: 0.62 },
            0.12,
          );
        }

        // timeline positions ≡ progress fractions (duration 1).
        // Beat map mirrors stack-mark.tsx: unglyph 0.10–0.38, explode
        // 0.34–0.895 (stagger 0.045, travel-then-widen).
        if (heroCopy) {
          scrub.fromTo(
            heroCopy,
            { y: 0, autoAlpha: 1 },
            { y: -40, autoAlpha: 0, duration: 0.1 },
            0,
          );
        }
        if (annotations) {
          scrub.to(annotations, { autoAlpha: 1, duration: 0.02 }, 0.52);
        }
        if (spine) {
          scrub.to(
            spine,
            { strokeDashoffset: 0, duration: 0.26, ease: "power1.inOut" },
            0.54,
          );
        }
        // labels cascade strictly TOP → BOTTOM (user-locked: dashboard,
        // agent runtime, Postgres, sandbox) — a steady reading rhythm,
        // independent of the bars' deal order. Bars are ≥97% into their
        // rows by the time their label lands, so nothing points at air.
        labels.forEach((label, i) => {
          scrub.to(
            label,
            { autoAlpha: 1, x: 0, duration: 0.08 },
            0.68 + i * 0.045,
          );
        });
        // Anchor: ScrollTrigger scrubs across the timeline's DURATION, so
        // positions only read as progress fractions if the total is exactly
        // 1 — pin it (last real tween ends at 0.84).
        scrub.set({}, {}, 1);

        /* ── Site-wide reveals ─────────────────────────────────────── */
        gsap.utils
          .toArray<HTMLElement>("[data-reveal='lines']")
          .forEach((el) => {
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
            if (
              clip.webkitBackgroundClip === "text" ||
              clip.backgroundClip === "text"
            )
              return;
            const split = SplitText.create(el, {
              type: "lines",
              mask: "lines",
            });
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

        gsap.utils
          .toArray<HTMLElement>(
            phone
              ? "[data-reveal='stagger'], [data-reveal='phone-stagger']"
              : "[data-reveal='stagger']",
          )
          .forEach((el) => {
            if (phone) {
              /* One column here, so the container runs up to 1,719px tall —
                 measured in §features at 393x852, six children at y = 1 / 308 /
                 563 / 834 / 1165 / 1448 from its own top. `top 80%` fires with
                 170px of it on screen, so children 2..6 run AND FINISH a 0.7s
                 tween as much as 1,448px below the fold and the reader meets
                 five cards already at rest. Key each child to its own arrival
                 instead; slightly tightened, because on a phone the card is
                 already moving by the time it lands. */
              gsap.utils.toArray<HTMLElement>(el.children).forEach((kid) => {
                gsap.fromTo(
                  kid,
                  { autoAlpha: 0, y: 18 },
                  {
                    autoAlpha: 1,
                    y: 0,
                    duration: 0.55,
                    ease: "power2.out",
                    scrollTrigger: {
                      trigger: kid,
                      start: "top 92%",
                      once: true,
                    },
                    onComplete: () => gsap.set(kid, { clearProps: "all" }),
                  },
                );
              });
              return;
            }
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
        gsap.utils
          .toArray<HTMLElement>("[data-reveal='decode']")
          .forEach((el) => {
            if (phone) {
              /* Same defect, same fix: §architecture measured 1,238px tall at
               393x852 with three children at y = 0 / 408 / 854, so cards two
               and three decoded off-screen. */
              gsap.utils.toArray<HTMLElement>(el.children).forEach((kid) => {
                gsap.fromTo(
                  kid,
                  { autoAlpha: 0, y: 14, filter: "blur(8px)" },
                  {
                    autoAlpha: 1,
                    y: 0,
                    filter: "blur(0px)",
                    duration: 0.6,
                    ease: "power2.out",
                    scrollTrigger: {
                      trigger: kid,
                      start: "top 92%",
                      once: true,
                    },
                    onComplete: () => gsap.set(kid, { clearProps: "all" }),
                  },
                );
              });
              return;
            }
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

        /* evestack-column checks pop after the row cascade.
           Desktop only: §06 renders a grouped card list on a phone and puts the
           table behind `hidden md:block`, so at 393x852 the table, all six tbody
           rows and all six [data-check] SVGs measure 0x0. Without this guard the
           page sets scale:0 on six invisible SVGs and stands seven
           ScrollTriggers against zero-height triggers. The phone's entrance for
           §06 comes from the card list, which carries data-reveal="phone-stagger"
           and is handled above. */
        const checks = phone
          ? []
          : gsap.utils.toArray<SVGElement>("[data-check]");
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
              scrollTrigger: {
                trigger: "[data-reveal='rows']",
                start: "top 75%",
                once: true,
              },
              onComplete: () => gsap.set(checks, { clearProps: "all" }),
            },
          );
        }

        const tableRows = phone
          ? []
          : gsap.utils.toArray<HTMLElement>("[data-reveal='rows'] tbody tr");
        tableRows.forEach((row, i) => {
          gsap.fromTo(
            row,
            { autoAlpha: 0, y: 12 },
            {
              autoAlpha: 1,
              y: 0,
              duration: 0.5,
              ease: "power2.out",
              delay: (i % 8) * 0.06,
              scrollTrigger: {
                trigger: row.closest("[data-reveal='rows']"),
                start: "top 75%",
                once: true,
              },
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
          const lines = gsap.utils.toArray<HTMLElement>(
            "[data-terminal-line]",
            termBody,
          );
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
            /* PHONES DO NOT TYPE, THEY ARRIVE LINE BY LINE.
               The typing effect animates each line wrapper's WIDTH from 0 to
               its measured natural width. That needs the text to sit on one
               line — and below 48rem it wraps (globals.css), because the
               longest log line is ~462px of 11px mono in a 305px box and no
               type size fixes that. Animating the width of a box whose text
               re-flows on every frame looks exactly as bad as it sounds.

               So the phone gets the same sequence, same order, same two
               speeds, expressed as a per-line reveal instead: each row fades
               and rises as it "prints". No caret choreography either — the
               settled rule in globals.css already parks one on the last line,
               which is what a finished terminal looks like. */
            if (phone) {
              gsap.set(lines, { autoAlpha: 0, y: 6 });
              const phoneTl = gsap.timeline({
                scrollTrigger: {
                  trigger: terminal,
                  start: "top 80%",
                  once: true,
                },
              });
              lines.forEach((line, i) => {
                phoneTl.to(
                  line,
                  { autoAlpha: 1, y: 0, duration: 0.22, ease: "power2.out" },
                  i === 0
                    ? 0
                    : `+=${line.dataset.kind === "cmd" ? 0.16 : 0.07}`,
                );
              });
              phoneTl.call(() => gsap.set(lines, { clearProps: "all" }));
            } else {
              termBody.setAttribute("data-typing", "");
              parts.forEach(({ text }) => text && gsap.set(text, { width: 0 }));

              const termTl = gsap.timeline({
                scrollTrigger: {
                  trigger: terminal,
                  start: "top 70%",
                  once: true,
                },
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
                parts.forEach(
                  ({ text }) => text && gsap.set(text, { clearProps: "width" }),
                );
                termBody.removeAttribute("data-typing");
              });
            }
          }
        }

        /* ── The dashboard under the terminal (§3) ──────────────────────
           This reveals on ITS OWN position in the viewport, never on the
           terminal's typing timeline. It used to be the last beat of termTl,
           roughly 2.4s after the terminal hit its trigger, so anyone who
           scrolled down at a normal pace arrived to a blank box and waited
           out a timer they could not see. It is the payoff of the section —
           it should be there when its space is. */
        const result = document.querySelector<HTMLElement>(
          "[data-terminal-result]",
        );
        if (result) {
          /* Same late-arrival policy as everything else: if this chunk loads
             with the dashboard already on screen, leave the settled SSR
             content alone rather than hiding and replaying it. */
          const START = 0.92; // fraction of viewport height, matches the trigger below
          if (
            result.getBoundingClientRect().top >=
            window.innerHeight * START
          ) {
            gsap.set(result, { autoAlpha: 0, y: 16 });
            gsap.to(result, {
              autoAlpha: 1,
              y: 0,
              duration: 0.5,
              ease: "power2.out",
              scrollTrigger: {
                trigger: result,
                start: `top ${START * 100}%`,
                once: true,
              },
              onComplete: () => gsap.set(result, { clearProps: "all" }),
            });
          }
        }

        /* ── Approval demo (§10): the demo PARKS at the decision.
           Warp's approvalGate pattern — the timeline genuinely waits for a
           human (approve/deny buttons), with a 4s grace resume so passive
           viewers still get the story. Finite either way (WCAG 2.2.2);
           the parked "thinking" shimmer is bounded by the grace window. */
        const approvalDemo = document.querySelector<HTMLElement>(
          "[data-approval-demo]",
        );
        const approvalStates = gsap.utils.toArray<HTMLElement>(
          "[data-approval-state]",
        );
        if (approvalDemo && approvalStates.length === 3) {
          const actions = approvalDemo.querySelector<HTMLElement>(
            "[data-approval-actions]",
          );
          const approveBtn = approvalDemo.querySelector<HTMLElement>(
            "[data-approval-approve]",
          );
          const denyBtn = approvalDemo.querySelector<HTMLElement>(
            "[data-approval-deny]",
          );
          const requestedPill = approvalStates[0].querySelector<HTMLElement>(
            "[data-approval-pill]",
          );
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
            scrollTrigger: {
              trigger: approvalDemo,
              start: "top 75%",
              once: true,
            },
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
          pass.to(approvalStates, {
            autoAlpha: 1,
            scale: 1,
            duration: 0.4,
            ease: "power2.inOut",
          });
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
            gsap.to(approvalStates[0], {
              autoAlpha: 1,
              scale: 1,
              duration: 0.3,
            });
            gsap.to(approvalStates.slice(1), {
              autoAlpha: 0.35,
              scale: 0.985,
              duration: 0.3,
            });
            if (actions)
              gsap.to(actions, { autoAlpha: 0, duration: 0.3, delay: 0.6 });
          };
          approveBtn?.addEventListener("click", () => resolveGate(true), {
            signal: uiAbort.signal,
          });
          denyBtn?.addEventListener("click", () => resolveGate(false), {
            signal: uiAbort.signal,
          });
          uiAbort.signal.addEventListener("abort", () =>
            window.clearTimeout(graceTimer),
          );
        }

        /* ── Screenshot perspective tilt (§8) ──────────────────────── */
        gsap.utils
          .toArray<HTMLElement>("[data-screenshot-tilt]")
          .forEach((el) => {
            /* Desktop only. Below md the panel inside this figure is full-bleed
             (max-md:-mx-5 with its vertical borders removed), and the tilt's
             start state scales it to 0.97 — which paints a ~6px strip of page
             background down each screen edge of a panel that is supposed to
             run edge to edge. It resolves by the end of the scrub, but every
             scroll-in shows the panel peeling off both sides, and that reads
             as a rendering bug rather than as an entrance. Read once, like the
             other capability gates in this file. */
            if (!window.matchMedia("(width >= 48rem)").matches) return;
            gsap.set(el.parentElement, { perspective: 1200 });
            gsap.fromTo(
              el,
              {
                rotateX: 9,
                y: 40,
                scale: 0.97,
                transformOrigin: "center bottom",
              },
              {
                rotateX: 0,
                y: 0,
                scale: 1,
                ease: "none",
                scrollTrigger: {
                  trigger: el,
                  start: "top 90%",
                  end: "top 40%",
                  scrub: 0.6,
                },
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
          const xTo = gsap.quickTo(el, "x", {
            duration: 0.4,
            ease: "power3.out",
          });
          const yTo = gsap.quickTo(el, "y", {
            duration: 0.4,
            ease: "power3.out",
          });
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
          el.addEventListener("pointermove", onMove, {
            signal: uiAbort.signal,
          });
          el.addEventListener("pointerleave", onLeave, {
            signal: uiAbort.signal,
          });
        });

        /* ── Bento event-ticker mini (finite — WCAG 2.2.2) ─────────── */
        const ticker = document.querySelector<HTMLElement>(
          "[data-demo='events']",
        );
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
        /* Desktop only: [data-scrollspy] is `hidden md:block`, so on a phone
           these four ScrollTriggers write data-active onto links nobody can
           see. The phone's nav lives in the <details> panel instead. */
        (phone
          ? []
          : [
              ...document.querySelectorAll<HTMLAnchorElement>(
                "[data-scrollspy] a[href*='#']",
              ),
            ]
        ).forEach((link) => {
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

export default function ChoreographyRoot({
  onReady,
}: {
  onReady?: () => void;
}) {
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
