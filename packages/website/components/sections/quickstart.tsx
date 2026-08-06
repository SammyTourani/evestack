"use client";

import { useEffect, useRef, useState } from "react";
import { Section, SectionHeading } from "@/components/ui/section";
import { quickstart } from "@/lib/copy";
import { cn } from "@/lib/utils";

/* §9 quickstart — the pipeline and the receipt.

   Left: the four steps as a pipeline that completes itself once, in view —
   stations flip to ✓, an ok-green spine draws downward station to station,
   and each step's real receipt line rises in. Right: the verify receipt —
   the full output of `npm run verify`, pre-rendered as dim ghost lines
   (layout never shifts, the promise is visible before it "runs") that flip
   to full ink in a cascade and end on the line the script really ends on.

   Deliberately NOT a typing demo: §01 owns typing. This section trades in
   finished, real artifacts — a run that already happened, stamped onto the
   page. One shot, no loop; it settles and stays settled.

   Interaction grammar (the research consensus, three sites each):
     - every command row IS its copy button — the `$` prompt is aria-hidden
       decoration and never enters the clipboard; boilerplate renders dim,
       the payload bright;
     - the copy glyph swaps to an ok-green check for 1.5s;
     - the receipt links its own source (verify.mjs) the way Bun links its
       install script.

   Motion contract (identical to MonitorsPanel): SSR renders the SETTLED
   state — every station ✓, spine drawn, receipt at full ink — which is the
   no-JS and reduced-motion truth. Client-side, with motion allowed, the
   component ARMS itself (data-armed hides the played pieces), then one
   IntersectionObserver per column stamps data-live and pure CSS
   transition/animation delays play the whole choreography. No timers. */

const STEP_BEAT = 0.45; // seconds between stations completing

