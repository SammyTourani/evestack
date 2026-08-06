import type { NextConfig } from "next";

const config: NextConfig = {
  // Ships .next/standalone with only the modules the tracer proves are reached,
  // instead of a full --prod install. The files this app reads at REQUEST time
  // (sql/*.sql, fixtures/, the bundled skills) are invisible to the tracer, but
  // the Dockerfile already copies each of them explicitly, so the tracer never
  // needed to know about them.
  output: "standalone",
  // `pg` is a native-ish Node driver; keep it out of the bundler so Next does
  // not try to trace or inline it into a server bundle.
  serverExternalPackages: ["pg"],
};

export default config;
