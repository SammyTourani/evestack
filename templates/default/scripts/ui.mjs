/**
 * The one place that decides what evestack looks like in a terminal.
 *
 * THIS FILE EXISTS IN TWO PLACES AND THEY MUST BE BYTE-IDENTICAL:
 *
 *   packages/create-evestack/ui.mjs          <- source of truth, edit here
 *   templates/default/scripts/ui.mjs         <- ships inside every scaffold
 *
 * test/ui-sync.test.mjs fails if they differ. Two copies rather than one import
 * because a scaffolded project does not depend on create-evestack — it is a
 * standalone project whose `scripts/` were copied into it — and a generated
 * project that cannot print its own check results without reaching back into the
 * scaffolder is a generated project that breaks the moment the scaffolder is
 * uninstalled.
 *
 * Before this, the colour table was declared three times (shared.mjs,
 * evestack-cli/src/project.mjs, template/scripts/checks.mjs) and none of the
 * three consulted anything before emitting an escape. So `evestack verify |
 * tee log.txt` wrote raw \x1b[31m into the file, `evestack doctor --json |
 * jq` was fine only because that path happened not to colour, and a redesign
 * meant editing the same constant in three files and hoping.
 *
 * Dependency-free, and it has to stay that way: create.mjs's header explains
 * why (a scaffolder that installs a prompt library before asking its first
 * question is slower than the thing it scaffolds), and this module is imported
 * by `evestack doctor`, which someone runs when a production queue is wedged.
 */
import { stdout } from "node:process";

/* -------------------------------------------------------------------------- */
/* what the terminal can do                                                    */
/* -------------------------------------------------------------------------- */

const env = process.env;

/**
 * Colour, decided once, in the order everyone else decides it.
 *
 * FORCE_COLOR wins so CI can ask for colour on a pipe. NO_COLOR (no-color.org:
 * any value, including empty) wins over the TTY check so `NO_COLOR=` works.
 * Otherwise: only when stdout is really a terminal, which is what stops escapes
 * ending up in a file, a pager, a GitHub issue, or `$(…)`.
 */
export const color = (() => {
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env.NO_COLOR !== undefined) return false;
  if (env.TERM === "dumb") return false;
  return stdout.isTTY === true;
})();

/** 256-colour, for the one blue that matches the site. Falls back to cyan. */
const rich =
  color &&
  (env.COLORTERM === "truecolor" ||
    env.COLORTERM === "24bit" ||
    /256|truecolor|direct/.test(env.TERM ?? ""));

/**
 * Block and box-drawing glyphs, or ASCII.
 *
 * evestack already shipped `▚`, `✓` and `─` before this file existed, so the
 * bar is "no worse than today" rather than "safe everywhere". The opt-out is
 * explicit because the failure mode — mojibake in a legacy Windows code page —
 * is one nobody here can reproduce.
 */
export const unicode = !(
  env.EVESTACK_ASCII !== undefined ||
  (process.platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM)
);

/** Terminal width, clamped to something a paragraph can be read at. */
export function width() {
  return Math.min(Math.max(stdout.columns || 80, 52), 88);
}

/* -------------------------------------------------------------------------- */
/* colour                                                                      */
/* -------------------------------------------------------------------------- */

const code = (n) => (color ? `\x1b[${n}m` : "");

/**
 * The raw table, in the shape the three deleted copies had, so that ~100
 * existing call sites in attach.mjs and create.mjs keep working unchanged —
 * and every one of them becomes NO_COLOR-correct for free. New code should
 * prefer the `c.*` functions below, which cannot leak an unclosed escape.
 */
export const C = {
  reset: code(0),
  bold: code(1),
  dim: code(2),
  red: code(31),
  green: code(32),
  yellow: code(33),
  cyan: code(36),
  // #0087ff — the closest 256-colour match to the site's --ds-blue-700 (#006bff)
  // and the favicon's #3b82f6. Cyan is the fallback, and was the old brand.
  blue: rich ? code("38;5;33") : code(36),
  blueDim: rich ? code("38;5;25") : code(36),
};

const wrap = (...opens) => {
  const open = opens.join("");
  return (s) => (color ? `${open}${s}${C.reset}` : String(s));
};

/**
 * The combined weights are their own functions rather than `c.red(c.bold(x))`.
 *
 * Nesting two of these emits two resets, and the INNER one lands in the middle
 * of the outer span — so `c.red(\`\${c.bold("4 down.")} run this\`)` prints the
 * count bold-red and then silently drops the rest back to plain. It is invisible
 * in the common case where the bold part is last, which is exactly what makes it
 * a bug that ships.
 */
