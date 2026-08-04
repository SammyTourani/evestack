import * as THREE from "three";
import { Effect } from "postprocessing";

/* "Terminal mode": glyph-atlas ASCII + 4×4 Bayer dither, as a custom Effect
   inside the single merged EffectPass (drei's AsciiRenderer is DOM-table
   based and would replace canvas output entirely — wrong tool).
   uMix 0 → early-out passthrough, effectively free in dashboard mode. */

const GLYPHS = " .:-=+*#▚▓@";

function createGlyphAtlas(): THREE.CanvasTexture {
  const cell = 32;
  const canvas = document.createElement("canvas");
  canvas.width = cell * GLYPHS.length;
  canvas.height = cell;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const mono =
    getComputedStyle(document.body).getPropertyValue("--font-geist-mono").trim() ||
    "monospace";
  ctx.font = `${cell * 0.78}px ${mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  for (let i = 0; i < GLYPHS.length; i++) {
    ctx.fillText(GLYPHS[i], i * cell + cell / 2, cell / 2 + 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

const fragmentShader = /* glsl */ `
uniform float uMix;
uniform float uCell;
uniform float uGlitch;
uniform float uTime;
uniform sampler2D uAtlas;

#define GLYPH_COUNT 11.0

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}

float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uMix < 0.001) {
    outputColor = inputColor;
    return;
  }

  vec2 cellPx = vec2(uCell);
  vec2 cellIndex = floor(uv * resolution / cellPx);
  vec2 cellOrigin = cellIndex * cellPx / resolution;
  vec2 cellCenter = cellOrigin + (cellPx * 0.5) / resolution;

  // One-shot CRT pop: horizontal row displacement while uGlitch > 0
  float rowNoise = fract(sin(cellIndex.y * 91.7 + floor(uTime * 24.0) * 7.3) * 43758.5453);
  float glitchShift = uGlitch * (rowNoise - 0.5) * 8.0 * uCell / resolution.x;

  vec3 scene = texture2D(inputBuffer, clamp(cellCenter + vec2(glitchShift, 0.0), 0.0, 1.0)).rgb;
  float lum = dot(scene, vec3(0.299, 0.587, 0.114));

  // Bayer-dithered quantization keeps the glow gradients from banding
  float dithered = clamp(lum + (bayer4(cellIndex) - 0.5) * 0.22, 0.0, 0.999);
  float glyphIndex = floor(pow(dithered, 0.72) * GLYPH_COUNT);

  vec2 cellFrac = fract(uv * resolution / cellPx);
  vec2 atlasUv = vec2((glyphIndex + cellFrac.x) / GLYPH_COUNT, cellFrac.y);
  float glyph = texture2D(uAtlas, atlasUv).r;

  // Neutral light gray with a 12% cyan tint + soft scanline — no phosphor cliché
  vec3 ink = mix(vec3(0.91), vec3(0.0, 0.875, 0.847), 0.12);
  float scanline = 0.92 + 0.08 * sin(uv.y * resolution.y * 3.14159 / uCell);
  vec3 ascii = glyph * ink * scanline * (0.35 + 0.85 * dithered);

  outputColor = vec4(mix(inputColor.rgb, ascii, uMix), inputColor.a);
}
`;

export class AsciiDitherEffect extends Effect {
  constructor({ dpr = 1 }: { dpr?: number } = {}) {
    super("AsciiDitherEffect", fragmentShader, {
      uniforms: new Map<string, THREE.Uniform>([
        ["uMix", new THREE.Uniform(0)],
        ["uCell", new THREE.Uniform(9 * dpr)],
        ["uGlitch", new THREE.Uniform(0)],
        ["uTime", new THREE.Uniform(0)],
        ["uAtlas", new THREE.Uniform(createGlyphAtlas())],
      ]),
    });
  }

  get uMix(): THREE.Uniform<number> {
    return this.uniforms.get("uMix") as THREE.Uniform<number>;
  }
  get uGlitch(): THREE.Uniform<number> {
    return this.uniforms.get("uGlitch") as THREE.Uniform<number>;
  }
  get uTime(): THREE.Uniform<number> {
    return this.uniforms.get("uTime") as THREE.Uniform<number>;
  }

  dispose(): void {
    (this.uniforms.get("uAtlas")?.value as THREE.Texture | undefined)?.dispose();
    super.dispose();
  }
}
