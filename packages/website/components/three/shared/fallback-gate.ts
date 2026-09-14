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
    let gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    /* The caveat flag is a DESKTOP guard: it is here to reject software
       rasterisers on a laptop, where the scene would run at 5fps. iOS Safari
       reports a major performance caveat for hardware that renders this scene
       fine, so on a phone that flag was silently turning the hero off and
       leaving the static poster — which is exactly what Sammy saw and read as
       "the square animation is fully gone". Below 48rem, ask again without it;
       the software-rasteriser check below still runs either way, and the
       lost-context and onFailed paths still fall back to the poster if the
       device genuinely cannot cope. */
    if (!gl && window.matchMedia("(max-width: 47.999rem)").matches) {
      gl = canvas.getContext("webgl2");
    }
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
