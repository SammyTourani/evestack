/* Real-event interaction audit: anchors, marquee pause, spotlight, magnetic. */
import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
});
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);

await page.goto(process.argv[2] ?? "http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(2200);

// 1 — nav anchor click scrolls to the section (Lenis anchors path)
await page.locator("header nav a", { hasText: "Compare" }).first().click();
await page.waitForTimeout(1600);
const compareTop = await page.evaluate(
  () => document.getElementById("compare").getBoundingClientRect().top,
);
check("nav anchor scrolls to #compare", compareTop > -40 && compareTop < 200, `top=${Math.round(compareTop)}`);

// 2 — marquee pause button toggles play state
await page.evaluate(() =>
  document.getElementById("integrations").scrollIntoView({ block: "center", behavior: "instant" }),
);
await page.waitForTimeout(600);
const pauseBtn = page.getByRole("button", { name: /pause marquee/i });
await pauseBtn.click();
const playState = await page.evaluate(
  () => getComputedStyle(document.querySelector("#integrations ul")).animationPlayState,
);
check("marquee pause control", playState === "paused", `state=${playState}`);

// 3 — spotlight hover writes --mx on bento card
await page.evaluate(() =>
  document.getElementById("features").scrollIntoView({ block: "center", behavior: "instant" }),
);
await page.waitForTimeout(800);
const card = page.locator("#features li").first();
await card.hover({ position: { x: 120, y: 90 } });
await page.waitForTimeout(200);
const mx = await page.evaluate(() => {
  const el = document.querySelector("#features li .group");
  return el ? el.style.getPropertyValue("--mx") : "(no .group)";
});
check("bento spotlight tracks cursor", /px/.test(mx), `--mx=${mx}`);

// 4 — magnetic button responds to hover
await page.evaluate(() =>
  document.getElementById("get-started").scrollIntoView({ block: "center", behavior: "instant" }),
);
await page.waitForTimeout(800);
const magnet = page.locator("[data-magnetic]").last();
await magnet.hover({ position: { x: 10, y: 8 } });
await page.waitForTimeout(500);
const transform = await page.evaluate(() => {
  const els = document.querySelectorAll("[data-magnetic]");
  return getComputedStyle(els[els.length - 1]).transform;
});
check("magnetic button attracts", transform !== "none" && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(transform), transform.slice(0, 40));

// 5 — footer theme switch persists after reload
await page.getByRole("button", { name: "light", exact: true }).click();
await page.waitForTimeout(300);
await page.reload({ waitUntil: "networkidle" });
const isLight = await page.evaluate(() => document.documentElement.classList.contains("light"));
check("theme choice persists across reload", isLight);

console.log(results.join("\n"));
await browser.close();
