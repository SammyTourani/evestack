"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { buildSpanTree } from "./span-tree";

gsap.registerPlugin(ScrollTrigger);

/* Instanced sprites + line segments — 3 draw calls total. uReveal is
   scrubbed by ScrollTrigger (the tree grows root-first); uTime runs free
   (scrub the REVEAL, never the LIFE). */

const PULSES_PER_EDGE = 3;

const nodeVert = /* glsl */ `
attribute float aDepth;
attribute float aSeed;
varying vec2 vUv;
varying float vDepth;
varying float vSeed;
void main() {
  vUv = uv;
  vDepth = aDepth;
  vSeed = aSeed;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const nodeFrag = /* glsl */ `
uniform float uTime;
uniform float uReveal;
varying vec2 vUv;
varying float vDepth;
varying float vSeed;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float glow = pow(smoothstep(1.0, 0.0, d), 2.4);
  float reveal = smoothstep(vDepth - 0.4, vDepth + 0.4, uReveal * 5.0);
  float flicker = vDepth > 3.5 ? (0.82 + 0.18 * sin(uTime * 3.0 + vSeed * 40.0)) : 1.0;
  vec3 tint = mix(vec3(0.0, 0.875, 0.847), vec3(0.42, 0.47, 0.52), vDepth / 4.0);
  float a = glow * reveal * flicker;
  gl_FragColor = vec4(tint * a, a);
}
`;

const edgeVert = /* glsl */ `
attribute float aDepth;
varying float vDepth;
void main() {
  vDepth = aDepth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const edgeFrag = /* glsl */ `
uniform float uReveal;
varying float vDepth;
void main() {
  float reveal = smoothstep(vDepth - 0.4, vDepth + 0.4, uReveal * 5.0);
  gl_FragColor = vec4(vec3(0.30, 0.42, 0.45) * 0.5, 0.35 * reveal);
}
`;

const pulseVert = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
attribute float aPhase;
attribute float aSpeed;
attribute float aDepth;
uniform float uTime;
varying vec2 vUv;
varying float vBright;
varying float vDepth;
void main() {
  vUv = uv;
  vDepth = aDepth;
  float t = fract(uTime * aSpeed + aPhase);
  vBright = sin(t * 3.14159);
  vec3 p = mix(aStart, aEnd, t);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.xy += position.xy; // billboard
  gl_Position = projectionMatrix * mv;
}
`;

const pulseFrag = /* glsl */ `
uniform float uReveal;
varying vec2 vUv;
varying float vBright;
varying float vDepth;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float glow = pow(smoothstep(1.0, 0.0, d), 3.0);
  float reveal = smoothstep(vDepth - 0.4, vDepth + 0.4, uReveal * 5.0);
  float a = glow * vBright * reveal * 0.9;
  gl_FragColor = vec4(vec3(0.0, 0.875, 0.847) * a, a);
}
`;

function TraceScene({ uniforms }: { uniforms: { uTime: THREE.Uniform<number>; uReveal: THREE.Uniform<number> } }) {
  const { nodes, edges } = useMemo(() => buildSpanTree(), []);

  const nodeMesh = useMemo(() => {
    const geo = new THREE.PlaneGeometry(0.3, 0.3);
    const mat = new THREE.ShaderMaterial({
      vertexShader: nodeVert,
      fragmentShader: nodeFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, nodes.length);
    const m = new THREE.Matrix4();
    const depths = new Float32Array(nodes.length);
    const seeds = new Float32Array(nodes.length);
    nodes.forEach((n, i) => {
      m.setPosition(n.x, n.y, 0);
      mesh.setMatrixAt(i, m);
      depths[i] = n.depth;
      seeds[i] = n.seed;
    });
    geo.setAttribute("aDepth", new THREE.InstancedBufferAttribute(depths, 1));
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }, [nodes, uniforms]);

  const edgeLines = useMemo(() => {
    const positions = new Float32Array(edges.length * 6);
    const depths = new Float32Array(edges.length * 2);
    edges.forEach((e, i) => {
      const a = nodes[e.from];
      const b = nodes[e.to];
      positions.set([a.x, a.y, 0, b.x, b.y, 0], i * 6);
      depths[i * 2] = a.depth;
      depths[i * 2 + 1] = b.depth;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aDepth", new THREE.BufferAttribute(depths, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: edgeVert,
      fragmentShader: edgeFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    return new THREE.LineSegments(geo, mat);
  }, [nodes, edges, uniforms]);

  const pulseMesh = useMemo(() => {
    const count = edges.length * PULSES_PER_EDGE;
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(0.14, 0.14);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    const starts = new Float32Array(count * 3);
    const ends = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const speeds = new Float32Array(count);
    const depths = new Float32Array(count);
    let k = 0;
    edges.forEach((e) => {
      const a = nodes[e.from];
      const b = nodes[e.to];
      for (let j = 0; j < PULSES_PER_EDGE; j++) {
        starts.set([a.x, a.y, 0], k * 3);
        ends.set([b.x, b.y, 0], k * 3);
        phases[k] = (j / PULSES_PER_EDGE + Math.abs(Math.sin(k * 7.13))) % 1;
        speeds[k] = 0.25 + Math.abs(Math.sin(k * 3.7)) * 0.3;
        depths[k] = nodes[e.to].depth;
        k++;
      }
    });
    geo.setAttribute("aStart", new THREE.InstancedBufferAttribute(starts, 3));
    geo.setAttribute("aEnd", new THREE.InstancedBufferAttribute(ends, 3));
    geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
    geo.setAttribute("aSpeed", new THREE.InstancedBufferAttribute(speeds, 1));
    geo.setAttribute("aDepth", new THREE.InstancedBufferAttribute(depths, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: pulseVert,
      fragmentShader: pulseFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }, [nodes, edges, uniforms]);

  useEffect(() => {
    return () => {
      nodeMesh.geometry.dispose();
      (nodeMesh.material as THREE.Material).dispose();
      edgeLines.geometry.dispose();
      (edgeLines.material as THREE.Material).dispose();
      pulseMesh.geometry.dispose();
      (pulseMesh.material as THREE.Material).dispose();
    };
  }, [nodeMesh, edgeLines, pulseMesh]);

  useFrame((_, delta) => {
    uniforms.uTime.value += delta;
  });

  return (
    <>
      <primitive object={edgeLines} />
      <primitive object={nodeMesh} />
      <primitive object={pulseMesh} />
    </>
  );
}

export default function TraceCanvas({ inView }: { inView: boolean }) {
  const uniforms = useRef({
    uTime: new THREE.Uniform(0),
    uReveal: new THREE.Uniform(0),
  }).current;

  /* Scrub the REVEAL against the observability section. */
  useEffect(() => {
    const st = ScrollTrigger.create({
      trigger: "#observability",
      start: "top 80%",
      end: "top 25%",
      scrub: 0.5,
      onUpdate: (self) => {
        uniforms.uReveal.value = self.progress;
      },
    });
    return () => st.kill();
  }, [uniforms]);

  return (
    <Canvas
      gl={{ antialias: false, stencil: false, depth: false, powerPreference: "high-performance" }}
      dpr={[1, 1.5]}
      frameloop={inView ? "always" : "never"}
      camera={{ fov: 40, position: [0, 0, 7.5] }}
      className="pointer-events-none"
      aria-hidden
    >
      <TraceScene uniforms={uniforms} />
    </Canvas>
  );
}
