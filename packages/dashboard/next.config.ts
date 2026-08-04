import type { NextConfig } from "next";

const config: NextConfig = {
  // `pg` is a native-ish Node driver; keep it out of the bundler so Next does
  // not try to trace or inline it into a server bundle.
  serverExternalPackages: ["pg"],
};

export default config;