function CopyIcon({ copied }: { copied: boolean }) {
  return copied ? (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className="text-ok">
      <path d="M2.5 8.5 6 12l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5V9A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
}

/* The whole row is the button (Convex/opencode): click anywhere to copy.
   Payload = pre + cmd, never the prompt. */
function CommandRow({ pre, cmd }: { pre: string; cmd: string }) {
  const [copied, setCopied] = useState(false);
  const full = pre + cmd;
  return (
    <button
      type="button"
      aria-label={`Copy "${full}"`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(full);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
      /* A filled plate, not an outlined box: five hairline rectangles
         stacked down the rail read as clutter, one quiet surface each does
         not. The panel keeps the border, so card and chip stay distinct. */
      className="group/cmd flex w-full items-center gap-3 rounded-lg bg-gray-100 px-4 py-2 text-left font-mono text-mono-13 transition-colors hover:bg-gray-200"
    >
      <span aria-hidden className="select-none text-gray-600">
        $
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-gray-700">{pre}</span>
        <span className="font-medium text-gray-1000">{cmd}</span>
      </span>
      <span className="text-gray-600 transition-colors group-hover/cmd:text-gray-1000">
        <CopyIcon copied={copied} />
      </span>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

function AgentPath() {
  const [copied, setCopied] = useState(false);
  return (
    <p className="mt-12 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 font-mono text-label-12 text-gray-700">
      {quickstart.agent.lead}
      <button
        type="button"
        aria-label={`Copy "${quickstart.agent.copy}"`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(quickstart.agent.copy);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* no-op */
          }
        }}
        className="inline-flex items-center gap-1.5 text-gray-1000 underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-current"
      >
        {quickstart.agent.display}
        <CopyIcon copied={copied} />
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </p>
  );
}

export function Quickstart() {
  const railRef = useRef<HTMLDivElement>(null);
  const olRef = useRef<HTMLOListElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [armed, setArmed] = useState(false);
  const [railLive, setRailLive] = useState(false);
  const [panelLive, setPanelLive] = useState(false);
  const [spineH, setSpineH] = useState<number | null>(null);

  /* The spine must STOP at the last station, not run on past it — a line
     trailing below the final ✓ reads as unfinished. Its length is the last
     item's offset (dot centers sit 1rem into each item, so the difference
     between the first and last is exactly dot-centre to dot-centre), which
     is content-dependent and therefore measured rather than hardcoded.
     Re-measured on reflow; the CSS carries a full-height fallback for the
     frame before this runs and for no-JS. */
  useEffect(() => {
    const ol = olRef.current;
    if (!ol) return;
    const measure = () => {
      const last = ol.lastElementChild as HTMLElement | null;
      if (last) setSpineH(last.offsetTop);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ol);
    return () => ro.disconnect();
  }, []);

  /* Arm only client-side with motion allowed; play once per column when it
     enters the viewport (MonitorsPanel's exact machinery). Two observers so
     the stacked mobile layout plays the receipt when the receipt arrives,
     not while it is still below the fold. */
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rail = railRef.current;
    const panel = panelRef.current;
    if (!rail || !panel) return;
    setArmed(true);
    const watch = (el: Element, fire: () => void) => {
      const io = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) return;
          io.disconnect();
          fire();
        },
        { rootMargin: "0px 0px -22% 0px" },
      );
      io.observe(el);
      return io;
    };
    const a = watch(rail, () => setRailLive(true));
    const b = watch(panel, () => setPanelLive(true));
    return () => {
      a.disconnect();
      b.disconnect();
    };
  }, []);

  const { verify } = quickstart;
  /* Receipt cascade timing: header first, checks at a steady 100ms, then the
     payoff block on widening beats. All of it is transition/animation-delay
     math — one data-live stamp plays everything. */
  const checkDelay = (i: number) => 0.3 + i * 0.1;
  const doneAt = 0.3 + verify.checks.length * 0.1 + 0.35;

  return (
    <Section id="quickstart">
      <SectionHeading
        id="quickstart-heading"
        eyebrow="09 · quickstart"
        title={quickstart.heading}
        sub={quickstart.sub}
      />

      {/* The receipt centres on the rail's midpoint. The two columns are
          tuned to near-equal height (the receipt breathes like a terminal,
          the rail stays tight), so centring reads as symmetry rather than as
          a panel floating in a taller column. */}
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] xl:gap-16">
        {/* ── the pipeline ─────────────────────────────────────────── */}
        <div
          ref={railRef}
          className="qs relative"
          data-armed={armed || undefined}
          data-live={railLive || undefined}
          style={spineH != null ? ({ "--qs-spine": `${spineH}px` } as React.CSSProperties) : undefined}
        >
          {/* ONE continuous spine, not a segment per step: steps are not the
              same height (02 carries two commands), so per-step segments came
              out visibly different lengths and read as an accident. A single
              track with a single fill draws straight through every station
              and terminates on the last one. */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-[15.5px] top-4 h-[var(--qs-spine,calc(100%-1.75rem))] w-px bg-border-subtle"
          >
            <span data-qs-seg className="absolute inset-0 origin-top bg-ok/60" />
          </span>

          <ol ref={olRef}>
            {quickstart.steps.map((step, i) => (
              <li
                key={step.slug}
                id={`quickstart-${step.slug}`}
                className="relative pb-9 pl-12 last:pb-0"
                style={{ "--d": `${i * STEP_BEAT}s` } as React.CSSProperties}
              >
                {/* station dot: number at rest, ✓ once done, one ping ring */}
                <span
                  data-qs-dot
                  aria-hidden
                  className="absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-ok/25 bg-background-100"
                >
                  <span data-qs-num className="font-mono text-mono-13 text-gray-900">
                    {i + 1}
                  </span>
                  <svg
                    data-qs-check
                    viewBox="0 0 16 16"
                    width="13"
                    height="13"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="absolute text-ok"
                  >
                    <path d="M2.5 8.5 6 12l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span data-qs-ping className="absolute inset-0 rounded-full border border-ok" />
                </span>

                {/* One measure for the whole step, so commands and their
                    receipts share a right edge instead of running ragged. */}
                <div className="flex max-w-md flex-col gap-3">
                  <div className="flex items-baseline gap-2.5">
                    <h3 className="text-heading-20">{step.title}</h3>
                    <span aria-hidden className="font-mono text-label-12 text-gray-600">
                      0{i + 1}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {step.commands.map((c) => (
                      <CommandRow key={c.cmd} pre={c.pre} cmd={c.cmd} />
                    ))}
                    {/* indented to sit under its command's `$` — this line is
                        that command's output, and should read as such */}
                    <p
                      data-qs-rcpt
                      className="flex items-start gap-2 pl-4 pt-1 font-mono text-mono-13 text-gray-700"
                      style={{ "--d": `${i * STEP_BEAT + 0.25}s` } as React.CSSProperties}
                    >
                      <span aria-hidden className="text-ok">
                        ✓
                      </span>
                      {step.receipt}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* ── the receipt ──────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-3">
          <figure
            ref={panelRef}
            className="qsp overflow-hidden rounded-xl border border-border-default bg-background-200"
            data-armed={armed || undefined}
            data-live={panelLive || undefined}
            aria-label="The output of npm run verify"
          >
            <figcaption className="flex h-10 items-center justify-between gap-3 border-b border-border-subtle px-4">
              <span className="font-mono text-mono-13">
                <span aria-hidden className="select-none text-gray-600">
                  ${" "}
                </span>
                <span className="text-gray-1000">npm run verify</span>
              </span>
              <a
                href={verify.source.href}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-label-12 text-gray-700 transition-colors hover:text-gray-1000"
              >
                {verify.source.label} ↗
              </a>
            </figcaption>

            <div className="overflow-x-auto p-5 font-mono text-mono-13">
              <p data-qs-row className="font-medium text-gray-1000" style={{ "--d": "0.1s" } as React.CSSProperties}>
                {verify.header}
              </p>

              {/* gap-2 between checks: a real terminal has air between its
                  lines, and it brings this column to the rail's height */}
              <div className="mt-4 flex flex-col gap-2">
                {verify.checks.map((c, i) => (
                  <p
                    key={c.name}
                    data-qs-row
                    data-qs-flash
                    className="whitespace-pre"
                    style={{ "--d": `${checkDelay(i)}s` } as React.CSSProperties}
                  >
                    <span data-qs-ok className="text-ok">
                      ✓{" "}
                    </span>
                    <span className="text-gray-1000">{c.name.padEnd(10)}</span>
                    <span className="text-gray-900"> {c.detail}</span>
                  </p>
                ))}
              </div>

              <p
                data-qs-row
                data-qs-flash
                className="mt-5 font-medium text-ok"
                style={{ "--d": `${doneAt}s` } as React.CSSProperties}
              >
                {verify.done}
              </p>

              <div className="mt-5 flex flex-col gap-1.5 whitespace-pre">
                <p data-qs-row data-qs-payoff style={{ "--d": `${doneAt + 0.3}s` } as React.CSSProperties}>
                  <span className="font-medium text-gray-1000">{verify.dashboard.label}</span>
                  <span className="text-gray-1000">  {verify.dashboard.value}</span>
                </p>
                <p data-qs-row style={{ "--d": `${doneAt + 0.4}s` } as React.CSSProperties}>
                  <span className="font-medium text-gray-1000">{verify.signin.label}</span>
                  <span className="text-gray-1000">
                    {"         "}
                    {verify.signin.user}
                  </span>
                  <span className="text-gray-600"> / </span>
                  <span className="text-gray-600">{verify.signin.mask}</span>
                </p>
              </div>

              <p
                data-qs-row
                className="mt-5 text-gray-700"
                style={{ "--d": `${doneAt + 0.65}s` } as React.CSSProperties}
              >
                <span className="font-medium text-gray-1000">? </span>
                {verify.prompt}
              </p>
            </div>
          </figure>
        </div>
      </div>

      {/* the alternative path, as one quiet line under both columns */}
      <AgentPath />
    </Section>
  );
}
