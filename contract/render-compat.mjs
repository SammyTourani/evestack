#!/usr/bin/env node
/**
 * Renders contract/history/*.json into the public compatibility page.
 *
 * The page answers the one question everybody asks about a distribution built
 * on top of a framework that merges ~19 PRs a day: "how long until this breaks
 * without telling me?" A promise is not an answer. A table of real suite runs
 * against every published eve release, with the failing assertions named and
 * the tarball hashes recorded, is.
 *
 * Usage:
 *   node contract/render-compat.mjs
 *   node contract/render-compat.mjs --out=some/dir/index.html
 *
 * Output is one file with no external CSS, JS, fonts or images, because it has
 * to be droppable into any static host — including as a sub-path of the Next.js
 * site that already owns this repo's GitHub Pages deployment.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT } from "./lib/repo.mjs";
import { compare } from "./lib/semver.mjs";

const HISTORY_DIR = join(REPO_ROOT, "contract", "history");
const DEFAULT_OUT = join(REPO_ROOT, "docs-site", "compat", "index.html");
const REPO_URL = "https://github.com/SammyTourani/evestack";

/**
 * This contract asks "does the eve under test satisfy the ranges evestack's
 * manifests declare *today*" — a fact about our package.json files, not about
 * eve's API. It cannot hold for any version we do not currently pin, so the
 * page separates it out or the matrix reads as "eve 0.30.5 is broken", which
 * is a lie.
 *
 * Since it is declared `scope: "repo"`, the runner now skips it outright on a
 * back-certification run rather than failing it, so these cells read ⊘ instead
 * of a warning ✗. The separation here is kept anyway: it is what makes the
 * headline verdict count only contracts that describe eve, and it still holds
 * if someone drops the scope declaration. Looked up by id and tolerated if
 * absent, so renaming or deleting the contract degrades to "14 API contracts"
 * rather than crashing.
 */
const PIN_CONTRACT_ID = "version/installed-satisfies-every-declared-range";

/* -------------------------------------------------------------------------- */
/* load                                                                        */
/* -------------------------------------------------------------------------- */

const outFile = resolve(REPO_ROOT, process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? DEFAULT_OUT);

function loadHistory() {
  let files;
  try {
    files = readdirSync(HISTORY_DIR).filter((f) => f.startsWith("eve-") && f.endsWith(".json"));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    process.stderr.write(`No reports in ${HISTORY_DIR}. Record one first:\n  node contract/record.mjs\n`);
    process.exit(2);
  }
  // Newest first: the version a reader cares about is the one they are about to
  // install, and that is the top-left cell.
  return files
    .map((f) => JSON.parse(readFileSync(join(HISTORY_DIR, f), "utf8")))
    .sort((a, b) => compare(b.eveVersion, a.eveVersion));
}

const history = loadHistory();

/* -------------------------------------------------------------------------- */
/* derive                                                                      */
/* -------------------------------------------------------------------------- */

/** Contract ids in the order the runner emits them, unioned across all runs. */
const contractIds = [];
const contractMeta = new Map();
for (const entry of history) {
  for (const c of entry.contracts) {
    if (!contractMeta.has(c.id)) {
      contractIds.push(c.id);
      contractMeta.set(c.id, { id: c.id, title: c.title, assumption: c.assumption, evestackUse: c.evestackUse, file: c.file });
    }
  }
}
const apiContractIds = contractIds.filter((id) => id !== PIN_CONTRACT_ID);

const byVersion = new Map(history.map((e) => [e.eveVersion, new Map(e.contracts.map((c) => [c.id, c]))]));

/** True when every contract that describes eve's API held for this version. */
function apiHolds(entry) {
  const rows = byVersion.get(entry.eveVersion);
  return apiContractIds.every((id) => rows.get(id)?.status === "pass");
}

function apiCounts(entry) {
  const rows = byVersion.get(entry.eveVersion);
  let assertions = 0;
  let failed = 0;
  let brokenContracts = 0;
  for (const id of apiContractIds) {
    const c = rows.get(id);
    if (c === undefined) continue;
    assertions += c.assertions.length;
    const bad = c.assertions.filter((a) => !a.passed).length;
    failed += bad;
    if (bad > 0) brokenContracts += 1;
  }
  return { assertions, failed, brokenContracts };
}

