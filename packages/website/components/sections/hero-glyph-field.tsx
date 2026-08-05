"use client";

import { useEffect, useRef } from "react";

/* Ambient glyph field framing the hero — a 2D-canvas port of eve.dev's WebGPU
   ASCII imprint (their shaders/shared/{ascii-glyphs,voronoi,ascii-imprint}.wgsl
   + paint/paint-update.wgsl, constants kept verbatim). Per glyph cell a hard-cell
   3D Voronoi (freq 4.8, z = t*0.35) picks one of six spinner glyphs | / \ – — ▲;
   Voronoi boundaries render a filled square, everything else keeps a base dot.
   Hovering paints a diffusing, decaying field that hard-switches cells onto a
   growing dot→circle→dash→circle→square ramp. Masks measured from the real
   content rects keep glyphs off the headline, CTAs, and slab core, with a
   fine-dot lattice grading the field into that protected zone. */

const CELL = 14; // CSS px per glyph cell
const GLYPH_SCALE = 1.27; // eve.dev ASCII-mode glyphScale
const VOR_FX = 0.062; // anisotropic sample step per cell → wide band clusters
const VOR_FY = 0.24;
const Z_SPEED = 0.35;
const NOISE_TICK_MS = 110; // hard-switch resample cadence (z drift is slow)
const REVEAL_WINDOW = 0.25;
const REVEAL_SECONDS = 1.6;
// paint defaults from eve.dev's ASCII mode (per-second rates, dt-scaled)
const BRUSH_RADIUS = 8;
const BRUSH_STRENGTH = 32;
const DECAY_RATE = 3.84; // 0.032/frame @120fps × 120
const DIFFUSION_RATE = 1.6;
const DIFFUSION_JITTER = 4;
const BRUSH_EDGE_NOISE = 1.5;
const PAINT_MAX = 2;
const HOVER_ENTRY_START = 0.1;
const HOVER_ENTRY_FULL = 0.5;
const HOVER_OVERLAY_SCALE = 0.5;
const PAINT_FADE_BYPASS = 0.85;
const PAINT_EMISSIVE_BOOST = 0.5; // shader brightens painted color; we fold it into alpha
/* eve.dev's field covers only its logo geometry, so most of the screen is empty
   air. We recreate that with a wide empty band in the Voronoi value: whole
   winner-cells drop out (islands), a dot fringe rings the live clusters. */
const GATE_EMPTY = 0.3; // v below ⇒ nothing
const GATE_DOT = 0.45; // v below ⇒ fringe dot only

const TAU = Math.PI * 2;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* eve.dev's exact hash chain (WGSL hash_u32/hash3), i32→u32 semantics via imul. */
const hashU32 = (v: number) => {
  let x = v >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
};
const hash3 = (x: number, y: number, z: number) => {
  const mixed =
    (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f)) >>>
    0;
  return (hashU32(mixed) & 0x00ffffff) / 16777215;
};

/* Smooth static 2D value noise — used to wobble every mask contour. A
   smoothstep along a straight rect edge still READS as a straight line; the
   fix is perturbing the boundary geometry itself, not softening its alpha. */
const vnoise = (x: number, y: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash3(xi, yi, 77);
  const b = hash3(xi + 1, yi, 77);
  const c = hash3(xi, yi + 1, 77);
  const d = hash3(xi + 1, yi + 1, 77);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
};

/* Hard-cell 3D Voronoi: winning cell's hash picks the glyph, F2−F1 gap < 0.04
   marks boundary cells (edge squares). Writes [value, edge] into out. */
