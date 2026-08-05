"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { damp } from "maath/easing";
import gsap from "gsap";
import { createSlabGeometry, SLABS } from "./slab-geometry";
import { scrollState } from "../shared/scroll-state";

/* Scene-graph contract (load-bearing — the animation systems never fight):
     sceneGroup   ← disassembly pure-function ONLY (offset/scale recenter)
      mouseGroup  ← mouse yaw/pitch damping ONLY (held while assemble owns it)
      slabGroup   ← GSAP assemble (progress≈0) + disassembly pure-function
         mesh     ← idle breathing sine ONLY
      pulseGroup  ← spine pulses, free-running clock life (gated by progress)

   The scroll disassembly is a PURE FUNCTION of scrollState.heroProgress,
   evaluated per frame — scrub-reversible by construction, no tween state.
   Beat map (fractions of the 250vh hero scrub; keep in sync with the
   choreography chunk's annotation timings):
     0.10–0.36  un-glyph: quadrants meet at z, face-on, material parity
     0.32–0.72  explode to rows (stagger 0.04/slab) + camera arc & dolly;
                each bar tilts through the rim light mid-flight (glint) and
                fires an envMap ping as it lands
     0.85–1.0   live architecture: request pulse walks the spine down
                (dashboard → agent → postgres → sandbox), result pulse walks
                back up — clock-driven, never scrubbed. */

const REST_ROTATION = { x: -0.14, y: 0.3 };
/* Assembled composition: raised so the mark's crown reads above the h1 —
   but small enough that no rotated corner ever crosses the inner frame edge
   (camera z 7.5 → half-view 2.01u; extent ≈ 1.9·scale + offset). */
const REST_OFFSET_Y = 0.25;
const REST_SCALE = 0.88;
const CAMERA_Z = { rest: 7.5, exploded: 9.6 };

/* Beat windows */
const UNGLYPH = [0.1, 0.36] as const;
const EXPLODE_START = 0.32;
const EXPLODE_DUR = 0.36;
const EXPLODE_STAGGER = 0.04;
const DOLLY = [0.32, 0.72] as const;
const LIVE = [0.85, 0.93] as const;

/* Camera arc during the explode — peaks mid-dolly, lands centered so the
   DOM labels (positioned for a centered camera) line up exactly. */
const ARC_X = 0.55;
const ARC_Y = -0.18;

/* Glint tilt: bars pitch through the top rim light mid-flight, zero at both
   endpoints (pure function of explode — scrub-reversible). */
const GLINT_TILT = -0.26;

/* Spine pulses. World x aligns under the DOM spine hairline (62.6% of the
   1240 box → 156.2px right of center → 1.747u at the z=0 plane); the pulse
   plane sits in front of the bar faces, so both axes are pre-divided by the
   projective ratio to land on the same screen position. */
const PULSE_Z = 0.55;
const PROJ = (CAMERA_Z.exploded - PULSE_Z) / (CAMERA_Z.exploded - 0.1);
const PULSE_X = 1.747 * PROJ;
const STATION_Y = SLABS.map((s) => s.rowY * PROJ);
const PULSE_PERIOD = 3.8; // seconds per full spine traversal
const PULSE_DWELL = 0.09; // journey fraction parked at each layer
const PULSE_TRAVEL = (1 - 4 * PULSE_DWELL) / 3;
const PING_DECAY = 2.0;
const DWELL_PING = 0.45;

const PULSE_STYLE = {
  dark: {
    req: "#bfefff",
    res: "#4ec9a5",
    blending: THREE.AdditiveBlending,
    opacity: 0.95,
    scale: 0.3,
    pingEnv: 1.5,
  },
  light: {
    req: "#0070f7",
    res: "#0f9d7a",
    blending: THREE.NormalBlending,
    opacity: 0.85,
    scale: 0.2,
    pingEnv: 0.7,
  },
} as const;