/**
 * The headline row. `eveLatestTagAtCertification` is what npm called `latest`
 * at the moment the suite ran, so a version equal to it was certified while it
 * was the newest thing published — which is the only row whose publish→certify
 * lag means anything. Everything else was back-certified in a batch.
 */
const certifiedWhileLatest = history.filter((e) => e.eveVersion === e.eveLatestTagAtCertification);
const current = certifiedWhileLatest[0] ?? history.find((e) => e.ok) ?? history[0];

function lagMs(entry) {
  if (!entry?.eveReleasedAt || !entry?.certifiedAt) return null;
  return Date.parse(entry.certifiedAt) - Date.parse(entry.eveReleasedAt);
}

function formatLag(ms) {
  if (ms === null || Number.isNaN(ms)) return null;
  const minutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Dates are formatted by hand rather than through Intl on purpose. This page is
 * committed and CI diffs a fresh render against it to prove the HTML still
 * matches the JSON; an ICU version difference between a contributor's Node and
 * the runner's would show up as a phantom drift failure. Same input, same
 * bytes, on every machine.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function day(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function minute(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${day(iso)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** The busiest publish day in the tested range, e.g. "7 releases on 4 Aug 2026". */
function busiestReleaseDay() {
  const counts = new Map();
  for (const entry of history) {
    if (!entry.eveReleasedAt) continue;
    const key = entry.eveReleasedAt.slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  for (const [date, count] of counts) if (best === null || count > best.count) best = { date, count };
  return best;
}

const busiest = busiestReleaseDay();
const oldest = history[history.length - 1];

/**
 * Deliberately not `new Date()`: the page is committed and CI re-renders it to
 * check it still matches the reports, so every byte of output has to be derived
 * from the inputs.
 */
const newestCertification = history.map((e) => e.certifiedAt).filter(Boolean).sort().at(-1) ?? null;

/* -------------------------------------------------------------------------- */
/* html                                                                        */
/* -------------------------------------------------------------------------- */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cell(entry, id) {
  const c = byVersion.get(entry.eveVersion).get(id);
  if (c === undefined) {
    return `<td class="s s-none" title="not run against eve ${esc(entry.eveVersion)}">·</td>`;
  }
  const isPin = id === PIN_CONTRACT_ID;
  // Must precede the `failed === 0` branch below. A skipped contract records
  // zero assertions, so falling through would render it as a green tick over
  // an empty run — the page claiming a check it deliberately did not perform.
  if (c.status === "skip") {
    return `<td class="s s-skip" title="${esc(id)} — not run against eve ${esc(entry.eveVersion)}: ${esc(c.skipReason ?? "out of scope for this version")}"><span aria-hidden="true">⊘</span><span class="sr">skipped</span></td>`;
  }
  const failed = c.assertions.filter((a) => !a.passed).length;
  if (failed === 0) {
    return `<td class="s s-pass" title="${esc(id)} — ${c.assertions.length} assertions held on eve ${esc(entry.eveVersion)}"><span aria-hidden="true">✓</span><span class="sr">pass</span></td>`;
  }
  const klass = isPin ? "s-pin" : "s-fail";
  const label = isPin ? "pin mismatch" : "fail";
  return `<td class="s ${klass}" title="${esc(id)} — ${failed} of ${c.assertions.length} assertions failed on eve ${esc(entry.eveVersion)}"><span aria-hidden="true">✗</span><span class="sr">${label}</span><b>${failed}/${c.assertions.length}</b></td>`;
}

function versionHeader(entry) {
  const badges = [];
  if (entry.eveVersion === current.eveVersion) badges.push('<em class="badge badge-now">certified</em>');
  if (entry.eveVersion === entry.eveLatestTagAtCertification) badges.push('<em class="badge">npm latest</em>');
  return `<th scope="col" class="vh">
        <span class="v">${esc(entry.eveVersion)}</span>
        ${badges.join("")}
        <span class="vd">certified<br>${esc(day(entry.certifiedAt))}</span>
      </th>`;
}

function contractRow(id) {
  const meta = contractMeta.get(id);
  const isPin = id === PIN_CONTRACT_ID;
  return `<tr${isPin ? ' class="row-pin"' : ""}>
      <th scope="row" class="ch">
        <code>${esc(meta.id)}</code>${isPin ? '<em class="badge badge-pin">bookkeeping, not eve</em>' : ""}
        <span class="ct">${esc(meta.title)}</span>
      </th>
      ${history.map((entry) => cell(entry, id)).join("\n      ")}
    </tr>`;
}

function assertionList(contract) {
  return contract.assertions
    .filter((a) => !a.passed)
    .map((a) => {
      const diff = [];
      if (a.expected !== undefined) diff.push(`<span class="exp">expected</span> <code>${esc(a.expected)}</code>`);
      if (a.actual !== undefined) diff.push(`<span class="act">actual</span> <code>${esc(a.actual)}</code>`);
      return `<li><span class="x" aria-hidden="true">✗</span> ${esc(a.detail)}${diff.length > 0 ? `<span class="diff">${diff.join("")}</span>` : ""}</li>`;
    })
    .join("\n            ");
}

function failureSection(entry) {
  const rows = byVersion.get(entry.eveVersion);
  const broken = contractIds
    .map((id) => rows.get(id))
    .filter((c) => c !== undefined && c.status === "fail")
    // Pin bookkeeping last. A reader opening eve 0.29.5 wants the remote auth
    // bypass, not seven lines about which range our manifests declare.
    .sort((a, b) => Number(a.id === PIN_CONTRACT_ID) - Number(b.id === PIN_CONTRACT_ID));
  if (broken.length === 0) return "";

  const apiBroken = broken.filter((c) => c.id !== PIN_CONTRACT_ID);
  const summary =
    apiBroken.length === 0
      ? `<span class="pill pill-pin">pin only</span> every API contract held — this is simply not the version evestack pins today`
      : `<span class="pill pill-fail">${apiBroken.length} API contract${apiBroken.length === 1 ? "" : "s"} broken</span> eve changed under us here`;

  const blocks = broken
    .map((c) => {
      const meta = contractMeta.get(c.id);
      const isPin = c.id === PIN_CONTRACT_ID;
      const failed = c.assertions.filter((a) => !a.passed).length;
      return `<article class="broken${isPin ? " broken-pin" : ""}">
          <h4><code>${esc(c.id)}</code> <span class="tally">${failed} of ${c.assertions.length} assertions failed</span></h4>
          <p class="assume"><b>What evestack assumed:</b> ${esc(meta.assumption)}</p>
          <ul class="failed">
            ${assertionList(c)}
          </ul>
          <p class="blast"><b>${isPin ? "Why this is not an eve break:" : "What this breaks in evestack:"}</b> ${
            isPin
              ? `this contract compares the eve under test against the ranges evestack's own manifests declare right now (<code>${esc(entry.evestackPin)}</code>). Every older release fails it the moment we bump the pin. It is on this page for completeness, not as a verdict on eve ${esc(entry.eveVersion)}.`
              : esc(meta.evestackUse)
          }</p>
          <p class="where">Defined in <code>${esc(meta.file)}</code>.</p>
        </article>`;
    })
    .join("\n        ");

  return `<details class="vfail"${apiBroken.length > 0 ? " open" : ""}>
        <summary><b>eve ${esc(entry.eveVersion)}</b> ${summary}</summary>
        ${blocks}
      </details>`;
}

const currentApi = apiCounts(current);
const currentLag = formatLag(lagMs(current));
const greenVersions = history.filter((e) => apiHolds(e));

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eve compatibility — evestack</title>
<meta name="description" content="Every published eve release, run through evestack's ${contractIds.length}-contract, ${current.counts.assertions}-assertion suite. Green, red, and the exact assertions that failed.">
<meta name="color-scheme" content="light dark">
<style>
:root{
  --bg:#fbfbf9; --panel:#ffffff; --ink:#15161a; --muted:#61636b; --faint:#8b8d95;
  --line:#e3e3df; --line-strong:#cfcfc9;
  --ok:#0d7a4a; --ok-bg:#e8f5ee; --ok-line:#b7e0c9;
  --bad:#b3202b; --bad-bg:#fceceb; --bad-line:#f0c2c0;
  --warn:#8a6100; --warn-bg:#fbf2dd; --warn-line:#ebd9a8;
  --code:#f2f2ee;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0d0e11; --panel:#15171b; --ink:#e9eaee; --muted:#9b9ea8; --faint:#6f727c;
    --line:#25272d; --line-strong:#343740;
    --ok:#4cc98a; --ok-bg:#0f2a1e; --ok-line:#1d4a35;
    --bad:#ff8a83; --bad-bg:#2c1414; --bad-line:#592422;
    --warn:#e0b34a; --warn-bg:#2a2210; --warn-line:#4d3f19;
    --code:#1c1e23;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:16px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  font-feature-settings:"kern","liga";
}
code,kbd{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:.86em}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
a{color:inherit;text-decoration-color:var(--line-strong);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}

header.top{border-bottom:1px solid var(--line);padding:56px 0 40px;margin-bottom:40px}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 14px}
h1{font-size:clamp(30px,5vw,44px);line-height:1.1;letter-spacing:-.022em;margin:0 0 14px;font-weight:640}
.lede{font-size:clamp(16px,2.2vw,19px);color:var(--muted);margin:0;max-width:66ch}

.verdict{
  border:1px solid var(--ok-line);background:var(--ok-bg);border-radius:14px;
  padding:22px 24px;margin:32px 0 12px;
}
.verdict.red{border-color:var(--bad-line);background:var(--bad-bg)}
.verdict h2{margin:0 0 8px;font-size:clamp(19px,2.6vw,23px);letter-spacing:-.015em;font-weight:640}
.verdict h2 .dot{color:var(--ok)}
.verdict.red h2 .dot{color:var(--bad)}
.verdict p{margin:0;color:var(--muted);max-width:74ch}
.verdict b{color:var(--ink);font-weight:620}

/* Real gaps rather than the 1px-grid-background trick: an odd number of stats
   leaves a half-empty final row, and with that trick the container colour shows
   through it as a grey slab. */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin:0 0 44px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px 17px}
.stat .n{display:block;font-size:24px;font-weight:640;letter-spacing:-.02em;line-height:1.2}
.stat .l{display:block;font-size:12.5px;color:var(--muted);margin-top:3px}

section{margin:0 0 52px}
h2.sec{font-size:22px;letter-spacing:-.018em;margin:0 0 6px;font-weight:640}
h2.sec + .sub{margin:0 0 22px;color:var(--muted);max-width:74ch}
h3{font-size:17px;margin:26px 0 6px;font-weight:620;letter-spacing:-.01em}
p{max-width:74ch}

.prose p{color:var(--muted)}
.prose b,.prose strong{color:var(--ink);font-weight:620}
.prose code{background:var(--code);padding:.12em .38em;border-radius:5px}

.scroller{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
table.matrix{border-collapse:separate;border-spacing:0;width:100%;font-size:13.5px}
table.matrix th,table.matrix td{border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
table.matrix thead th{
  position:sticky;top:0;background:var(--panel);z-index:2;
  border-bottom:1px solid var(--line-strong);padding:12px 10px;font-weight:600
}
/* Sized so all eight tested versions fit at desktop width without scrolling:
   the 0.29.5 control is the most interesting column on the page and must not be
   the one that falls off the right edge. Narrower viewports still scroll. */
th.corner{min-width:262px;width:26%;position:sticky;left:0;z-index:3;background:var(--panel)}
th.vh{text-align:center;min-width:97px;white-space:nowrap}
th.vh .v{display:block;font-size:15px;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
th.vh .vd{display:block;font-size:10.5px;color:var(--faint);font-weight:400;margin-top:5px;line-height:1.35}
.badge{display:inline-block;font-style:normal;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;
  border:1px solid var(--line-strong);color:var(--muted);border-radius:999px;padding:1px 6px;margin-top:5px;font-weight:600}
/* Stacked, not side by side: two badges on one line make the certified column
   half again as wide as the others and push the oldest version off the edge. */
th.vh .badge{display:block;width:max-content;margin:4px auto 0}
.badge-now{border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)}
.badge-pin{border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn);margin:0 0 0 7px;vertical-align:1px}

th.ch{position:sticky;left:0;background:var(--panel);z-index:1;padding:11px 14px 11px 14px;font-weight:400;border-right:1px solid var(--line)}
th.ch code{font-size:12.5px;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}
th.ch .ct{display:block;color:var(--muted);font-size:12px;line-height:1.45;margin-top:2px}
tr.row-pin th.ch,tr.row-pin td{background:var(--panel);opacity:.92}

td.s{text-align:center;font-variant-numeric:tabular-nums;padding:11px 8px}
td.s span{font-size:15px;font-weight:700;line-height:1}
td.s b{display:block;font-size:10.5px;font-weight:600;margin-top:3px;letter-spacing:-.01em}
.s-pass{color:var(--ok);background:var(--ok-bg)}
.s-fail{color:var(--bad);background:var(--bad-bg)}
.s-pin{color:var(--warn);background:var(--warn-bg)}
.s-skip{color:var(--faint)}
.s-none{color:var(--faint)}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
tr.overall th.ch{font-weight:600}
tr.overall th.ch span.ct{color:var(--faint)}
tr.overall td.s,tr.overall th.ch{border-bottom:1px solid var(--line-strong)}

.legend{display:flex;flex-wrap:wrap;gap:18px;margin:14px 0 0;font-size:13px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:7px}
.key{display:inline-block;width:15px;height:15px;border-radius:4px;text-align:center;line-height:15px;font-size:11px;font-weight:700}
.key.pass{background:var(--ok-bg);color:var(--ok)}
.key.fail{background:var(--bad-bg);color:var(--bad)}
.key.pin{background:var(--warn-bg);color:var(--warn)}
.key.skip{background:var(--panel);color:var(--faint);border:1px solid var(--line)}

details.vfail{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:0;margin:0 0 14px}
details.vfail > summary{cursor:pointer;padding:15px 18px;font-size:15px;list-style:none}
details.vfail > summary::-webkit-details-marker{display:none}
details.vfail > summary::before{content:"▸";display:inline-block;width:16px;color:var(--faint)}
details.vfail[open] > summary::before{content:"▾"}
details.vfail[open] > summary{border-bottom:1px solid var(--line)}
.pill{display:inline-block;font-size:11px;font-weight:650;letter-spacing:.01em;border-radius:999px;padding:2px 9px;margin:0 8px 0 4px}
.pill-fail{background:var(--bad-bg);color:var(--bad);border:1px solid var(--bad-line)}
.pill-pin{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-line)}

.broken{padding:18px 18px 20px;border-bottom:1px solid var(--line)}
.broken:last-child{border-bottom:0}
.broken h4{margin:0 0 10px;font-size:14.5px;font-weight:600}
.broken h4 code{font-size:13.5px}
.broken .tally{color:var(--bad);font-weight:600;font-size:12.5px;margin-left:8px}
.broken-pin .tally{color:var(--warn)}
.broken p{font-size:13.5px;color:var(--muted);margin:0 0 10px}
.broken p b{color:var(--ink);font-weight:620}
.broken .where{font-size:12.5px;color:var(--faint);margin:0}
ul.failed{list-style:none;margin:0 0 14px;padding:0;border-left:2px solid var(--bad-line);}
.broken-pin ul.failed{border-left-color:var(--warn-line)}
ul.failed li{padding:6px 0 6px 12px;font-size:13.5px}
ul.failed .x{color:var(--bad);font-weight:700;margin-right:6px}
.broken-pin ul.failed .x{color:var(--warn)}
ul.failed .diff{display:block;margin-top:4px;font-size:12.5px;color:var(--faint)}
ul.failed .diff .exp,ul.failed .diff .act{display:inline-block;min-width:60px;color:var(--faint)}
ul.failed .diff code{background:var(--code);padding:.1em .35em;border-radius:4px;margin-right:14px}

pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:15px 17px;overflow-x:auto;
  font-size:13px;line-height:1.65;margin:0 0 14px}
pre code{font-size:inherit}
.hash{font-size:12.5px;color:var(--faint)}

table.prov{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}
table.prov th,table.prov td{border-bottom:1px solid var(--line);padding:9px 12px 9px 0;text-align:left;vertical-align:top}
table.prov thead th{color:var(--muted);font-weight:600;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase}
table.prov td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--faint);word-break:break-all}
table.prov td.ver{font-weight:620;font-variant-numeric:tabular-nums;white-space:nowrap}

footer{border-top:1px solid var(--line);margin-top:8px;padding:28px 0 60px;color:var(--faint);font-size:13px}
footer p{margin:0 0 6px}
</style>
</head>
<body>

<header class="top">
  <div class="wrap">
    <p class="eyebrow">evestack ⇄ eve</p>
    <h1>Compatibility</h1>
    <p class="lede">Every published eve release, run through evestack's contract suite. This page is generated
      from committed JSON reports — one per version, each the raw output of a real run. Nothing here is typed by hand.</p>
  </div>
</header>

<div class="wrap">

  <div class="verdict${apiHolds(current) ? "" : " red"}">
    <h2><span class="dot">${apiHolds(current) ? "●" : "▲"}</span> Certified against eve ${esc(current.eveVersion)}${
      current.eveVersion === current.eveLatestTagAtCertification ? " — npm <code>latest</code>" : ""
    }</h2>
    <p>eve published <b>${esc(current.eveVersion)}</b> on ${esc(minute(current.eveReleasedAt))}. evestack certified it${
      currentLag === null ? "" : ` <b>${esc(currentLag)} later</b>`
    } — ${esc(apiContractIds.length)} API contracts, ${esc(currentApi.assertions)} assertions, ${
      currentApi.failed === 0 ? "<b>all green</b>" : `<b>${esc(currentApi.failed)} failing</b>`
    }. templates/default pins <code>${esc(current.evestackPin)}</code>.</p>
  </div>

  <div class="stats">
    <div class="stat"><span class="n">${history.length}</span><span class="l">eve releases tested</span></div>
    <div class="stat"><span class="n">${greenVersions.length}</span><span class="l">hold every API contract</span></div>
    <div class="stat"><span class="n">${apiContractIds.length}</span><span class="l">API contracts</span></div>
    <div class="stat"><span class="n">${current.counts.assertions}</span><span class="l">assertions per run</span></div>
    ${
      busiest === null
        ? ""
        : `<div class="stat"><span class="n">${busiest.count}</span><span class="l">eve releases on ${esc(day(`${busiest.date}T12:00:00Z`))} alone</span></div>`
    }
  </div>

  <section class="prose" id="what-a-contract-is">
    <h2 class="sec">What a contract is</h2>
    <p class="sub">Not a type check. An executable assertion about what eve <em>does</em>.</p>
    <p>evestack is a distribution built on top of eve, so every line of it rests on assumptions about eve's behaviour.
      A contract writes one of those assumptions down as code that runs against the real installed eve package and
      either holds or does not. <code>auth/local-dev-must-not-trust-the-request</code>, for instance, hands eve's
      <code>localDev()</code> a request whose <code>Host</code> header claims to be <code>127.evil.com</code> and asserts
      that no principal comes back.</p>
    <p>There are <b>${esc(contractIds.length)}</b> of them and <b>${esc(current.counts.assertions)}</b> assertions.
      The whole suite runs in well under a second: no mocks, no model calls, no network, no database, no Docker. That is
      what makes it affordable to run against every single eve release rather than the one we happen to ship.</p>

    <h3>Why this page exists</h3>
    <p>eve moves fast — <b>${
      busiest === null ? "several releases a day" : `${esc(busiest.count)} releases went out on ${esc(day(`${busiest.date}T12:00:00Z`))} alone`
    }</b>. The fair criticism of anything built on top of it is that it will quietly rot: a wrapper that compiles
      perfectly against a framework that no longer means what it used to. So the claim evestack makes is not
      "we keep up". It is this table, and the reports behind it, which you can regenerate yourself.</p>
    <p>The history is not decoration either. evestack once shipped a <code>strictLocalDev()</code> wrapper because
      eve 0.29.x decided "is this request from my own machine" from the request's own <code>Host</code> header — so
      <code>127.evil.com</code>, a name anyone can register, was handed a full local-dev principal with no credentials.
      eve 0.30.0 fixed it upstream, and from that moment our wrapper could add no protection and would reject
      legitimate access over a LAN IP or a tunnel. <b>It typechecked perfectly on both days.</b> Nothing about its
      <em>types</em> ever changed — only what eve <em>meant</em>. eve 0.29.5 stays on this page as the control:
      proof that the suite can actually go red.</p>

    <h3>Why one red row is not a break</h3>
    <p>The row marked <em>bookkeeping, not eve</em> asks whether the eve under test satisfies the version ranges
      evestack's own manifests declare <em>today</em>. Every release older than the current pin fails it by
      construction — that is a fact about our <code>package.json</code> files, not about eve. Only the
      <b>${esc(apiContractIds.length)} API contracts</b> above it describe eve itself, and the headline verdict counts
      those alone.</p>
  </section>

  <section id="matrix">
    <h2 class="sec">The matrix</h2>
    <p class="sub">Contracts down, eve versions across, newest first. Every cell is one real run of
      <code>contract/run.mjs</code> against that release's npm tarball.</p>
    <div class="scroller">
      <table class="matrix">
        <thead>
          <tr>
            <th class="corner" scope="col">contract</th>
            ${history.map(versionHeader).join("\n            ")}
          </tr>
        </thead>
        <tbody>
          <tr class="overall">
            <th scope="row" class="ch"><code>API contracts overall</code><span class="ct">all ${esc(apiContractIds.length)} contracts that describe eve</span></th>
            ${history
              .map((entry) => {
                const { failed, assertions, brokenContracts } = apiCounts(entry);
                return failed === 0
                  ? `<td class="s s-pass" title="eve ${esc(entry.eveVersion)}: ${assertions} assertions held"><span aria-hidden="true">✓</span><span class="sr">pass</span><b>${assertions}/${assertions}</b></td>`
                  : `<td class="s s-fail" title="eve ${esc(entry.eveVersion)}: ${brokenContracts} contracts broken"><span aria-hidden="true">✗</span><span class="sr">fail</span><b>${assertions - failed}/${assertions}</b></td>`;
              })
              .join("\n            ")}
          </tr>
          ${apiContractIds.map(contractRow).join("\n          ")}
          ${contractIds.includes(PIN_CONTRACT_ID) ? contractRow(PIN_CONTRACT_ID) : ""}
        </tbody>
      </table>
    </div>
    <p class="legend">
      <span><i class="key pass">✓</i> contract holds</span>
      <span><i class="key fail">✗</i> contract broken — eve changed under us</span>
      <span><i class="key pin">✗</i> version-pin mismatch — not an eve break</span>
      <span><i class="key skip">⊘</i> not run — describes this repo, not this eve</span>
    </p>
  </section>

  <section id="failures">
    <h2 class="sec">What went red, exactly</h2>
    <p class="sub">The failing assertion, what evestack assumed, and what breaks because of it — straight out of the
      recorded reports.</p>
    ${
      // Versions where eve actually changed under us come first; the versions
      // whose only red is "not what we pin today" are filed behind them.
      [...history]
        .sort((a, b) => Number(apiHolds(a)) - Number(apiHolds(b)))
        .map(failureSection)
        .filter(Boolean)
        .join("\n    ") || "<p>Nothing. Every contract holds on every tested release.</p>"
    }
  </section>

  <section id="verify">
    <h2 class="sec">Check it yourself</h2>
    <p class="sub">The point of the page is that you do not have to take its word.</p>
    <pre><code>git clone ${esc(REPO_URL)} &amp;&amp; cd evestack
pnpm install

# the eve we ship, in under a second
node contract/run.mjs

# any published release you like — downloads the tarball, touches no node_modules
node contract/record.mjs --npm=0.29.5 --dry-run

# rebuild this page from the committed reports
node contract/render-compat.mjs</code></pre>
    <p class="hash">Each report in <code>contract/history/</code> records the npm integrity hash of the exact tarball
      that was tested, so a row cannot be quietly re-pointed at a different build.</p>

    <h3>Provenance</h3>
    <table class="prov">
      <thead>
        <tr><th>eve</th><th>published</th><th>certified</th><th>evestack</th><th>tarball integrity</th></tr>
      </thead>
      <tbody>
        ${history
          .map(
            (e) => `<tr>
          <td class="ver">${esc(e.eveVersion)}</td>
          <td>${esc(minute(e.eveReleasedAt))}</td>
          <td>${esc(minute(e.certifiedAt))}</td>
          <td class="mono">${esc(e.evestackCommit ?? "—")}</td>
          <td class="mono">${esc(e.source?.integrity ?? e.source?.spec ?? "—")}</td>
        </tr>`,
          )
          .join("\n        ")}
      </tbody>
    </table>
  </section>

</div>

<footer>
  <div class="wrap">
    <p>Generated by <code>contract/render-compat.mjs</code> from ${esc(history.length)} committed reports in
      <code>contract/history/</code>. Most recent certification ${esc(minute(newestCertification))}.</p>
    <p>Tested range: eve ${esc(oldest.eveVersion)} → ${esc(history[0].eveVersion)} ·
      <a href="${esc(REPO_URL)}/tree/main/contract">contract suite source</a> ·
      <a href="${esc(REPO_URL)}/tree/main/contract/history">raw reports</a></p>
  </div>
</footer>

</body>
</html>
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, page);
process.stdout.write(
  `wrote ${outFile.startsWith(REPO_ROOT) ? outFile.slice(REPO_ROOT.length + 1) : outFile} ` +
    `(${history.length} versions, ${contractIds.length} contracts, ${(page.length / 1024).toFixed(1)} kB)\n`,
);