const voronoi3 = (px: number, py: number, pz: number, out: Float32Array) => {
  const bx = Math.floor(px);
  const by = Math.floor(py);
  const bz = Math.floor(pz);
  const lx = px - bx;
  const ly = py - by;
  const lz = pz - bz;
  let d1 = 1000;
  let d2 = 1000;
  let wx = bx;
  let wy = by;
  let wz = bz;
  for (let z = -1; z <= 1; z++) {
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 1; x++) {
        const cx = bx + x;
        const cy = by + y;
        const cz = bz + z;
        const fx = x + hash3(cx + 17, cy + 59, cz + 113) - lx;
        const fy = y + hash3(cx + 101, cy + 191, cz + 53) - ly;
        const fz = z + hash3(cx + 47, cy + 223, cz + 149) - lz;
        const d = fx * fx + fy * fy + fz * fz;
        if (d < d1) {
          d2 = d1;
          d1 = d;
          wx = cx;
          wy = cy;
          wz = cz;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
  }
  out[0] = hash3(wx + 211, wy + 37, wz + 173);
  const gap = Math.sqrt(d2) - Math.sqrt(d1);
  out[1] = 1 - smoothstep(0.04, 0.06, gap);
  // feather: 0 at the cluster boundary → 1 deep inside, so island edges
  // taper off instead of ending in a hard line of full-alpha glyphs
  out[2] = smoothstep(0.03, 0.24, gap);
};

/* Sprite atlas: imprint glyphs 0..7 (dot | / \ – — ▲ ▪) then the hover ramp
   8..12 (dot, circle .145, dash, circle .235, square .255). p-space matches the
   shader: cell → [-1,1], shapes scaled by GLYPH_SCALE. */
const SPRITES = 13;
const buildAtlas = (cellPx: number, ink: string) => {
  const atlas = document.createElement("canvas");
  atlas.width = cellPx * SPRITES;
  atlas.height = cellPx;
  const ctx = atlas.getContext("2d")!;
  ctx.fillStyle = ink;
  const half = cellPx / 2;
  const u = (v: number) => v * GLYPH_SCALE * half; // p-space unit → px

  const at = (i: number, draw: () => void) => {
    ctx.save();
    ctx.translate(i * cellPx + half, half);
    draw();
    ctx.restore();
  };
  const dot = (r: number) => {
    ctx.beginPath();
    ctx.arc(0, 0, u(r), 0, TAU);
    ctx.fill();
  };
  const box = (hw: number, hh: number, angle = 0) => {
    ctx.rotate(angle);
    ctx.fillRect(-u(hw), -u(hh), u(hw) * 2, u(hh) * 2);
  };

  at(0, () => dot(0.075));
  at(1, () => box(0.28, 0.05, Math.PI / 2)); // |
  at(2, () => box(0.28, 0.05, -Math.PI / 4)); // /
  at(3, () => box(0.28, 0.05, Math.PI / 4)); // \
  at(4, () => box(0.2, 0.045)); // –
  at(5, () => box(0.31, 0.055)); // —
  at(6, () => {
    // ▲ equilateral, shader scale 0.66
    const r = u(0.66 * 0.62);
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * TAU) / 3;
      ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  });
  at(7, () => box(0.22, 0.22)); // ▪ voronoi edge
  at(8, () => dot(0.075));
  at(9, () => dot(0.145));
  at(10, () => box(0.27, 0.055));
  at(11, () => dot(0.235));
  at(12, () => box(0.255, 0.255));
  return atlas;
};

