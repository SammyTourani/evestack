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
        /* ── Hero entrance (once, on load) ─────────────────────────────
           This chunk loads post-hydration; if it arrived late (slow
           network), the content has been visible for a while — skip the
           intro rather than hide-and-replay it. */
        const runEntrance = performance.now() < 2500 && window.scrollY < 80;
        const badge = document.querySelector("[data-hero='badge']");
        const h1 = document.querySelector<HTMLElement>("#hero-heading");
        const sub = document.querySelector<HTMLElement>("[data-hero='sub']");
        const ctas = document.querySelector("[data-hero='ctas']");
        const toggle = document.querySelector("[data-hero='toggle']");

        if (runEntrance) {
          /* fromTo with EXPLICIT end values everywhere — .from() captures
             "current" as the destination, which resize/refresh re-renders
             can poison mid-flight (observed: buttons frozen at opacity 0).
             onComplete clears every inline prop so no tween state survives
             the intro. */
          const entranceTargets: Element[] = [
            ...(badge ? [badge] : []),
            ...(sub ? [sub] : []),
            ...(ctas ? Array.from((ctas as HTMLElement).children) : []),
            ...(toggle ? [toggle] : []),
          ];
          let split: SplitText | null = null;
          const heroTl = gsap.timeline({
            defaults: { ease: "power2.out" },
            onComplete: () => {
              split?.revert();
              gsap.set(entranceTargets, { clearProps: "all" });
            },
          });
          if (badge) {
            heroTl.fromTo(
              badge,
              { autoAlpha: 0, y: 8, filter: "blur(8px)" },
              { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.5 },
            );
          }
          if (h1) {
            split = SplitText.create(h1, { type: "lines", mask: "lines" });
            heroTl.fromTo(
              split.lines,
              { yPercent: 110 },
              { yPercent: 0, duration: 0.9, ease: "expo.out", stagger: 0.09 },
              0.1,
            );
          }
          if (sub) {
            heroTl.fromTo(
              sub,
              { autoAlpha: 0, y: 10, filter: "blur(6px)" },
              { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.7 },
              0.35,
            );
          }
          if (ctas) {
            heroTl.fromTo(
              (ctas as HTMLElement).children,
              { autoAlpha: 0, y: 10 },
              { autoAlpha: 1, y: 0, duration: 0.55, stagger: 0.07 },
              0.5,
            );
          }
          if (toggle) {
            heroTl.fromTo(
              toggle,
              { autoAlpha: 0 },
              { autoAlpha: 1, duration: 0.5 },
              0.75,
            );
          }
        }

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
        // timeline positions ≡ progress fractions (duration 1)
        if (heroCopy) {
          scrub.fromTo(heroCopy, { y: 0, autoAlpha: 1 }, { y: -40, autoAlpha: 0, duration: 0.12 }, 0);
        }
        if (toggle) {
          // explicit values + no immediate render: never captures a
          // mid-entrance hidden state as its resting value
          scrub.fromTo(
            toggle,
            { autoAlpha: 1 },
            { autoAlpha: 0, duration: 0.06, immediateRender: false },
            0,
          );
        }
        if (annotations) {
          scrub.to(annotations, { autoAlpha: 1, duration: 0.02 }, 0.56);
        }
        if (spine) {
          scrub.to(spine, { strokeDashoffset: 0, duration: 0.3, ease: "power1.inOut" }, 0.6);
        }
        labels.forEach((label, i) => {
          scrub.to(label, { autoAlpha: 1, x: 0, duration: 0.1 }, 0.62 + i * 0.06);
        });

        /* ── Site-wide reveals ─────────────────────────────────────── */
        gsap.utils.toArray<HTMLElement>("[data-reveal='lines']").forEach((el) => {
          // skip elements inside the hero (choreographed above)
          if (el.closest("#hero")) return;
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

        /* ── Terminal typing (§3) ──────────────────────────────────── */
        const terminal = document.querySelector<HTMLElement>("[data-terminal]");
        if (terminal) {
          const prompt = terminal.querySelector<HTMLElement>("[data-terminal-prompt]");
          const lines = gsap.utils.toArray<HTMLElement>("[data-terminal-line]", terminal);
          const result = document.querySelector<HTMLElement>("[data-terminal-result]");
          const termTl = gsap.timeline({
            scrollTrigger: { trigger: terminal, start: "top 70%", once: true },
          });
          if (prompt) {
            const chars = SplitText.create(prompt, { type: "chars", aria: "none" });
            termTl.set(chars.chars, { visibility: "hidden" });
            /* human keystroke cadence: 30–65ms with jitter, never metronomic */
            let typed = 0;
            const keystrokes = chars.chars.map(() => (typed += 0.03 + Math.random() * 0.035));
            termTl.to(chars.chars, {
              visibility: "visible",
              duration: 0.001,
              stagger: (i: number) => keystrokes[i],
            });
          }
          termTl.set(lines, { autoAlpha: 0 }, 0);
          if (result) termTl.set(result, { autoAlpha: 0, y: 24, scale: 0.985 }, 0);
          /* the machine thinks before it speaks — a hard 450ms beat, then
             output cascades at widening, non-uniform intervals */
          const cascade = [0, 0.18, 0.38, 0.6, 0.86, 1.16, 1.48, 1.82, 2.18];
          termTl.to(
            lines,
            {
              autoAlpha: 1,
              y: 0,
              duration: 0.3,
              ease: "power1.out",
              stagger: (i: number) => cascade[Math.min(i, cascade.length - 1)],
            },
            ">+0.45",
          );
          if (result) {
            // the payoff: the dashboard surfaces as the FIRST ✓ lands — it
            // overlaps the cascade tail instead of waiting out the whole
            // typing rhythm (which would leave ~5s of dead space below).
            termTl.to(
              result,
              { autoAlpha: 1, y: 0, scale: 1, duration: 0.6, ease: "power2.inOut" },
              "<+1.0",
            );
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
        document
          .querySelectorAll<HTMLAnchorElement>("[data-scrollspy] a[href^='#']")
          .forEach((link) => {
            const target = document.querySelector(link.getAttribute("href")!);
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