const MATERIALS = {
  dark: {
    proud: {
      color: "#0b0b0c",
      metalness: 0.75,
      roughness: 0.14,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
      envMapIntensity: 2.4,
    },
    recessed: {
      color: "#060607",
      metalness: 0.75,
      roughness: 0.28,
      clearcoat: 0.6,
      clearcoatRoughness: 0.22,
      envMapIntensity: 1.1,
    },
    parityEnv: 2.4,
  },
  light: {
    /* porcelain: bright dielectric slabs lit by ambient fill; env only
       contributes the chamfer speculars, so keep its weight low */
    proud: {
      color: "#eceef1",
      metalness: 0.05,
      roughness: 0.34,
      clearcoat: 1.0,
      clearcoatRoughness: 0.16,
      envMapIntensity: 0.55,
    },
    recessed: {
      color: "#d6d9df",
      metalness: 0.05,
      roughness: 0.48,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.35,
    },
    parityEnv: 0.55,
  },
} as const;

/** 0→1 progress within [a, b], clamped. */
function seg(p: number, a: number, b: number): number {
  return THREE.MathUtils.clamp((p - a) / (b - a), 0, 1);
}
function easeInOut2(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
function easeInOut3(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
const lerp = THREE.MathUtils.lerp;

/** Piecewise spine journey: u∈[0,1] → y + which station we're parked at. */
function journey(u: number): { y: number; station: number | null } {
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    if (u < acc + PULSE_DWELL) return { y: STATION_Y[i], station: i };
    acc += PULSE_DWELL;
    if (i < 3) {
      if (u < acc + PULSE_TRAVEL) {
        const t = easeInOut2((u - acc) / PULSE_TRAVEL);
        return { y: lerp(STATION_Y[i], STATION_Y[i + 1], t), station: null };
      }
      acc += PULSE_TRAVEL;
    }
  }
  return { y: STATION_Y[3], station: 3 };
}

export function StackMark({ theme }: { theme: "dark" | "light" }) {
  const sceneGroup = useRef<THREE.Group>(null!);
  const mouseGroup = useRef<THREE.Group>(null!);
  const slabRefs = useRef<(THREE.Group | null)[]>([]);
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const pulseGroup = useRef<THREE.Group>(null!);
  const reqRef = useRef<THREE.Sprite>(null!);
  const resRef = useRef<THREE.Sprite>(null!);
  const pointer = useRef({ x: 0, y: 0 });
  const assembleTl = useRef<gsap.core.Timeline | null>(null);
  /* Ping state per slab: landing flashes + pulse-dwell flashes, decayed
     per frame and added onto envMapIntensity. */
  const pings = useRef([0, 0, 0, 0]);
  const prevExplode = useRef([0, 0, 0, 0]);
  const prevStation = useRef<{ req: number | null; res: number | null }>({
    req: null,
    res: null,
  });

  const geometry = useMemo(() => createSlabGeometry(), []);
  const spec = MATERIALS[theme];
  const pulseStyle = PULSE_STYLE[theme];
  /* Per-slab material clones so a single layer can flash on its own. */
  const materials = useMemo(
    () =>
      SLABS.map(
        (slab) => new THREE.MeshPhysicalMaterial(slab.proud ? spec.proud : spec.recessed),
      ),
    [spec],
  );

  const blobTex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.3, "rgba(255,255,255,0.8)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }, []);

  useEffect(() => {
    return () => {
      materials.forEach((m) => m.dispose());
    };
  }, [materials]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => blobTex.dispose(), [blobTex]);

  /* Mouse parallax source — window-level because the canvas is
     pointer-events-none. Skipped entirely on coarse pointers. */
  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  /* Assemble-on-load: slabs fly in from off-frame corners and settle. */
  useEffect(() => {
    const ctx = gsap.context(() => {
      const from: [number, number, number, number][] = [
        [-2.3, 1.7, -5, -0.55],
        [2.1, 1.9, -6, 0.5],
        [-1.9, -2.0, -6, -0.4],
        [2.3, -1.7, -5, 0.55],
      ];
      const tl = gsap.timeline();
      assembleTl.current = tl;
      SLABS.forEach((slab, i) => {
        const group = slabRefs.current[i];
        if (!group) return;
        const [fx, fy, fz, fry] = from[i];
        group.position.set(fx, fy, fz);
        group.rotation.y = fry;
        tl.to(
          group.position,
          { x: slab.x, y: slab.y, z: slab.z, duration: 0.9, ease: "expo.out" },
          i * 0.08,
        );
        tl.to(group.rotation, { y: 0, duration: 0.9, ease: "expo.out" }, i * 0.08);
      });
      if (mouseGroup.current) {
        mouseGroup.current.rotation.set(-0.2, 0.38, 0);
        tl.to(
          mouseGroup.current.rotation,
          { x: REST_ROTATION.x, y: REST_ROTATION.y, duration: 1.1, ease: "power3.out" },
          0,
        );
      }
    });
    return () => ctx.revert();
  }, []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const p = scrollState.heroProgress;
    const calm = 1 - p;

    // Idle breathing on the MESH level (dies as disassembly begins)
    meshRefs.current.forEach((mesh, i) => {
      if (!mesh) return;
      mesh.position.z = 0.04 * Math.sin(t * 0.6 + i * 1.7) * calm;
      const drift = 0.015 * Math.sin(t * 0.45 + i) * calm;
      mesh.position.x = Math.sign(SLABS[i].x) * drift;
      mesh.position.y = Math.sign(SLABS[i].y) * drift;
    });

    // Damped mouse yaw/pitch — held while the assemble timeline owns it
    const unglyph = easeInOut2(seg(p, UNGLYPH[0], UNGLYPH[1]));
    if (!assembleTl.current?.isActive()) {
      const targetY = REST_ROTATION.y * (1 - unglyph) + pointer.current.x * 0.3 * calm;
      const targetX = REST_ROTATION.x * (1 - unglyph) + -pointer.current.y * 0.2 * calm;
      damp(mouseGroup.current.rotation, "y", targetY, 0.25, delta);
      damp(mouseGroup.current.rotation, "x", targetX, 0.25, delta);
    }

    // Ping decay runs unconditionally so flashes finish even if the user
    // stops scrolling mid-decay.
    for (let i = 0; i < 4; i++) {
      pings.current[i] = Math.max(0, pings.current[i] - delta * PING_DECAY);
    }

    /* ── Scroll disassembly: pure function of progress ── */
    if (p > 0.001) {
      if (assembleTl.current?.isActive()) assembleTl.current.progress(1);

      sceneGroup.current.position.y = lerp(REST_OFFSET_Y, 0, unglyph);
      const s = lerp(REST_SCALE, 1, unglyph);
      sceneGroup.current.scale.setScalar(s);

      // Camera: dolly out along a gentle arc that lands centered
      const dollyT = easeInOut2(seg(p, DOLLY[0], DOLLY[1]));
      const arc = Math.sin(Math.PI * dollyT);
      state.camera.position.z = lerp(CAMERA_Z.rest, CAMERA_Z.exploded, dollyT);
      state.camera.position.x = ARC_X * arc;
      state.camera.position.y = ARC_Y * arc;
      state.camera.lookAt(0, 0, 0);

      SLABS.forEach((slab, i) => {
        const group = slabRefs.current[i];
        if (!group) return;
        const a = EXPLODE_START + i * EXPLODE_STAGGER;
        const explode = easeInOut3(seg(p, a, a + EXPLODE_DUR));
        group.position.x = lerp(slab.x, 0, explode);
        group.position.y = lerp(slab.y, slab.rowY, explode);
        group.position.z = lerp(slab.z, 0.1, unglyph);
        group.scale.x = lerp(1, 2.4, explode);
        group.scale.y = lerp(1, 0.55, explode);
        // glint: pitch through the rim light mid-flight, flat at both ends
        group.rotation.x = GLINT_TILT * Math.sin(Math.PI * explode);
        // landing flash — forward crossing only
        if (prevExplode.current[i] < 0.985 && explode >= 0.985) {
          pings.current[i] = 1;
        }
        prevExplode.current[i] = explode;
      });

      // recessed quadrants tween to glossy parity — "the quadrants are peers"
      SLABS.forEach((slab, i) => {
        const m = materials[i];
        const base = slab.proud ? spec.proud : spec.recessed;
        const env = slab.proud
          ? spec.proud.envMapIntensity
          : lerp(spec.recessed.envMapIntensity, spec.parityEnv, unglyph);
        m.envMapIntensity = env + pings.current[i] * pulseStyle.pingEnv;
        if (!slab.proud) {
          m.roughness = lerp(base.roughness, spec.proud.roughness, unglyph);
          m.clearcoat = lerp(base.clearcoat, spec.proud.clearcoat, unglyph);
        }
      });

      /* ── Live architecture: spine pulses, clock-driven (never scrubbed) ── */
      const liveFade = easeInOut2(seg(p, LIVE[0], LIVE[1]));
      pulseGroup.current.visible = liveFade > 0.001;
      if (liveFade > 0.001) {
        // request walks down; result walks up, offset half a period
        const uReq = (t / PULSE_PERIOD) % 1;
        const uRes = (t / PULSE_PERIOD + 0.55) % 1;
        const jReq = journey(uReq);
        const jRes = journey(uRes);

        const endFade = (u: number) => Math.min(u / 0.06, (1 - u) / 0.06, 1);
        reqRef.current.position.set(PULSE_X, jReq.y, PULSE_Z);
        resRef.current.position.set(PULSE_X, -jRes.y, PULSE_Z);
        reqRef.current.material.opacity = pulseStyle.opacity * liveFade * endFade(uReq);
        resRef.current.material.opacity =
          pulseStyle.opacity * 0.8 * liveFade * endFade(uRes);

        // dwell pings: the layer lights up while a pulse is parked on it
        if (jReq.station !== null && prevStation.current.req !== jReq.station) {
          pings.current[jReq.station] = Math.max(pings.current[jReq.station], DWELL_PING);
        }
        if (jRes.station !== null && prevStation.current.res !== jRes.station) {
          const slabIdx = 3 - jRes.station;
          pings.current[slabIdx] = Math.max(pings.current[slabIdx], DWELL_PING * 0.7);
        }
        prevStation.current.req = jReq.station;
        prevStation.current.res = jRes.station;
      }
    } else {
      sceneGroup.current.position.y = REST_OFFSET_Y;
      sceneGroup.current.scale.setScalar(REST_SCALE);
      state.camera.position.set(0, 0, CAMERA_Z.rest);
      state.camera.lookAt(0, 0, 0);
      pulseGroup.current.visible = false;
      prevStation.current.req = null;
      prevStation.current.res = null;
      SLABS.forEach((slab, i) => {
        const m = materials[i];
        const base = slab.proud ? spec.proud : spec.recessed;
        m.envMapIntensity = base.envMapIntensity + pings.current[i] * pulseStyle.pingEnv;
        m.roughness = base.roughness;
        m.clearcoat = base.clearcoat;
      });
      // Instant jumps to the top (Home key, scroll restoration) skip the
      // scrub — restore the slab grid pose too.
      if (!assembleTl.current?.isActive()) {
        SLABS.forEach((slab, i) => {
          const group = slabRefs.current[i];
          if (!group) return;
          group.position.set(slab.x, slab.y, slab.z);
          group.scale.set(1, 1, 1);
          group.rotation.x = 0;
          prevExplode.current[i] = 0;
        });
      }
    }
  });

  return (
    <group ref={sceneGroup} position={[0, REST_OFFSET_Y, 0]} scale={REST_SCALE}>
      <group ref={mouseGroup} rotation={[REST_ROTATION.x, REST_ROTATION.y, 0]}>
        {SLABS.map((slab, i) => (
          <group
            key={slab.id}
            ref={(el) => {
              slabRefs.current[i] = el;
            }}
            position={[slab.x, slab.y, slab.z]}
          >
            <mesh
              ref={(el) => {
                meshRefs.current[i] = el;
              }}
              geometry={geometry}
              material={materials[i]}
            />
          </group>
        ))}
      </group>

      {/* Spine pulses — outside mouseGroup: by the time they fade in, the
          rig has rotated to face-on and the rows are world-axis aligned. */}
      <group ref={pulseGroup} visible={false}>
        <sprite
          ref={reqRef}
          position={[PULSE_X, STATION_Y[0], PULSE_Z]}
          scale={[pulseStyle.scale, pulseStyle.scale, 1]}
        >
          <spriteMaterial
            map={blobTex}
            color={pulseStyle.req}
            transparent
            opacity={0}
            depthWrite={false}
            blending={pulseStyle.blending}
          />
        </sprite>
        <sprite
          ref={resRef}
          position={[PULSE_X, STATION_Y[3], PULSE_Z]}
          scale={[pulseStyle.scale * 0.85, pulseStyle.scale * 0.85, 1]}
        >
          <spriteMaterial
            map={blobTex}
            color={pulseStyle.res}
            transparent
            opacity={0}
            depthWrite={false}
            blending={pulseStyle.blending}
          />
        </sprite>
      </group>
    </group>
  );
}