export function HeroGlyphField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const host = canvas.parentElement!;
    const root = document.documentElement;
    const reducedMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarseMq = window.matchMedia("(pointer: coarse)");

    let raf = 0;
    let running = false;
    let inView = true;
    let disposed = false;
    let atlas: HTMLCanvasElement | null = null;
    let dpr = 1;
    let cellPx = CELL;
    let cellW = CELL; // true on-screen cell size (≠ CELL at fractional dpr)
    let cellH = CELL;
    let cols = 0;
    let rows = 0;
    let count = 0;
    // per-cell buffers
    let weight = new Float32Array(0); // glyph mask × vertical fade, 0 ⇒ skip
    let lattice = new Float32Array(0); // fine-dot blend band hugging the content
    let hoverMask = new Float32Array(0); // paint falloff toward content (no hard cut)
    let proxG = new Float32Array(0); // ambient proximity band (drives edge dissolve)
    let drop = new Float32Array(0); // per-cell dissolve gate — edges thin out cell by cell
    let revealStart = new Float32Array(0);
    let station = new Int8Array(0); // -1 empty band … 5 ▲
    let edge = new Float32Array(0);
    let soft = new Float32Array(0); // cluster-boundary feather (0 edge → 1 core)
    let paintA = new Float32Array(0);
    let paintB = new Float32Array(0);
    let noiseB = new Float32Array(0); // brush-edge hash
    let noiseA = new Float32Array(0); // decay multiplier hash
    let diffOff = new Int32Array(0); // 4 pre-jittered tap offsets per cell (dx,dy)×4
    let maxPaint = 0;
    let time = 0;
    let lastNoiseAt = -1e9;
    let lastNow = 0;
    let revealT = 0;
    const vor = new Float32Array(3);

    // far-plane depth cue: the whole field drifts a few px opposite the pointer
    let parX = 0;
    let parY = 0;
    let tParX = 0;
    let tParY = 0;

    // pointer in canvas cell space; brush follows eve.dev's capsule stamp
    let brushActive = false;
    let brushX = -1e6;
    let brushY = -1e6;
    let prevBrushX = -1e6;
    let prevBrushY = -1e6;

    const isDark = () => root.classList.contains("dark");
    const inkColor = () => {
      const tok = getComputedStyle(root).getPropertyValue("--ds-gray-1000").trim();
      return tok || (isDark() ? "#ededed" : "#0a0a0a");
    };

    const rebuildAtlas = () => {
      atlas = buildAtlas(cellPx, inkColor());
    };

    const layout = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cellPx = Math.round(CELL * dpr);
      canvas.width = Math.ceil((w * dpr) / cellPx) * cellPx;
      canvas.height = Math.ceil((h * dpr) / cellPx) * cellPx;
      cols = canvas.width / cellPx;
      rows = canvas.height / cellPx;
      cellW = w / cols; // the canvas is CSS-stretched to the host, so the true
      cellH = h / rows; // on-screen cell drifts from CELL at fractional dpr
      count = cols * rows;
      weight = new Float32Array(count);
      lattice = new Float32Array(count);
      hoverMask = new Float32Array(count);
      proxG = new Float32Array(count);
      drop = new Float32Array(count);
      revealStart = new Float32Array(count);
      station = new Int8Array(count).fill(-1);
      edge = new Float32Array(count);
      soft = new Float32Array(count);
      paintA = new Float32Array(count);
      paintB = new Float32Array(count);
      noiseB = new Float32Array(count);
      noiseA = new Float32Array(count);
      diffOff = new Int32Array(count * 8);
      maxPaint = 0;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          revealStart[i] = hash3(c, r, 9) * (1 - REVEAL_WINDOW);
          noiseB[i] = hash3(c, r, 3);
          noiseA[i] = hash3(c, r, 4);
          // pre-jittered diffusion taps (static per cell, exact port)
          const angle = hash3(c, r, 1) * TAU;
          const scale = 1 + DIFFUSION_JITTER * hash3(c, r, 2);
          const ca = Math.cos(angle);
          const sa = Math.sin(angle);
          const axes = [1, 0, -1, 0, 0, 1, 0, -1];
          for (let t = 0; t < 4; t++) {
            const ax = axes[t * 2];
            const ay = axes[t * 2 + 1];
            let dx = Math.round((ca * ax - sa * ay) * scale);
            let dy = Math.round((sa * ax + ca * ay) * scale);
            if (dx === 0 && dy === 0) {
              dx = ax + ay >= 0 ? 1 : -1;
              dy = 0;
            }
            diffOff[i * 8 + t * 2] = dx;
            diffOff[i * 8 + t * 2 + 1] = dy;
          }
        }
      }
      lastNoiseAt = -1e9; // force resample
      computeWeights();
      rebuildAtlas();
    };

    /* Masks measured from the real layout: glyphs hug the copy column and the
       visible slab core of the 3D stage instead of an abstract ellipse, and a
       faint fine-dot lattice grades across the remaining gap so the protected
       zone reads as texture, not a void. The header's backdrop-blur keeps the
       nav readable, so the field runs to the very top like eve.dev's. */
    const distRect = (
      x: number,
      y: number,
      x0: number,
      y0: number,
      x1: number,
      y1: number,
    ) => {
      const dx = Math.max(x0 - x, 0, x - x1);
      const dy = Math.max(y0 - y, 0, y - y1);
      return Math.hypot(dx, dy);
    };

    const computeWeights = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h || !cols) return;
      const hostRect = host.getBoundingClientRect();
      const section = host.closest("#hero") ?? document;
      const toLocal = (el: Element | null, fw: number, fh: number) => {
        if (!el) {
          return { x0: (w - fw) / 2, y0: (h - fh) / 2, x1: (w + fw) / 2, y1: (h + fh) / 2 };
        }
        const r = el.getBoundingClientRect();
        return {
          x0: r.left - hostRect.left,
          y0: r.top - hostRect.top,
          x1: r.right - hostRect.left,
          y1: r.bottom - hostRect.top,
        };
      };
      // [data-hero-copy] is the full-width site container — the real content
      // column is the union of its children (badge / h1 / sub / CTA row)
      const unionChildren = (el: Element | null, fw: number, fh: number) => {
        if (!el || el.children.length === 0) return toLocal(el, fw, fh);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const ch of el.children) {
          const r = ch.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          x0 = Math.min(x0, r.left);
          y0 = Math.min(y0, r.top);
          x1 = Math.max(x1, r.right);
          y1 = Math.max(y1, r.bottom);
        }
        if (x0 === Infinity) return toLocal(el, fw, fh);
        return {
          x0: x0 - hostRect.left,
          y0: y0 - hostRect.top,
          x1: x1 - hostRect.left,
          y1: y1 - hostRect.top,
        };
      };
      const copy = unionChildren(section.querySelector("[data-hero-copy]"), 640, 440);
      const stage = toLocal(
        section.querySelector("[data-hero-stage]"),
        Math.min(1112, w * 0.96),
        460,
      );
      // the ▚ slabs occupy only the central ~44% of the wide stage box
      const stageW = stage.x1 - stage.x0;
      const slabG = { x0: stage.x0 + stageW * 0.21, x1: stage.x1 - stageW * 0.21, y0: stage.y0, y1: stage.y1 };
      const slabD = { x0: stage.x0 + stageW * 0.27, x1: stage.x1 - stageW * 0.27, y0: stage.y0 + 8, y1: stage.y1 - 8 };
      const dark = isDark();
      const floorA = dark ? 0.28 : 0.4;
      const gBase = dark ? 0.85 : 0.9;
      const dBase = dark ? 0.34 : 0.2;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const x = (c + 0.5) * cellW;
          const y = (r + 0.5) * cellH;
          // deliberately reflected from eve's vertical curve: they dim everything
          // below their top band; our field frames the whole viewport, so it
          // stays bold through the upper half and only dims toward the bottom
          const vfade = 1 - (1 - floorA) * (y / h) ** 2;
          // Every boundary contour is wobbled by static low-frequency noise —
          // a smooth gradient along a straight line still reads as a straight
          // line, so the line itself must meander.
          // Wobble amplitudes: every fade START sits beyond guard + amplitude,
          // so even the worst-case meander can never reach the content — the
          // organic contour has a hard protection floor underneath it.
          const wob = (vnoise(x / 132, y / 132) - 0.5) * 64; // ±32 on content contours
          const ewob = (vnoise(x / 88 + 51.7, y / 88 + 13.3) - 0.5) * 40; // ±20 on edges
          const pads =
            smoothstep(30, 108, Math.min(x, w - x) + ewob) * // sides (0 within ~10px)
            smoothstep(38, 96, y + ewob) * // top — fades out under the blurred header
            smoothstep(28, 88, h - y + ewob); // bottom — above the grounding gradient
          const dCopy = distRect(x, y, copy.x0, copy.y0, copy.x1, copy.y1) + wob;
          const dSlabD = distRect(x, y, slabD.x0, slabD.y0, slabD.x1, slabD.y1) + wob;
          const dSlabG = distRect(x, y, slabG.x0, slabG.y0, slabG.x1, slabG.y1) + wob;
          const gProx = Math.min(smoothstep(62, 188, dCopy), smoothstep(50, 148, dSlabG));
          const dProx = Math.min(smoothstep(52, 98, dCopy), smoothstep(40, 96, dSlabD));
          const prox = gProx * pads;
          proxG[i] = prox;
          drop[i] = hash3(c, r, 13);
          weight[i] = gBase * vfade * prox;
          lattice[i] =
            dBase * vfade * pads * dProx * (1 - gProx) * (0.65 + 0.7 * hash3(c, r, 7));
          // hover paint gets its own WIDE falloff toward the content so the
          // painted trail dissolves instead of hitting the mask like a wall
          hoverMask[i] =
            pads * Math.min(smoothstep(48, 128, dCopy), smoothstep(42, 118, dSlabD));
        }
      }
    };

    const sampleNoise = () => {
      const z = time * Z_SPEED;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (weight[i] <= 0.02) continue;
          voronoi3((c + 0.5) * VOR_FX, (r + 0.5) * VOR_FY, z, vor);
          const v = vor[0];
          station[i] =
            v < GATE_EMPTY
              ? -2
              : v < GATE_DOT
                ? -1
                : Math.min(5, Math.floor(((v - GATE_DOT) / (1 - GATE_DOT)) * 6));
          edge[i] = vor[1];
          soft[i] = 0.3 + 0.7 * vor[2];
        }
      }
    };

    const stepPaint = (dt: number) => {
      if (maxPaint <= 0 && !brushActive) return;
      const dw = Math.min(DIFFUSION_RATE * dt, 0.24);
      const bAct = brushActive && brushX > -1e5;
      const abx = brushX;
      const aby = brushY;
      const pbx = prevBrushX > -1e5 ? prevBrushX : abx;
      const pby = prevBrushY > -1e5 ? prevBrushY : aby;
      const dxSeg = abx - pbx;
      const dySeg = aby - pby;
      const segLen2 = Math.max(dxSeg * dxSeg + dySeg * dySeg, 1e-6);
      let mp = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const cur = paintA[i];
          let acc = 0;
          for (let t = 0; t < 4; t++) {
            const nc = Math.min(cols - 1, Math.max(0, c + diffOff[i * 8 + t * 2]));
            const nr = Math.min(rows - 1, Math.max(0, r + diffOff[i * 8 + t * 2 + 1]));
            acc += paintA[nr * cols + nc];
          }
          let v = (1 - 4 * dw) * cur + dw * acc;
          if (bAct) {
            const px = c + 0.5;
            const py = r + 0.5;
            const tSeg = Math.min(1, Math.max(0, ((px - pbx) * dxSeg + (py - pby) * dySeg) / segLen2));
            const ddx = px - (pbx + dxSeg * tSeg);
            const ddy = py - (pby + dySeg * tSeg);
            const noisy = Math.max(
              0,
              Math.sqrt(ddx * ddx + ddy * ddy) + (noiseB[i] - 0.5) * BRUSH_EDGE_NOISE,
            );
            v += BRUSH_STRENGTH * dt * (1 - smoothstep(0, BRUSH_RADIUS, noisy));
          }
          v -= DECAY_RATE * (1 + noiseA[i]) * 0.2 * dt;
          v = v < 0.001 ? 0 : Math.min(v, PAINT_MAX);
          paintB[i] = v;
          if (v > mp) mp = v;
        }
      }
      const tmp = paintA;
      paintA = paintB;
      paintB = tmp;
      maxPaint = mp;
      prevBrushX = brushX;
      prevBrushY = brushY;
    };

    const blit = (sprite: number, alpha: number, c: number, r: number) => {
      if (alpha <= 0.015 || !atlas) return;
      ctx.globalAlpha = Math.min(alpha, 1);
      ctx.drawImage(atlas, sprite * cellPx, 0, cellPx, cellPx, c * cellPx, r * cellPx, cellPx, cellPx);
    };

    const draw = () => {
      if (!atlas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const reveal = smoothstep(0, 1, revealT / REVEAL_SECONDS);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const w0 = weight[i];
          const lat = lattice[i];
          if (w0 <= 0.02 && lat <= 0.015 && hoverMask[i] <= 0.01) continue;
          const p = Math.min(paintA[i], 1);
          if (p > HOVER_ENTRY_START) {
            const hm = hoverMask[i];
            // dissolve band: near a boundary, cells drop out stochastically so
            // the painted region thins glyph-by-glyph along a wobbled contour
            if (hm <= 0.012 || (hm < 0.55 && drop[i] > hm / 0.55)) continue;
            // hard per-cell switch onto the hover ramp; paint bypasses the fade.
            // Alpha mirrors the shader: coverage × entry × overlay 0.5, with the
            // emissive paint boost folded into alpha (we have no bloom pass).
            const t = (p - HOVER_ENTRY_START) / (1 - HOVER_ENTRY_START);
            const entry = smoothstep(HOVER_ENTRY_START, HOVER_ENTRY_FULL, p);
            const scaled = p * HOVER_OVERLAY_SCALE;
            const opacity = w0 + (1 - w0) * PAINT_FADE_BYPASS * scaled;
            blit(
              8 + Math.min(4, Math.floor(t * 5)),
              opacity * entry * HOVER_OVERLAY_SCALE * (1 + PAINT_EMISSIVE_BOOST * scaled) * hm,
              c,
              r,
            );
            continue;
          }
          const rv = smoothstep(revealStart[i], revealStart[i] + REVEAL_WINDOW, reveal);
          if (rv <= 0.01) continue;
          const s = station[i];
          const dissolved = proxG[i] < 0.55 && drop[i] > proxG[i] / 0.55;
          if (w0 > 0.02 && s > -2 && !dissolved) {
            blit(s >= 0 ? 1 + s : 0, w0 * rv * soft[i], c, r);
            // boundary square union'd on top with its continuous mask — approximates
            // the shader's max(interiorGlyph, square × edgeMask), no hard pop
            if (edge[i] > 0.05) blit(7, w0 * rv * edge[i], c, r);
          } else {
            // blend band, empty air, and dissolved boundary cells: the fine-dot
            // lattice grades the field into the protected content zone
            blit(0, lat * rv, c, r);
          }
        }
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = 0;
      if (disposed) return;
      const dt = Math.min(Math.max((now - lastNow) / 1000, 0), 0.1);
      lastNow = now;
      time += dt;
      revealT += dt;
      // fade the whole field out as the scroll disassembly begins
      const fade = 1 - smoothstep(0.06, 0.55, window.scrollY / window.innerHeight);
      canvas.style.opacity = String(fade);
      parX += (tParX - parX) * Math.min(1, dt * 3.5);
      parY += (tParY - parY) * Math.min(1, dt * 3.5);
      canvas.style.transform = `translate3d(${(-parX * 9).toFixed(2)}px, ${(-parY * 6).toFixed(2)}px, 0)`;
      if (fade > 0) {
        if (now - lastNoiseAt >= NOISE_TICK_MS) {
          lastNoiseAt = now;
          sampleNoise();
        }
        stepPaint(dt);
        draw();
      }
      if (running && inView) raf = requestAnimationFrame(frame);
      else running = false;
    };

    const start = () => {
      if (running || disposed || reducedMq.matches) return;
      running = true;
      lastNow = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const staticFrame = () => {
      // reduced motion: one settled, fully revealed frame — no loop, no paint.
      // Reset the scroll-fade opacity and drop residual hover paint so nothing
      // stale gets baked into the frozen frame.
      revealT = REVEAL_SECONDS;
      canvas.style.opacity = "1";
      canvas.style.transform = "";
      paintA.fill(0);
      paintB.fill(0);
      maxPaint = 0;
      sampleNoise();
      draw();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (coarseMq.matches) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / cellW;
      const y = (e.clientY - rect.top) / cellH;
      const inside = x >= 0 && y >= 0 && x <= cols && y <= rows;
      brushActive = inside;
      if (inside) {
        brushX = x;
        brushY = y;
      }
      tParX = e.clientX / window.innerWidth - 0.5;
      tParY = e.clientY / window.innerHeight - 0.5;
    };
    const onPointerLeave = () => {
      brushActive = false;
      brushX = brushY = prevBrushX = prevBrushY = -1e6;
      tParX = tParY = 0;
    };

    layout();
    if (reducedMq.matches) staticFrame();

    // the entrance choreography nudges the copy/stage into place — re-read the
    // content rects once it has settled (weights only; paint state survives)
    const remeasure = window.setTimeout(() => {
      computeWeights();
      if (reducedMq.matches) staticFrame();
    }, 2600);

    const ro = new ResizeObserver(() => {
      layout();
      if (reducedMq.matches) staticFrame();
    });
    ro.observe(host);

    const io = new IntersectionObserver(
      (entries) => {
        // read the NEWEST record — a leave+re-enter can arrive in one batch
        inView = entries[entries.length - 1].isIntersecting;
        if (inView) start();
      },
      { threshold: 0 },
    );
    io.observe(host);

    // html[class] also churns with Lenis scroll-state classes — only a real
    // theme flip may trigger the (expensive) grid + atlas rebuild
    let lastDark = isDark();
    const mo = new MutationObserver(() => {
      const d = isDark();
      if (d === lastDark) return;
      lastDark = d;
      layout(); // ends in rebuildAtlas() with the new ink
      if (reducedMq.matches) staticFrame();
    });
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });

    // re-run layout when devicePixelRatio changes without a resize (monitor drag)
    let dprMql: MediaQueryList | null = null;
    const onDprChange = () => {
      layout();
      if (reducedMq.matches) staticFrame();
      armDprListener();
    };
    const armDprListener = () => {
      dprMql?.removeEventListener("change", onDprChange);
      dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMql.addEventListener("change", onDprChange);
    };
    armDprListener();

    const onReduced = () => {
      if (reducedMq.matches) {
        stop();
        staticFrame();
      } else start();
    };
    reducedMq.addEventListener("change", onReduced);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("blur", onPointerLeave);
    root.addEventListener("pointerleave", onPointerLeave);

    start();

    return () => {
      disposed = true;
      stop();
      window.clearTimeout(remeasure);
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      dprMql?.removeEventListener("change", onDprChange);
      reducedMq.removeEventListener("change", onReduced);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onPointerLeave);
      root.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return (
    <div data-glyph-field aria-hidden className="pointer-events-none absolute inset-0 z-0">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
