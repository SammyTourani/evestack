import { Hero } from "@/components/sections/hero";
import { OneCommand } from "@/components/sections/one-command";
import { Comparison } from "@/components/sections/comparison";
import { CodeWalkthrough } from "@/components/sections/code-walkthrough";
import { FeaturesBento } from "@/components/sections/features-bento";
import { Architecture } from "@/components/sections/architecture";
import { Observability } from "@/components/sections/observability";
import { Stats } from "@/components/sections/stats";
import { ControlPlane } from "@/components/sections/control-plane";
import { Integrations } from "@/components/sections/integrations";
import { Quickstart } from "@/components/sections/quickstart";
import { ClosingCta } from "@/components/sections/closing-cta";

export default function Page() {
  return (
    <>
      <Hero />
      <OneCommand />
      <Comparison />
      <CodeWalkthrough />
      <FeaturesBento />
      <Architecture />
      <Observability />
      <Stats />
      <ControlPlane />
      <Integrations />
      <Quickstart />
      <ClosingCta />
    </>
  );
}
