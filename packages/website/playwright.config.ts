import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    launchOptions: {
      args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
    },
  },
});
