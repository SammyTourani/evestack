/* Pure data — NO three import. Safe for the initial route bundle
   (hero-client renders labels from this); the geometry builder lives in
   slab-geometry.ts inside the lazy 3D chunk. */

export const SLAB = {
  size: 1.55,
  depth: 0.5,
  chamfer: 0.06,
  corner: 0.04,
  gap: 0.18,
  /** grid center offset: (size + gap) / 2 */
  offset: (1.55 + 0.18) / 2,
  proudZ: 0.32,
  recessedZ: -0.14,
} as const;

/* Quadrant layout — the ▚ glyph (UL + LR filled/proud, UR + LL recessed).
   Each quadrant is a real architecture layer; scroll disassembly re-sorts
   them into labeled rows (dashboard / agent / postgres / sandbox). */
export interface SlabSpec {
  id: "dashboard" | "agent" | "postgres" | "sandbox";
  label: string;
  badge: string;
  x: number;
  y: number;
  z: number;
  proud: boolean;
  /** target row y-position for the scroll disassembly */
  rowY: number;
}

export const SLABS: SlabSpec[] = [
  {
    id: "dashboard",
    label: "dashboard",
    badge: ":4000",
    x: -SLAB.offset,
    y: SLAB.offset,
    z: SLAB.proudZ,
    proud: true,
    rowY: 1.95,
  },
  {
    id: "agent",
    label: "agent runtime",
    badge: ":2000",
    x: SLAB.offset,
    y: SLAB.offset,
    z: SLAB.recessedZ,
    proud: false,
    rowY: 0.65,
  },
  {
    id: "postgres",
    label: "Postgres",
    badge: ":5433",
    x: -SLAB.offset,
    y: -SLAB.offset,
    z: SLAB.recessedZ,
    proud: false,
    rowY: -0.65,
  },
  {
    id: "sandbox",
    label: "sandbox",
    badge: "docker.sock",
    x: SLAB.offset,
    y: -SLAB.offset,
    z: SLAB.proudZ,
    proud: true,
    rowY: -1.95,
  },
];
