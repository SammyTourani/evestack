/**
 * Terminal formatting, kept in the shape the repro scripts already use
 * (contract/runtime/repro/*.mjs) so output pasted from either into an issue
 * comment looks like it came from the same tool. It did.
 */

export function fmt(value) {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
  return String(value);
}

/** Rows as an aligned table. This output is the evidence, so it has to survive
 *  being pasted somewhere with a proportional font and no colour. */
export function table(rows, { indent = "    " } = {}) {
  if (!rows || rows.length === 0) return `${indent}(none)\n`;
  const cols = Object.keys(rows[0]);
  const width = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => fmt(r[c]).length))]),
  );
  // trimEnd because this output is meant to be pasted into an issue comment,
  // and trailing spaces on every row survive that trip as visible noise.
  const line = (cells) =>
    `${`${indent}${cols.map((c, i) => cells[i].padEnd(width[c])).join("  ")}`.trimEnd()}\n`;
  return (
    line(cols) +
    `${indent}${cols.map((c) => "-".repeat(width[c])).join("  ")}\n` +
    rows.map((r) => line(cols.map((c) => fmt(r[c])))).join("")
  );
}

export function section(title) {
  return `\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n`;
}

/** Durations read by a human under pressure: "3h 12m", not "11520000". */
export function duration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "unknown";
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Errors go on one line in a table; the full text is available with --verbose. */
export function firstLine(text, max = 60) {
  if (text === null || text === undefined) return "NULL";
  const line = String(text).split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
