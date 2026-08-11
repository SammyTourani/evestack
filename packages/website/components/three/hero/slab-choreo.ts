import type { SlabSpec } from "./slab-data";

/* The scroll-disassembly pose math — a PURE module (no three, no React) so
   the geometry QA harness (scripts/qa-hero-geometry.mjs) can import and
   replay the EXACT production functions in Node. If you touch any number
   here, re-run the harness: it SAT-tests every slab pair across the whole
   scrub and fails on any interpenetration.

   Beat map (fractions of the hero scrub, whatever height it is set to):
     0.10–0.38  un-glyph: quadrants meet at z, face-on, material parity
     0.34–0.895 explode, stagger 0.045/slab. Two-phase per slab: TRAVEL
                first (y eases to its row while the card stays narrow),
                then WIDEN into the full bar in the back 75% of the window.
                The far-traveling proud slabs (dashboard, sandbox) LIFT
                toward the camera while moving — a dealt-card motion on
                their own depth lane, which is what makes interpenetration
                geometrically impossible.
     0.34–0.80  camera: dolly to the exploded frame along an arc. */

export const UNGLYPH: readonly [number, number] = [0.1, 0.38];
export const EXPLODE_START = 0.34;
export const EXPLODE_DUR = 0.42;
export const EXPLODE_STAGGER = 0.045;
/* Deal order: PROUD slabs first (dashboard, sandbox — indices 0/3), then
   the recessed middles. A proud slab must be airborne on its lift lane
   BEFORE its same-height recessed partner starts widening into the shared
   slot — the harness caught postgres's widening bar sweeping into a
   still-parked sandbox when the stagger ran in row order. Values are the
   per-slab stagger multiple, indexed by SLABS order. */
export const EXPLODE_DELAY: readonly number[] = [0, 2, 3, 1];
export const DOLLY: readonly [number, number] = [0.34, 0.8];

/* Exploded z is CLOSER than a naive fit: rows are compressed to ±1.65 so
   the finished diagram fills the inner frame. */
export const CAMERA_Z = { rest: 7.5, exploded: 8.2 } as const;

/* Camera arc during the explode — peaks mid-dolly, lands centered. */
export const ARC_X = 0.55;
export const ARC_Y = -0.18;

/* Lift-and-deal: proud slabs rise toward the camera while traveling.
   sin^0.6 attacks fast (clearance exists before x/y paths cross) and
   returns to 0 at landing. Tilt rides the same window, lifted slabs only —
   they're alone on their depth lane, so the pitch can never clip a
   neighbor. */
export const LIFT = 1.0;
export const TILT = -0.18;
/* Role-specific phase windows within each slab's explode fraction.
   PROUD (dashboard/sandbox — the far travelers): travel first, widen in
   the back 60% — they fly as narrow cards on the lift lane, then stretch
   into their shelf. RECESSED (agent/postgres — the short movers): widen
   FIRST (front 60%), travel in the back 70% — they compress into bars in
   place, then glide. Compressing before converging is what keeps the two
   middle rows apart mid-flight (the SAT harness caught the tall-while-
   converging overlap). */
export const PROUD_WIDEN: readonly [number, number] = [0.4, 1];
export const RECESSED_WIDEN: readonly [number, number] = [0, 0.6];
export const RECESSED_TRAVEL: readonly [number, number] = [0.3, 1];
export const BAR_SCALE_X = 2.4;
export const BAR_SCALE_Y = 0.55;

/* Shelf tilt: glare physics. The key light is a strip above/behind; a bar
   landing perfectly FLAT only catches it on its top edge if the camera
   looks down at that row — upper rows read as two corner pinpoints with a
   dead middle (measured: dashboard rim mid-luminance 1 vs corner 233,
   scripts/qa-hero-glare.mjs). Real product shots tip each shelf toward the
   key light, more for higher shelves — this is that, graded linearly from
   the top row (full) to the bottom row (0, already lit). Ramps in over the
   landing half of the explode window. POSITIVE rotX = top toward camera
   (three is right-handed about +x): it both unforeshortens the chamfer and
   swings its normal onto the view/strip bisector — the negative sign was
   probe-tested first and dimmed every row. */
export const SHELF_TILT_MAX = 0.14;
export const shelfTilt = (slab: SlabSpec) => SHELF_TILT_MAX * ((slab.rowY + 1.65) / 3.3);
export const SHELF_RAMP: readonly [number, number] = [0.55, 1];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 0→1 progress within [a, b], clamped. */
export function seg(p: number, a: number, b: number): number {
  return clamp01((p - a) / (b - a));
}
export function easeInOut2(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
export function easeInOut3(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface SlabPose {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  rotX: number;
}

/** Explode-fraction of slab i at overall progress p. */
export function slabRaw(p: number, i: number): number {
  const a = EXPLODE_START + EXPLODE_DELAY[i] * EXPLODE_STAGGER;
  return seg(p, a, a + EXPLODE_DUR);
}

/** The whole per-slab pose — pure function of the slab's raw explode
    fraction and the global unglyph fraction. */
export function slabPose(slab: SlabSpec, raw: number, unglyph: number): SlabPose {
  const travelWin = slab.proud ? ([0, 1] as const) : RECESSED_TRAVEL;
  const widenWin = slab.proud ? PROUD_WIDEN : RECESSED_WIDEN;
  const travel = easeInOut3(seg(raw, travelWin[0], travelWin[1]));
  const widen = easeInOut2(seg(raw, widenWin[0], widenWin[1]));
  const wave = Math.sin(Math.PI * raw);
  // asymmetric lift envelope: fast attack (airborne before paths cross),
  // slow release (stays on the depth lane until y fully clears the
  // neighbor's landed bar), still exactly 0 at both endpoints
  const lift = slab.proud ? LIFT * wave ** (raw < 0.5 ? 0.6 : 0.35) : 0;
  const settle = easeInOut2(seg(raw, SHELF_RAMP[0], SHELF_RAMP[1]));
  return {
    x: slab.x * (1 - widen),
    y: lerp(slab.y, slab.rowY, travel),
    z: lerp(slab.z, 0.1, unglyph) + lift,
    sx: lerp(1, BAR_SCALE_X, widen),
    sy: lerp(1, BAR_SCALE_Y, widen),
    rotX: (slab.proud ? TILT * wave : 0) + shelfTilt(slab) * settle,
  };
}
