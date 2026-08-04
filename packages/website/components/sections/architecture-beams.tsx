"use client";

import { useEffect, useState } from "react";
import { architecture } from "@/lib/copy";

/* Measures the server-rendered node cards and overlays SVG beams that
   PLUG INTO box edges: anchors sit flush on the border (endpoint dots
   included), parallel beams land at spread offsets, and the SQL return
   path arcs over the top instead of crossing the agent card.
   Pulses ride each path via SMIL animateMotion. Reduced motion: static. */

type Side = "left" | "right" | "top";

interface RouteSpec {
  from: string;
  to: string;
  fromSide: Side;
  toSide: Side;
  fromOffset?: number;
  toOffset?: number;
  /** vertical arc height for top-routed beams */
  arc?: number;
}

/* Routing is presentation detail — labels come from lib/copy.ts beams,
   matched by from/to ids. */
const ROUTES: RouteSpec[] = [
  { from: "agent", to: "postgres", fromSide: "left", toSide: "right", fromOffset: -14 },
  { from: "agent", to: "sandbox", fromSide: "left", toSide: "right", fromOffset: 14 },
  { from: "agent", to: "dashboard", fromSide: "right", toSide: "left" },
  { from: "dashboard", to: "postgres", fromSide: "top", toSide: "top", arc: 38 },
];

interface Beam {
  d: string;
  label: string;
  labelPos: { x: number; y: number };
  ends: { x: number; y: number }[];
  duration: number;
}

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

      const rect = (id: string) => {
        const el = container.querySelector<HTMLElement>(`[data-arch-node='${id}']`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: r.left - crect.left,
          right: r.right - crect.left,
          top: r.top - crect.top,
          bottom: r.bottom - crect.top,
          cx: r.left - crect.left + r.width / 2,
          cy: r.top - crect.top + r.height / 2,
        };
      };

      const anchor = (id: string, side: Side, offset = 0) => {
        const r = rect(id);
        if (!r) return null;
        if (side === "left") return { x: r.left, y: r.cy + offset };
        if (side === "right") return { x: r.right, y: r.cy + offset };
        return { x: r.cx + offset, y: r.top };
      };

      const next: Beam[] = [];
      ROUTES.forEach((route, i) => {
        const meta = architecture.beams.find((b) => b.from === route.from && b.to === route.to);
        const a = anchor(route.from, route.fromSide, route.fromOffset);
        const b = anchor(route.to, route.toSide, route.toOffset);
        if (!a || !b || !meta) return;

        let d: string;
        let labelPos: { x: number; y: number };
        if (route.fromSide === "top" && route.toSide === "top") {
          const apex = Math.min(a.y, b.y) - (route.arc ?? 56);
          d = `M ${a.x} ${a.y} C ${a.x} ${apex}, ${b.x} ${apex}, ${b.x} ${b.y}`;
          labelPos = { x: (a.x + b.x) / 2, y: apex + 14 };
        } else {
          const bend = Math.max(24, Math.abs(b.x - a.x) * 0.38);
          const dir = b.x > a.x ? 1 : -1;
          d = `M ${a.x} ${a.y} C ${a.x + bend * dir} ${a.y}, ${b.x - bend * dir} ${b.y}, ${b.x} ${b.y}`;
          labelPos = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 10 };
        }
        next.push({
          d,
          label: meta.label,
          labelPos,
          ends: [a, b],
          duration: 2.6 + i * 0.7,
        });
      });
      setBeams(next);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    // re-measure once fonts settle (border positions shift subpixel)
    document.fonts?.ready.then(measure).catch(() => {});
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
          {/* endpoint plugs — flush on the box borders */}
          {beam.ends.map((end, j) => (
            <circle key={j} cx={end.x} cy={end.y} r="2.5" fill="var(--ds-gray-500)" />
          ))}
          {!reduced ? (
            <circle r="2.5" fill="var(--ds-blue-700)" opacity="0.9">
              <animateMotion
                dur={`${beam.duration}s`}
                repeatCount="indefinite"
                path={beam.d}
                keyPoints="0;1"
                keyTimes="0;1"
                calcMode="linear"
              />
            </circle>
          ) : null}
          <text
            x={beam.labelPos.x}
            y={beam.labelPos.y}
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
