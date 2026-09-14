"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { damp } from "maath/easing";
import gsap from "gsap";
import { createSlabGeometry, SLABS } from "./slab-geometry";
import {
  ARC_X,
  ARC_Y,
  CAMERA_Z,
  DOLLY,
  easeInOut2,
  lerp,
  seg,
  slabPose,
  slabRaw,
  UNGLYPH,
} from "./slab-choreo";
import { scrollState } from "../shared/scroll-state";

/* Scene-graph contract (load-bearing — the animation systems never fight):
     sceneGroup   ← disassembly pure-function ONLY (offset/scale recenter)
      mouseGroup  ← mouse yaw/pitch damping ONLY (held while assemble owns it)
      slabGroup   ← GSAP assemble (progress≈0) + disassembly pure-function
         mesh     ← idle breathing sine ONLY

   The scroll disassembly is a PURE FUNCTION of scrollState.heroProgress,
   evaluated per frame — scrub-reversible by construction, no tween state.
   ALL pose math + beat constants live in slab-choreo.ts (pure module) so
   scripts/qa-hero-geometry.mjs can replay the exact production functions
   and SAT-prove the slabs never interpenetrate. Each bar fires an envMap
   flash as it lands (no sprites — brightness only). */

const REST_ROTATION = { x: -0.14, y: 0.3 };
/* Assembled composition: raised so the mark's crown reads above the h1 —
   but small enough that no rotated corner ever crosses the inner frame edge
   (camera z 7.5 → half-view 2.01u; extent ≈ 1.9·scale + offset). */
const REST_OFFSET_Y = 0.25;
const REST_SCALE = 0.88;

const PING_ENV = { dark: 1.5, light: 0.7 } as const;
const PING_DECAY = 2.0;

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

export function StackMark({ theme }: { theme: "dark" | "light" }) {
  const sceneGroup = useRef<THREE.Group>(null!);
  const mouseGroup = useRef<THREE.Group>(null!);
  const slabRefs = useRef<(THREE.Group | null)[]>([]);
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const pointer = useRef({ x: 0, y: 0 });
  const assembleTl = useRef<gsap.core.Timeline | null>(null);
  /* Landing flashes, decayed per frame and added onto envMapIntensity. */
  const pings = useRef([0, 0, 0, 0]);
  const prevExplode = useRef([0, 0, 0, 0]);

  const geometry = useMemo(() => createSlabGeometry(), []);
  const spec = MATERIALS[theme];
  /* Per-slab material clones so a single layer can flash on its own. */
  const materials = useMemo(
    () =>
      SLABS.map(
        (slab) => new THREE.MeshPhysicalMaterial(slab.proud ? spec.proud : spec.recessed),
      ),
    [spec],
  );

  useEffect(() => {
    return () => {
      materials.forEach((m) => m.dispose());
    };
  }, [materials]);

  useEffect(() => () => geometry.dispose(), [geometry]);

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

      // Camera: dolly to the exploded frame along an arc that lands centered
      const dollyT = easeInOut2(seg(p, DOLLY[0], DOLLY[1]));
      const arc = Math.sin(Math.PI * dollyT);
      state.camera.position.z = lerp(CAMERA_Z.rest, CAMERA_Z.exploded, dollyT);
      state.camera.position.x = ARC_X * arc;
      state.camera.position.y = ARC_Y * arc;
      state.camera.lookAt(0, 0, 0);

      SLABS.forEach((slab, i) => {
        const group = slabRefs.current[i];
        if (!group) return;
        const raw = slabRaw(p, i);
        const pose = slabPose(slab, raw, unglyph);
        group.position.set(pose.x, pose.y, pose.z);
        group.scale.set(pose.sx, pose.sy, 1);
        group.rotation.x = pose.rotX;
        // landing flash — forward crossing only
        if (prevExplode.current[i] < 0.985 && raw >= 0.985) {
          pings.current[i] = 1;
        }
        prevExplode.current[i] = raw;
      });

      // recessed quadrants tween to glossy parity — "the quadrants are peers"
      SLABS.forEach((slab, i) => {
        const m = materials[i];
        const base = slab.proud ? spec.proud : spec.recessed;
        const env = slab.proud
          ? spec.proud.envMapIntensity
          : lerp(spec.recessed.envMapIntensity, spec.parityEnv, unglyph);
        m.envMapIntensity = env + pings.current[i] * PING_ENV[theme];
        if (!slab.proud) {
          m.roughness = lerp(base.roughness, spec.proud.roughness, unglyph);
          m.clearcoat = lerp(base.clearcoat, spec.proud.clearcoat, unglyph);
        }
      });
    } else {
      sceneGroup.current.position.y = REST_OFFSET_Y;
      sceneGroup.current.scale.setScalar(REST_SCALE);
      state.camera.position.set(0, 0, CAMERA_Z.rest);
      state.camera.lookAt(0, 0, 0);
      SLABS.forEach((slab, i) => {
        const m = materials[i];
        const base = slab.proud ? spec.proud : spec.recessed;
        m.envMapIntensity = base.envMapIntensity + pings.current[i] * PING_ENV[theme];
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
    </group>
  );
}
