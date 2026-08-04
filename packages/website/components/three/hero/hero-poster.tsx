/* Static poster — the permanent floor of the fallback ladder and the
   pre-canvas frame. Pure CSS approximation of the assembled ▚ mark
   (Phase 6 upgrades this to a captured render in an <picture>).
   Must stay renderable with zero JS. */
export function HeroPoster() {
  const slab =
    "rounded-[10px] border border-white/10 bg-gradient-to-br shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]";
  return (
    <div
      aria-hidden
      className="flex h-full w-full items-center justify-center"
      style={{ perspective: "900px" }}
    >
      <div
        className="grid aspect-square h-[82%] grid-cols-2 grid-rows-2 gap-[4.5%]"
        style={{ transform: "rotateX(6deg) rotateY(-9deg)" }}
      >
        <div className={`${slab} from-[#1d2025] to-[#08090b]`} />
        <div className={`${slab} translate-z-0 scale-[0.94] from-[#101216] to-[#050607] opacity-80`} />
        <div className={`${slab} scale-[0.94] from-[#101216] to-[#050607] opacity-80`} />
        <div className={`${slab} from-[#1d2025] to-[#08090b]`} />
      </div>
    </div>
  );
}
