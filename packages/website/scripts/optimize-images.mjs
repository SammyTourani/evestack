/* sharp pipeline: raw PNGs → AVIF + WebP at display + 2x sizes. */
import sharp from "sharp";
import { readdir, mkdir } from "node:fs/promises";
import path from "node:path";

const rawDir = new URL("../assets/screenshots-raw/", import.meta.url).pathname;
const outDir = new URL("../public/screenshots/", import.meta.url).pathname;
await mkdir(outDir, { recursive: true });

// crop away empty canvas below the content (2x pixel values)
const crops = {
  "session-detail-dark": { left: 0, top: 0, width: 2880, height: 1360 },
  "session-detail-light": { left: 0, top: 0, width: 2880, height: 1360 },
  "sessions-dark": { left: 0, top: 0, width: 2880, height: 1560 },
  "sessions-light": { left: 0, top: 0, width: 2880, height: 1560 },
};

const files = (await readdir(rawDir)).filter((f) => f.endsWith(".png"));
for (const file of files) {
  const base = path.basename(file, ".png");
  let src = sharp(path.join(rawDir, file));
  if (crops[base]) src = src.extract(crops[base]);
  const { width } = await src.clone().metadata();
  // captures are 2x; emit as-is (2x) — next/image gets explicit dimensions
  await src.clone().avif({ quality: 55 }).toFile(path.join(outDir, `${base}@2x.avif`));
  await src.clone().webp({ quality: 72 }).toFile(path.join(outDir, `${base}@2x.webp`));
  console.log(`${base}: ${width}px → avif+webp`);
}
console.log("done");
