/* The fallback ladder, evaluated client-side before the 3D chunk is even
   requested. Any rung failing → static poster forever, chunk never downloads. */
export function canRunHeroScene(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;

  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) return false;
  if (nav.connection?.saveData) return false;

  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    // Chromium no longer flags SwiftShader as a performance caveat —
    // reject known software rasterizers by renderer string.
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (info) {
      const renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
      if (/swiftshader|llvmpipe|software|microsoft basic render/i.test(renderer)) {
        return false;
      }
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    return false;
  }
  return true;
}
