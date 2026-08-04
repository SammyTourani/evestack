"use client";

import { useEffect, useState } from "react";
import { architecture } from "@/lib/copy";

interface Beam {
  d: string;
  label: string;
  mid: { x: number; y: number };
}

/* Measures the server-rendered node cards and overlays curved SVG beams.
   Pulses ride each path via SMIL animateMotion (zero JS per frame).
   Reduced motion: static hairline paths, no pulses. */
export function ArchitectureBeams() {
  const [beams, setBeams] = useState<Beam[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);

    const container = document.querySelector<HTMLElement>("[data-arch-container]");
    if (!container) return;

    const measure = () => {
      const crect = container.getBoundingClientRect();
      setSize({ w: crect.width, h: crect.height });
      const anchor = (id: string) => {
        const el = container.querySelector<HTMLElement>(`[data-arch-node='${id}']`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          cx: r.left - crect.left + r.width / 2,
          cy: r.top - crect.top + r.height / 2,
          left: r.left - crect.left,
          right: r.right - crect.left,
        };
      };
      const next: Beam[] = [];
      for (const beam of architecture.beams) {
        const from = anchor(beam.from);
        const to = anchor(beam.to);
        if (!from || !to) continue;
        const x1 = from.cx < to.cx ? from.right + 6 : from.left - 6;
        const x2 = from.cx < to.cx ? to.left - 6 : to.right + 6;
        const y1 = from.cy;
        const y2 = to.cy;
        const bend = Math.abs(x2 - x1) * 0.4;
        const d = `M ${x1} ${y1} C ${x1 + (x2 > x1 ? bend : -bend)} ${y1}, ${
          x2 + (x2 > x1 ? -bend : bend)
        } ${y2}, ${x2} ${y2}`;
        next.push({ d, label: beam.label, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } });
      }
      setBeams(next);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  if (!beams.length) return null;

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox={`0 0 ${size.w} ${size.h}`}
      fill="none"
      aria-hidden
    >
      {beams.map((beam, i) => (
        <g key={i}>
          <path d={beam.d} stroke="var(--ds-border-default)" strokeWidth="1" />
          {!reduced ? (
            <circle r="2.5" fill="var(--ds-blue-700)" opacity="0.9">
              <animateMotion
                dur={`${2.6 + i * 0.7}s`}
                repeatCount="indefinite"
                path={beam.d}
                keyPoints="0;1"
                keyTimes="0;1"
                calcMode="linear"
              />
            </circle>
          ) : null}
          <text
            x={beam.mid.x}
            y={beam.mid.y - 8}
            textAnchor="middle"
            className="fill-gray-700 font-mono"
            style={{ fontSize: 11 }}
          >
            {beam.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
