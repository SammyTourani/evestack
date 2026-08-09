/* sharp pipeline: raw PNGs → AVIF + WebP at 2x.
 *
 * ── The crop is measured, not remembered ─────────────────────────────────────
 *
 * These heights used to be four hardcoded numbers:
 *
 *   "sessions-dark":       { height: 1560 }
 *   "session-detail-dark": { height: 1360 }   … and their light twins
 *
 * They were correct for the layout of the day they were written, and there is
 * nothing in a number like 1560 that says which layout that was. The dashboard
 * redesign changed where the content ends on both pages, so every one of them
 * became wrong at once — and wrong quietly: a crop that is too short beheads the
 * last table row, one that is too tall pads the landing page with dead canvas.
 * Neither throws, and both survive review because 1560 looks as plausible as
 * 1490.
 *
 * So the crop is found by looking at the pixels: scan up from the bottom for the
 * first row that is not the page background, which is the same question the
 * numbers were an answer to. Re-running after any redesign now needs no thought
 * and no follow-up commit.
 */
import sharp from "sharp";
import { readdir, mkdir } from "node:fs/promises";
import path from "node:path";

/* Overridable so the measurement can be driven over a fixture. A crop that is
   computed rather than remembered still has to be shown to compute the right
   thing, and it cannot be if the only input it accepts is the real capture. */
const rawDir =
  process.env.SCREENSHOTS_RAW_DIR ?? new URL("../assets/screenshots-raw/", import.meta.url).pathname;
const outDir =
  process.env.SCREENSHOTS_OUT_DIR ?? new URL("../public/screenshots/", import.meta.url).pathname;
await mkdir(outDir, { recursive: true });

/** Breathing room under the last pixel of content, in 2x pixels. */
const PADDING = 48;

/**
 * The last row carrying content, found from the bottom of the MAIN COLUMN.
 *
 * ── Two things the obvious version gets wrong ────────────────────────────────
 *
 * THE SIDEBAR IS FULL HEIGHT. The first version of this sampled the background
 * from the bottom-LEFT corner, which on this dashboard is the sidebar, not the
 * page. The main column is a different shade, so every row differed from the
 * sample and every image reported its content ending at the last pixel — no crop
 * at all, in all four captures, silently. That is the same "looks plausible"
 * failure the hardcoded numbers had, reached by a different route, and it is why
 * the sample and the scan are both taken from the right-hand column now.
 *
 * THE SIDEBAR ALSO HAS CONTENT AT THE BOTTOM — a `self-hosted` pill and a Sign
 * out button, well below where the main column's table ends. Scanning the whole
 * width would let those decide the crop for a page whose real content stopped
 * hundreds of pixels earlier. Cropping is a question about the main column; the
 * sidebar fills whatever height it is given.
 *
 * TOLERANCE is not zero because text antialiases against the page background,
 * and an exact-match scan stops on the first faint pixel of it.
 */
async function contentHeight(file) {
  const image = sharp(file);
  const { width, height } = await image.metadata();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;

  const at = (x, y) => {
    const i = (y * info.width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };

  // Everything right of the sidebar. 220 CSS px at deviceScaleFactor 2 is 440;
  // a third of the width is comfortably past it at any capture size and still
  // leaves most of the page to scan.
  const mainStart = Math.floor(info.width / 3);

  // Bottom-right: the main column's own background, whatever the colour scheme.
  const background = at(info.width - 1, info.height - 1);
  const TOLERANCE = 6;
  const differs = (px) =>
    Math.abs(px[0] - background[0]) > TOLERANCE ||
    Math.abs(px[1] - background[1]) > TOLERANCE ||
    Math.abs(px[2] - background[2]) > TOLERANCE;

  // Sample across the row rather than testing every pixel: a full scan of a
  // 2880x1800 RGBA buffer is 20M reads per image for the same answer.
  const step = Math.max(1, Math.floor(info.width / 200));

  for (let y = info.height - 1; y >= 0; y -= 1) {
    for (let x = mainStart; x < info.width; x += step) {
      if (differs(at(x, y))) {
        return { width, height, contentBottom: y };
      }
    }
  }
  return { width, height, contentBottom: height - 1 };
}

const files = (await readdir(rawDir)).filter((f) => f.endsWith(".png"));
if (files.length === 0) {
  console.error(`no PNGs in ${rawDir} — run scripts/capture-screenshots.mjs first`);
  process.exit(1);
}

for (const file of files) {
  const base = path.basename(file, ".png");
  const full = path.join(rawDir, file);

  const { width, height, contentBottom } = await contentHeight(full);
  const cropped = Math.min(height, contentBottom + 1 + PADDING);

  let src = sharp(full);
  if (cropped < height) src = src.extract({ left: 0, top: 0, width, height: cropped });

  await src.clone().avif({ quality: 55 }).toFile(path.join(outDir, `${base}@2x.avif`));
  await src.clone().webp({ quality: 72 }).toFile(path.join(outDir, `${base}@2x.webp`));

  // The measured height is printed because packages/website/lib/copy.ts carries
  // it as an explicit `height:` for next/image, and a capture whose dimensions
  // moved needs that number updated with it.
  console.log(
    `${base}: ${width}x${height} → ${width}x${cropped} (content ends at ${contentBottom})`,
  );
}
console.log("done — put the new dimensions into packages/website/lib/copy.ts");
