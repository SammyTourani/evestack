/* CDP CPU profile of page load — aggregates self time by function. */
import { chromium } from "@playwright/test";

const browser = await chromium.launch(); // no GPU: mirrors Lighthouse env
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.start");
await page.goto(process.argv[2] ?? "http://localhost:3005", { waitUntil: "networkidle" });
await page.waitForTimeout(4000);
const { profile } = await cdp.send("Profiler.stop");

const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas ?? [];
const samples = profile.samples ?? [];
for (let i = 0; i < samples.length; i++) {
  const node = nodes.get(samples[i]);
  if (!node) continue;
  const key = `${node.callFrame.functionName || "(anon)"} @ ${(node.callFrame.url || "").split("/").pop()}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [k, v] of top) console.log(`${(v / 1000).toFixed(1).padStart(8)} ms  ${k.slice(0, 110)}`);
await browser.close();
