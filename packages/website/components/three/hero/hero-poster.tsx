/* Static poster — the permanent floor of the fallback ladder and the
   pre-canvas frame. Pure CSS approximation of the assembled ▚ mark,
   theme-aware. Must stay renderable with zero JS. */
export function HeroPoster() {
  const slab =
    "rounded-[10px] border bg-gradient-to-br shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] " +
    "border-white/10 dark:border-white/10 border-black/10";
  const proud = "from-[#e3e4e8] to-[#c8cad0] dark:from-[#1d2025] dark:to-[#08090b]";
  const recessed =
    "scale-[0.94] opacity-80 from-[#d3d5db] to-[#bfc1c8] dark:from-[#101216] dark:to-[#050607]";
  return (
    <div
      aria-hidden
      className="flex h-full w-full items-center justify-center"
      style={{ perspective: "900px" }}
    >
      <div
        className="grid aspect-square h-[74%] grid-cols-2 grid-rows-2 gap-[4.5%]"
        style={{ transform: "rotateX(6deg) rotateY(-9deg) translateY(-4%)" }}
      >
        <div className={`${slab} ${proud}`} />
        <div className={`${slab} ${recessed}`} />
        <div className={`${slab} ${recessed}`} />
        <div className={`${slab} ${proud}`} />
      </div>
    </div>
  );
}
