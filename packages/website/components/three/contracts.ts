export interface HeroSceneProps {
  /** resolved site theme — the scene re-materials for light vs dark */
  theme: "dark" | "light";
  /** Fire after the first rendered frame → triggers poster crossfade. */
  onReady: () => void;
  /** Fire on WebGL context loss → stage restores the poster permanently. */
  onFailed: () => void;
  /** Drives frameloop: 'always' while the hero is on screen, 'never' off. */
  inView: boolean;
}
