"use client";

import { useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, Noise } from "@react-three/postprocessing";
import { StackMark } from "./stack-mark";
import type { HeroSceneProps } from "../contracts";

/* The lazy 3D chunk. Context flags antialias:false/depth:false/stencil:false
   are safe ONLY because every frame renders through EffectComposer, which
   owns a depth-carrying multisampled target — the canvas buffer just gets
   the final blit. Removing the composer requires restoring depth:true. */

type Quality = 0 | 1 | 2;
const QUALITY: Record<Quality, { dpr: number; msaa: number; bloom: boolean }> = {
  2: { dpr: 2, msaa: 4, bloom: true },
  1: { dpr: 1.5, msaa: 2, bloom: true },
  0: { dpr: 1, msaa: 0, bloom: false },
};

function FirstFrameNotifier({ onReady }: { onReady: () => void }) {
  const [fired, setFired] = useState(false);
  useFrame(() => {
    if (!fired) {
      setFired(true);
      requestAnimationFrame(() => onReady());
    }
  });
  return null;
}

function PerformanceLadder({ onDegrade }: { onDegrade: () => void }) {
  const [samples] = useState<number[]>(() => []);
  useFrame((_, delta) => {
    // A giant delta is a rAF pause (tab switch, frameloop 'never'), not a
    // slow device — reset the window instead of poisoning the average.
    if (delta > 0.25) {
      samples.length = 0;
      return;
    }
    samples.push(delta);
    if (samples.length >= 90) {
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      samples.length = 0;
      if (avg > 1 / 42) onDegrade(); // sustained < ~42fps → step down
    }
  });
  return null;
}

/* Theme-specific rig values. Light mode renders porcelain slabs on the
   white page — bloom nearly off (white would bloom everywhere), colored
   washes softened, rims darkened via contrast instead of glow. */
const RIG = {
  dark: {
    topRim: 7,
    underRim: 2.2,
    leftWash: 2.6,
    rightWash: 2,
    pointA: 2.5,
    pointB: 2,
    bloom: { intensity: 1.0, threshold: 0.32 },
    vignette: 0.55,
  },
  light: {
    topRim: 4,
    underRim: 1.6,
    leftWash: 1.1,
    rightWash: 0.9,
    pointA: 1.2,
    pointB: 1,
    bloom: { intensity: 0.25, threshold: 0.9 },
    vignette: 0.18,
  },
} as const;

export default function HeroCanvas({ theme, onReady, onFailed, inView }: HeroSceneProps) {
  const [quality, setQuality] = useState<Quality>(2);
  const [failed, setFailed] = useState(false);

  /* Context lost → unmount AND tell the stage, which restores the poster. */
  if (failed) return null;

  const q = QUALITY[quality];
  const rig = RIG[theme];

  return (
    <Canvas
      gl={{
        antialias: false,
        stencil: false,
        depth: false,
        powerPreference: "high-performance",
      }}
      dpr={[1, q.dpr]}
      frameloop={inView ? "always" : "never"}
      camera={{ fov: 30, position: [0, 0, 7.5] }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener(
          "webglcontextlost",
          (e) => {
            e.preventDefault();
            setFailed(true);
            onFailed();
          },
          { once: true },
        );
        gl.setClearColor(new THREE.Color("#000000"), 0);
      }}
      className="pointer-events-none"
      aria-hidden
    >
      <FirstFrameNotifier onReady={onReady} />
      {quality > 0 ? (
        <PerformanceLadder
          onDegrade={() => setQuality((prev) => (prev > 0 ? ((prev - 1) as Quality) : prev))}
        />
      ) : null}

      <StackMark theme={theme} />

      {/* Light theme: the PMREM env is mostly dark (4 formers on black),
          so porcelain needs real ambient fill or it renders as sludge. */}
      {theme === "light" ? (
        <>
          <ambientLight intensity={2.1} />
          <hemisphereLight args={["#ffffff", "#e2e5ea", 1.4]} />
        </>
      ) : null}

      {/* Rim-light rig: runtime PMREM environment, rendered once (frames=1) */}
      <Environment key={theme} resolution={256} frames={1}>
        <Lightformer
          form="rect"
          scale={[10, 0.8, 1]}
          position={[0, 4, -2]}
          rotation-x={Math.PI / 2}
          intensity={rig.topRim}
          color="#ffffff"
        />
        <Lightformer
          form="rect"
          scale={[10, 0.6, 1]}
          position={[0, -4, -2]}
          rotation-x={-Math.PI / 2}
          intensity={rig.underRim}
          color="#ffffff"
        />
        <Lightformer
          form="rect"
          scale={[3, 6, 1]}
          position={[-6, 0, 1]}
          rotation-y={Math.PI / 2}
          intensity={rig.leftWash}
          color="#007CF0"
        />
        <Lightformer
          form="rect"
          scale={[3, 6, 1]}
          position={[6, -1, 1]}
          rotation-y={-Math.PI / 2}
          intensity={rig.rightWash}
          color="#FF0080"
        />
      </Environment>

      {/* Chamfer accents that move with mouse parallax */}
      <pointLight position={[-3, 2.5, 4]} intensity={rig.pointA} color="#00DFD8" distance={12} />
      <pointLight position={[3, -2, 4]} intensity={rig.pointB} color="#FF4D4D" distance={12} />

      <EffectComposer multisampling={q.msaa}>
        {q.bloom ? (
          <Bloom
            mipmapBlur
            intensity={rig.bloom.intensity}
            luminanceThreshold={rig.bloom.threshold}
            luminanceSmoothing={0.25}
          />
        ) : (
          <></>
        )}
        <Vignette eskil={false} offset={0.28} darkness={rig.vignette} />
        <Noise premultiply opacity={theme === "dark" ? 0.035 : 0.018} />
      </EffectComposer>
    </Canvas>
  );
}