export const c = {
  bold: wrap(C.bold),
  dim: wrap(C.dim),
  red: wrap(C.red),
  green: wrap(C.green),
  yellow: wrap(C.yellow),
  /** The brand blue. Use this, not cyan, for anything that means "evestack". */
  brand: wrap(C.blue),
  brandDim: wrap(C.blueDim),
  redBold: wrap(C.red, C.bold),
  greenBold: wrap(C.green, C.bold),
  yellowBold: wrap(C.yellow, C.bold),
  brandBold: wrap(C.blue, C.bold),
  plain: (s) => String(s),
};

/**
 * A path as the reader thinks of it: `~/code/my-agent`, and never wider than
 * the terminal. An absolute path under a scratch directory is easily 90
 * characters, which wrapped the header of every command that prints one.
 */
/**
 * A URL as a person should read it.
 *
 * The config records `127.0.0.1` because that is what actually binds, and every
 * probe uses it. But a URL on screen is there to be clicked or pasted, and
 * create.mjs already stated the rule — "localhost, not 127.0.0.1, because this
 * one is for a human". It was stated in one place and followed in one place: a
 * live run printed `localhost` from `create`, `verify` and `open`, and
 * `127.0.0.1` from `status` and the tour's last screen, for the same dashboard.
 */
export function forHumans(url) {
  return String(url).replace("127.0.0.1", "localhost");
}

export function shortPath(path, max = 46) {
  const home = process.env.HOME || process.env.USERPROFILE;
  let text = String(path);
  if (home && text.startsWith(home)) text = `~${text.slice(home.length)}`;
  if (text.length <= max) return text;
  // Keep the tail: the last two segments are what identifies the project.
  const parts = text.split(/[\\/]/);
  let tail = parts.pop() ?? "";
  while (parts.length > 0 && tail.length + (parts.at(-1)?.length ?? 0) + 1 < max - 2) {
    tail = `${parts.pop()}/${tail}`;
  }
  return `${G.ellip}/${tail}`;
}

/* -------------------------------------------------------------------------- */
/* glyphs                                                                      */
/* -------------------------------------------------------------------------- */

const G = unicode
  ? { mark: "▚", ok: "✓", fail: "✗", warn: "!", skip: "·", dot: "●", branch: "└", arrow: "→",
      bar: "─", down: "▼", up: "▲", pipe: "│", block: "█", tl: "┌", tr: "┐", bl: "└", br: "┘",
      ellip: "…" }
  : { mark: "#", ok: "+", fail: "x", warn: "!", skip: "-", dot: "*", branch: "\\", arrow: "->",
      bar: "-", down: "v", up: "^", pipe: "|", block: "#", tl: "+", tr: "+", bl: "+", br: "+",
      ellip: "..." };

/** Pre-coloured status glyphs — the four states everything reports in. */
export const g = {
  ...G,
  MARK: c.brand(G.mark),
  OK: c.green(G.ok),
  FAIL: c.red(G.fail),
  WARN: c.yellow(G.warn),
  SKIP: c.dim(G.skip),
  ASK: c.bold("?"),
};

/* -------------------------------------------------------------------------- */
/* measuring                                                                   */
/* -------------------------------------------------------------------------- */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Printable width, ignoring escape sequences.
 *
 * Every `padEnd` in the old renderers measured the coloured string, so a table
 * cell was correct only while it stayed uncoloured. That held by accident —
 * format.mjs coloured nothing — and would have broken the first time anyone
 * made a failing cell red, which is exactly what this redesign does.
 *
 * Not grapheme-aware: an emoji still counts as its code units. Nothing here
 * prints emoji, and pulling in a segmenter for that would cost the dependency
 * this file is not allowed to have.
 */
export function visible(s) {
  return String(s).replace(ANSI, "").length;
}

export function pad(s, n) {
  return `${s}${" ".repeat(Math.max(0, n - visible(s)))}`;
}

/** `left` and `right`, with `right` flush to `w`. Never pads a bare left. */
export function spread(left, right, w = width() - 2) {
  if (!right) return left;
  const gap = w - visible(left) - visible(right);
  return gap < 1 ? `${left}  ${right}` : `${left}${" ".repeat(gap)}${right}`;
}

