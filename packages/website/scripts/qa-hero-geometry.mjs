/* Hero disassembly geometry proof: replays the EXACT production pose math
   (imported from slab-choreo.ts — Node strips the types) and SAT-tests
   every slab pair at 2000 scrub positions. Slabs rotate only about x, so
   collision = x-interval overlap AND rotated-rect overlap in the yz plane
   (separating-axis test on both rects' normals).

   Boxes are inflated beyond the true solid (idle-breathing amplitude +
   safety margin; chamfered corners make the real slab strictly smaller),
   so a clean pass here is a conservative proof of no interpenetration.

   Usage: node scripts/qa-hero-geometry.mjs */
import { SLABS } from "../components/three/hero/slab-data.ts";
import {
  CAMERA_Z,
  easeInOut2,
  seg,
  slabPose,
  slabRaw,
  UNGLYPH,
} from "../components/three/hero/slab-choreo.ts";

const HALF = 1.55 / 2; // slab footprint half-extent (bevel included)
const HALF_D = 0.5 / 2; // depth half-extent
const INFLATE_XY = 0.025; // breathing (≤0.01 during explode) + margin
const INFLATE_Z = 0.04; // breathing z (≤0.027 during explode) + margin
const STEPS = 2000;

/** yz-plane SAT for two rectangles rotated about the x axis.
    Returns the largest separating-axis clearance (>0 ⇒ disjoint),
    or a negative number (max overlap-negation) if they intersect. */
function yzClearance(a, b) {
  const axes = [
    [Math.cos(a.rot), Math.sin(a.rot)],
    [-Math.sin(a.rot), Math.cos(a.rot)],
    [Math.cos(b.rot), Math.sin(b.rot)],
    [-Math.sin(b.rot), Math.cos(b.rot)],
  ];
  let best = -Infinity;
  for (const [uy, uz] of axes) {
    const dist = Math.abs((b.y - a.y) * uy + (b.z - a.z) * uz);
    const rA =
      a.hy * Math.abs(uy * Math.cos(a.rot) + uz * Math.sin(a.rot)) +
      a.hz * Math.abs(-uy * Math.sin(a.rot) + uz * Math.cos(a.rot));
    const rB =
      b.hy * Math.abs(uy * Math.cos(b.rot) + uz * Math.sin(b.rot)) +
      b.hz * Math.abs(-uy * Math.sin(b.rot) + uz * Math.cos(b.rot));
    best = Math.max(best, dist - (rA + rB));
  }
  return best;
}

const pairs = [];
for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) pairs.push([i, j]);

const minGap = new Map(pairs.map(([i, j]) => [`${i}-${j}`, Infinity]));
const violations = [];

for (let s = 1; s <= STEPS; s++) {
  const p = s / STEPS;
  const unglyph = easeInOut2(seg(p, UNGLYPH[0], UNGLYPH[1]));
  const boxes = SLABS.map((slab, i) => {
    const pose = slabPose(slab, slabRaw(p, i), unglyph);
    return {
      x: pose.x,
      y: pose.y,
      z: pose.z,
      hx: HALF * pose.sx + INFLATE_XY,
      hy: HALF * pose.sy + INFLATE_XY,
      hz: HALF_D + INFLATE_Z,
      rot: pose.rotX,
    };
  });
  for (const [i, j] of pairs) {
    const A = boxes[i];
    const B = boxes[j];
    const xGap = Math.abs(B.x - A.x) - (A.hx + B.hx);
    const yz = yzClearance(A, B);
    // disjoint iff separated on x OR on some yz axis
    const gap = Math.max(xGap, yz);
    const key = `${i}-${j}`;
    if (gap < minGap.get(key)) minGap.set(key, gap);
    if (gap < 0) violations.push({ p: +p.toFixed(4), pair: key, depth: +gap.toFixed(3) });
  }
}

console.log("pair (ids)                       min clearance (world units)");
for (const [i, j] of pairs) {
  const key = `${i}-${j}`;
  const label = `${SLABS[i].id} × ${SLABS[j].id}`.padEnd(32);
  const v = minGap.get(key);
  console.log(`${label} ${v === Infinity ? "n/a" : v.toFixed(3)}${v < 0 ? "  ◀ INTERSECTS" : ""}`);
}

// Final-frame fit: top bar must stay inside the inner frame with margin.
const topPose = slabPose(SLABS[0], 1, 1);
const topEdge = topPose.y + HALF * topPose.sy;
const halfView = Math.tan((30 / 2) * (Math.PI / 180)) * CAMERA_Z.exploded;
console.log(
  `\nframe fit: top bar edge ${topEdge.toFixed(3)}u vs half-view ${halfView.toFixed(3)}u ` +
    `(margin ${(((halfView - topEdge) / halfView) * 230).toFixed(1)}px at full width)`,
);

if (violations.length) {
  console.error(`\n✗ ${violations.length} intersecting samples, first 10:`);
  console.error(violations.slice(0, 10));
  process.exit(1);
}
console.log(`\n✓ no interpenetration across ${STEPS} scrub samples (inflated boxes)`);
