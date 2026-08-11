import { Hero } from "@/components/sections/hero";
import { OneCommand } from "@/components/sections/one-command";
import { FeaturesBento } from "@/components/sections/features-bento";
import { Observability } from "@/components/sections/observability";
import { Integrations } from "@/components/sections/integrations";
import { Architecture } from "@/components/sections/architecture";
import { Comparison } from "@/components/sections/comparison";
import { Quickstart } from "@/components/sections/quickstart";
import { ClosingCta } from "@/components/sections/closing-cta";

/* NINE SECTIONS, down from twelve (2026-08-10).
 *
 * The page ran 12 sections, 12 viewports and ~1,570 words, and a first-time
 * visitor met a comparison table against a product they had never heard of as
 * the second thing on it. What changed and why:
 *
 *   - Stats DELETED. Four numbers, three of which a reader cannot act on
 *     ("38 events persisted from one message"). The one that mattered, $0, is
 *     already a cell in the features grid.
 *   - ControlPlane MERGED into Observability. Watching your agents and being
 *     able to stop them is one idea; it was costing a screen to say the second
 *     half of it.
 *   - CodeWalkthrough MERGED into Architecture. The diagram and the files that
 *     implement it belong together, and "The code is the pitch" only ever
 *     spoke to readers who were already sold.
 *   - Comparison MOVED from second to seventh. It answers "why not just pay
 *     someone?", which is a question a reader has only after they know what
 *     the thing is. In second position it was the earliest point at which the
 *     page stopped making sense.
 *
 * The order now follows the questions a visitor actually asks, in order: what
 * is it, how do I get it, what does it do, can I see it working, does it talk
 * to my tools, how does it work, why not pay someone, how do I start.
 */
export default function Page() {
  return (
    <>
      <Hero />
      <OneCommand />
      <FeaturesBento />
      <Observability />
      <Integrations />
      <Architecture />
      <Comparison />
      <Quickstart />
      <ClosingCta />
    </>
  );
}