/** Shorten to `max` printable characters. Only safe on uncoloured text. */
export function truncate(s, max) {
  const text = String(s);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}${G.ellip}`;
}

/* -------------------------------------------------------------------------- */
/* printing                                                                    */
/* -------------------------------------------------------------------------- */

export const say = (s = "") => stdout.write(`${s}\n`);
export const blank = () => stdout.write("\n");

/**
 * Every layout primitive comes in two forms: `xLine(...)` returns the string and
 * `x(...)` prints it.
 *
 * The printing form is what almost every call site wants. The string form is
 * what makes a command testable and its output redirectable: `status` takes a
 * `stdout` to write to, and before this split it honoured that only on the
 * `--json` path while the human path went straight to `process.stdout` — so the
 * parameter was a lie for the case that mattered, and a test asserting on the
 * report was asserting on an empty sink.
 */
export function headingLine(title, subtitle = "") {
  return `  ${g.MARK} ${c.bold(title)}${subtitle ? `   ${c.dim(subtitle)}` : ""}`;
}

/**
 * The header every command opens with: the mark, what this is, and where.
 *
 *   ▚ verify   my-agent
 */
export function heading(title, subtitle = "") {
  say(headingLine(title, subtitle));
}

/**
 * The two-line wordmark — the favicon, which is two rounded squares offset on
 * the diagonal, at the only resolution a terminal has. `big` is the 2x version,
 * printed once by `create` and nowhere else.
 */
export function wordmark({ big = false, tagline = "the whole eve stack, on your own machine" } = {}) {
  const solid = c.brand(G.block.repeat(big ? 4 : 2));
  const ghost = c.brandDim(G.block.repeat(big ? 4 : 2));
  blank();
  if (big) {
    say(`    ${solid}`);
    say(`    ${solid}        ${c.bold("evestack")}`);
    say(`        ${ghost}    ${c.dim(tagline)}`);
    say(`        ${ghost}`);
  } else {
    say(`    ${solid}      ${c.bold("evestack")}`);
    say(`      ${ghost}    ${c.dim(tagline)}`);
  }
  blank();
}

/** A labelled horizontal rule: `queue ─────────`. Unlabelled for a plain one. */
export function ruleLine(label = "", indent = 2) {
  const head = label ? `${label} ` : "";
  const len = Math.max(0, width() - indent - head.length);
  return `${" ".repeat(indent)}${c.dim(`${head}${G.bar.repeat(len)}`)}`;
}

export function rule(label = "", indent = 2) {
  say(ruleLine(label, indent));
}

/**
 * The status row every command reports in. One line, one fact.
 *
 *   ✓ postgres     accepting connections on :5433              6.1s
 */
export function rowLine(glyph, label, detail = "", right = "", { indent = 2, labelWidth = 12 } = {}) {
  return `${" ".repeat(indent)}${spread(`${glyph} ${pad(label, labelWidth)}${detail}`, right)}`;
}

export function row(glyph, label, detail = "", right = "", options = {}) {
  say(rowLine(glyph, label, detail, right, options));
}

/**
 * The fix line under a red row.
 *
 * Indented under the detail it belongs to, and bold, because it is the only
 * thing on the screen the reader is meant to type. This pairing — never a
 * failure without the command that ends it — is the rule the whole CLI already
 * followed; this just gives it one shape.
 */
export function fixLine(command, { indent = 4, note = "" } = {}) {
  return `${" ".repeat(indent)}${c.dim(G.branch)} ${c.bold(command)}${note ? `  ${c.dim(note)}` : ""}`;
}

export function fix(command, options = {}) {
  say(fixLine(command, options));
}

/** A framed block. `lines` are pre-coloured; the frame measures around them. */
export function box(lines, { indent = 4, inner = 0 } = {}) {
  const w = inner || Math.max(...lines.map(visible)) + 2;
  const pre = " ".repeat(indent);
  say(`${pre}${c.dim(`${G.tl}${G.bar.repeat(w + 1)}${G.tr}`)}`);
  for (const l of lines) say(`${pre}${c.dim(G.pipe)} ${pad(l, w)}${c.dim(G.pipe)}`);
  say(`${pre}${c.dim(`${G.bl}${G.bar.repeat(w + 1)}${G.br}`)}`);
}

/* -------------------------------------------------------------------------- */
/* long-running work                                                           */
/* -------------------------------------------------------------------------- */

const FRAMES = unicode ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];
const CLEAR = "\x1b[2K\r";

/**
 * Cursor restoration, and the reason it is wired up lazily.
 *
 * This module registered `process.on("SIGINT", … process.exit(130))` at import
 * time. importing a FORMATTING module therefore changed the process's signal
 * disposition — and `templates/default/scripts/dev.mjs` imports it transitively,
 * through checks.mjs, to get the colour table.
 *
 * Measured, not theorised: with both handlers attached, ours ran first (import
 * order), called `process.exit()` synchronously, and dev.mjs's forwarder — the
 * one whose entire job is `child.kill(signal)` — never ran at all. Ctrl-C on
 * `npm run dev` killed the wrapper and left `eve dev` orphaned on the port. The
 * repo already has an hour of debugging recorded against a stale server holding
 * a port and quietly serving an old build; this would have manufactured that on
 * every Ctrl-C.
 *
 * So: nothing is registered until a spinner actually hides the cursor, and the
 * handler never exits the process. It restores the cursor, detaches, and then
 * either re-raises the signal (if it was the only listener, because a listener
 * suppresses Node's default termination) or gets out of the way of whoever else
 * is listening. Node copies the listener array before dispatch, so detaching
 * mid-dispatch does not stop the handlers that were already going to run.
 */
const SIGNALS = ["SIGINT", "SIGTERM"];
let cursorHidden = false;
let guard = null;

function hideCursor() {
  if (cursorHidden || !color || !stdout.isTTY) return;
  stdout.write("\x1b[?25l");
  cursorHidden = true;
  if (guard) return;
  guard = (signal) => {
    showCursor();
    // Our own listener is gone by now. If nobody else was listening, Node's
    // default terminate was suppressed only by us — put it back.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  process.on("exit", showCursor);
  for (const signal of SIGNALS) process.on(signal, guard);
}

export function showCursor() {
  if (!cursorHidden) return;
  stdout.write("\x1b[?25h");
  cursorHidden = false;
  if (!guard) return;
  process.removeListener("exit", showCursor);
  for (const signal of SIGNALS) process.removeListener(signal, guard);
  guard = null;
}

/**
 * One line that updates in place while something slow happens, and resolves
 * into a normal status row.
 *
 * `create` used to print "▚ Starting Postgres" and then hand stdio to Docker
 * for a ~200 MB pull, which its own comment describes as "a long silence
 * followed by a wall of layer hashes" — the reader cannot tell a slow pull from
 * a hang. This gives every slow step a heartbeat and an elapsed clock.
 *
 * Off a TTY it degrades to one line at the start and one at the end, because
 * carriage returns in a CI log produce a single unreadable line.
 */
export function task(label, detail = "", { labelWidth = 12, indent = 2 } = {}) {
  const started = Date.now();
  const live = color && stdout.isTTY;
  let frame = 0;
  let note = detail;
  let timer = null;

  const elapsed = () => {
    const s = Math.round((Date.now() - started) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  const paint = () => {
    const spin = c.brand(FRAMES[frame++ % FRAMES.length]);
    const left = `${" ".repeat(indent)}${spin} ${pad(label, labelWidth)}${c.dim(note)}`;
    stdout.write(`${CLEAR}${spread(left, c.dim(elapsed()))}`);
  };

  if (live) {
    hideCursor();
    paint();
    timer = setInterval(paint, 90);
    timer.unref?.();
  } else {
    // Off a TTY this is the only heartbeat there is, and some CI runners kill a
    // job that prints nothing for long enough — so the start line stays. It is
    // marked with an ellipsis rather than a status glyph, because `· install`
    // followed by `✓ install` reads as the same row printed twice.
    say(`${" ".repeat(indent)}${c.dim(G.ellip)} ${pad(label, labelWidth)}${c.dim(note || "working")}`);
  }

  const settle = (glyph, text, { time = true } = {}) => {
    if (timer) clearInterval(timer);
    if (live) {
      stdout.write(CLEAR);
      showCursor();
    }
    row(glyph, label, text, time ? c.dim(elapsed()) : "", { indent, labelWidth });
  };

  return {
    /** Change the trailing detail without settling the line. */
    update(text) {
      note = text;
      if (live) paint();
    },
    done: (text = note) => settle(g.OK, text),
    warn: (text = note) => settle(g.WARN, text),
    fail: (text = note) => settle(g.FAIL, text, { time: false }),
    /** Give the terminal back mid-task, for a child process that must inherit it. */
    release() {
      if (timer) clearInterval(timer);
      if (live) {
        stdout.write(CLEAR);
        showCursor();
      }
    },
  };
}
