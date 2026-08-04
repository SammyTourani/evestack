/* Module singleton bridging GSAP ScrollTrigger → R3F useFrame consumers.
   ScrollTrigger writes; useFrame reads. No React state, no re-renders. */
export const scrollState = {
  /** Hero disassembly progress 0..1 (0 = assembled mark). */
  heroProgress: 0,
};
