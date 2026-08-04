"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, Noise } from "@react-three/postprocessing";
import gsap from "gsap";
import { StackMark } from "./stack-mark";
import { AsciiDitherEffect } from "./ascii-dither-effect";
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
  const fired = useRef(false);
  useFrame(() => {
    if (!fired.current) {
      fired.current = true;
      // let the frame actually present before crossfading the poster
      requestAnimationFrame(() => onReady());
    }
  });
  return null;
}

function PerformanceLadder({ onDegrade }: { onDegrade: () => void }) {
  const samples = useRef<number[]>([]);
  useFrame((_, delta) => {
    // A giant delta is a rAF pause (tab switch, frameloop 'never'), not a
    // slow device — reset the window instead of poisoning the average.
    if (delta > 0.25) {
      samples.current = [];
      return;
    }
    const arr = samples.current;
    arr.push(delta);
    if (arr.length >= 90) {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      samples.current = [];
      if (avg > 1 / 42) onDegrade(); // sustained < ~42fps → step down
    }
  });
  return null;
}

function Effects({ mode, quality }: { mode: HeroSceneProps["mode"]; quality: Quality }) {
  const gl = useThree((s) => s.gl);
  const ascii = useMemo(
    () => new AsciiDitherEffect({ dpr: gl.getPixelRatio() }),
    [gl],
  );

  useEffect(() => () => ascii.dispose(), [ascii]);

  useEffect(() => {
    const target = mode === "terminal" ? 1 : 0;
    const mix = gsap.to(ascii.uMix, {
      value: target,
      duration: 0.55,
      ease: "power2.inOut",
    });
    // one CRT pop, not a glitch loop
    const pop = gsap.fromTo(
      ascii.uGlitch,
      { value: 0 },
      { value: 1, duration: 0.15, yoyo: true, repeat: 1, ease: "power2.in" },
    );
    return () => {
      mix.kill();
      pop.kill();
    };
  }, [mode, ascii]);

  useFrame((_, delta) => {
    ascii.uTime.value += delta;
  });

  const q = QUALITY[quality];
  return (
    <EffectComposer multisampling={q.msaa}>
      {q.bloom ? (
        <Bloom mipmapBlur intensity={1.0} luminanceThreshold={0.32} luminanceSmoothing={0.25} />
      ) : (
        <></>
      )}
      <primitive object={ascii} dispose={null} />
      <Vignette eskil={false} offset={0.28} darkness={0.55} />
      <Noise premultiply opacity={0.035} />
    </EffectComposer>
  );
}

export default function HeroCanvas({ mode, onReady, onFailed, inView }: HeroSceneProps) {
  const [quality, setQuality] = useState<Quality>(2);
  const [failed, setFailed] = useState(false);

  /* Context lost → unmount AND tell the stage, which restores the poster
     (it also resets its `ready` flag so the poster isn't stuck at opacity 0). */
  if (failed) return null;

  const q = QUALITY[quality];

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
      camera={{ fov: 30, position: [0, 0, 7] }}
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
        <PerformanceLadder onDegrade={() => setQuality((prev) => (prev > 0 ? ((prev - 1) as Quality) : prev))} />
      ) : null}

      <StackMark />

      {/* Rim-light rig: runtime PMREM environment, rendered once (frames=1) */}
      <Environment resolution={256} frames={1}>
        <Lightformer
          form="rect"
          scale={[10, 0.8, 1]}
          position={[0, 4, -2]}
          rotation-x={Math.PI / 2}
          intensity={7}
          color="#ffffff"
        />
        <Lightformer
          form="rect"
          scale={[10, 0.6, 1]}
          position={[0, -4, -2]}
          rotation-x={-Math.PI / 2}
          intensity={2.2}
          color="#ffffff"
        />
        <Lightformer
          form="rect"
          scale={[3, 6, 1]}
          position={[-6, 0, 1]}
          rotation-y={Math.PI / 2}
          intensity={2.6}
          color="#007CF0"
        />
        <Lightformer
          form="rect"
          scale={[3, 6, 1]}
          position={[6, -1, 1]}
          rotation-y={-Math.PI / 2}
          intensity={2}
          color="#FF0080"
        />
      </Environment>

      {/* Chamfer accents that move with mouse parallax */}
      <pointLight position={[-3, 2.5, 4]} intensity={2.5} color="#00DFD8" distance={12} />
      <pointLight position={[3, -2, 4]} intensity={2} color="#FF4D4D" distance={12} />

      <Effects mode={mode} quality={quality} />
    </Canvas>
  );
}
