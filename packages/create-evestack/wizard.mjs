/**
 * The terminal wizard: steps you can walk back through, and lists you can
 * search.
 *
 * This replaces `select.mjs`, which could ask one question with a fixed list of
 * about ten options. That was enough for "which provider" and nothing else. The
 * moment the wizard had to offer the 26 channels and 70-odd integrations eve's
 * registry actually carries, three things became load-bearing at once: a filter,
 * because nobody scrolls 26 rows to find Telegram; a viewport, because the list
 * is taller than the terminal; and multi-select, because "where should people
 * reach your agent" is not a single answer.
 *
 * And once a question can be answered wrongly, the wizard needs a way back.
 * Four questions with no `←` is an interview; four questions you can revise is
 * a form. That is what `runSteps` is for.
 *
 * Still dependency-free, and it has to stay that way — create.mjs's header
 * explains why. Everything here is `node:readline` keypress events and a
 * handful of escape sequences.
 *
 * ── the redraw contract ─────────────────────────────────────────────────────
 *
 * Every screen is "move the cursor up by exactly what was printed last time,
 * clear to the end of the screen, print again". Never a full clear: the steps
 * already answered stay in the scrollback, which is how someone checks what
 * they said without leaving the wizard.
 */
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";

import { c, chip, color, g, pad, plain, say, unicode, visible, width } from "./ui.mjs";

/** Rows that render but cannot be landed on. */
const isHeading = (item) => item?.heading !== undefined;

/**
 * The four marks a row can carry, exported so a test can prove they are four
 * DIFFERENT characters in both glyph sets.
 *
 * They were not. In the ASCII fallback the empty checkbox was `-`, and `g.sep`
 * is also `-` without unicode, so one row rendered
 * `> - Web Chat   - Add the built-in …` with the same character as the empty
 * box, the description separator and the step separator. That is the path
 * Windows takes without Windows Terminal.
 */
export const MARKS = {
  cursor: unicode ? "›" : ">",
  gutter: unicode ? "▎" : ">",
  empty: unicode ? "○" : "o",
  caret: unicode ? "▏" : "_",
};

/** Thrown by a step that wants the wizard to go back one. */
export const BACK = Symbol("wizard.back");
/** Thrown when the reader presses Esc. */
export const CANCEL = Symbol("wizard.cancel");

/* -------------------------------------------------------------------------- */
/* the step header                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `✓ Model · Channels (3) → Integrations · Review`
 *
 * The single most useful line on the screen, and the one the old wizard did not
 * have. "step 2 of 4" says how much is left; this says what the remaining steps
 * ARE, which is the difference between waiting and deciding. A count on a step
 * you have already answered (`Channels (3)`) is what makes going back feel
 * possible rather than destructive.
 */
export function stepHeaderLine(steps, current) {
  const parts = steps.map((step, index) => {
    const count = step.count ? ` ${c.dim(`(${step.count})`)}` : "";
    if (index === current) return `${chip(` ${step.title} `)}${count}`;
    if (index < current) return `${c.green(g.ok)} ${c.dim(step.title)}${count}`;
    return `${c.dim(step.title)}${count}`;
  });
  // One arrow, and it sits AFTER the current step, pointing at where `→` will
  // take you. An earlier version put one on both sides of the current step,
  // which read as two directions of travel from a header whose job is to show
  // one.
  const joined = parts.map((part, index) => {
    if (index === 0) return part;
    return `${index === current + 1 ? c.dim(g.arrow) : c.dim(g.sep)}  ${part}`;
  });
  return `  ${joined.join("  ")}`;
}

/* -------------------------------------------------------------------------- */
/* raw input, borrowed and returned                                            */
/* -------------------------------------------------------------------------- */

/**
 * Run `render`/`onKey` with stdin in raw mode, and give it back exactly as it
 * was found.
 *
 * `borrowStdin` comes from makePrompter and is what stops this from breaking
 * the NEXT readline prompt — the failure was a wizard that ran one list fine
 * and then hung forever on the following question, with no error. See
 * makePrompter for the full story.
 */
async function withKeys({ borrowStdin, render, onKey }) {
  const lend = borrowStdin ?? ((run) => run());
  return lend(async () => {
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    // NOT resumed here. `emitKeypressEvents` installs a `data` listener that
    // turns bytes into `keypress` events, and an event with no listener is
    // dropped on the floor — so resuming before the handler is attached loses
    // every keystroke already sitting in the buffer. That is type-ahead: the
    // wizard prints a list, you type the first letters while it is still
    // drawing, and the filter stays empty. Resume happens once the handler is
    // on, at the bottom of the Promise below.
    stdout.write("\x1b[?25l");
    let printed = 0;
    const draw = () => {
      if (printed > 0) stdout.write(`\x1b[${printed}A\x1b[0J`);
      const lines = render();
      stdout.write(`${lines.join("\n")}\n`);
      printed = lines.length;
    };
    draw();
    try {
      return await new Promise((resolve) => {
        const handler = (str, key) => {
          // Raw mode means the terminal no longer turns Ctrl-C into SIGINT, so
          // without this the wizard cannot be quit from its own first question.
          if (key?.ctrl && (key.name === "c" || key.name === "d")) {
            stdin.off("keypress", handler);
            stdout.write("\n\x1b[?25h");
            process.exit(130);
          }
          const outcome = onKey(str, key);
          if (outcome === undefined) return draw();
          stdin.off("keypress", handler);
          resolve(outcome);
        };
        stdin.on("keypress", handler);
        stdin.resume();
      });
    } finally {
      // Erase the interactive frame and let the caller print the settled one.
      if (printed > 0) stdout.write(`\x1b[${printed}A\x1b[0J`);
      stdout.write("\x1b[?25h");
    }
  });
}

/* -------------------------------------------------------------------------- */
/* filtering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Case-insensitive substring over the label AND the description.
 *
 * Both, because half of what someone types is the thing rather than the brand:
 * "sms" should find Twilio, "issues" should find GitHub, "memory" should find
 * all four memory extensions. Matching the label alone makes the filter feel
 * broken on exactly the searches a newcomer types.
 */
function matches(item, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return `${item.label} ${item.note ?? ""} ${item.value ?? ""}`.toLowerCase().includes(needle);
}

/** The matched run, in brand colour, inside an otherwise normal label. */
function highlight(text, query, base) {
  if (!query) return base(text);
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return base(text);
  return `${base(text.slice(0, at))}${c.brandBold(text.slice(at, at + query.length))}${base(text.slice(at + query.length))}`;
}

/* -------------------------------------------------------------------------- */
/* the list                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row. `selected` is only meaningful for a multi-select.
 *
 * The note is truncated to the terminal rather than wrapped. A wrapped
 * description turns a scannable column of options into a paragraph, and the
 * whole reason the list has descriptions is that they are scannable.
 */
function rowLine(item, { active, selected, query, labelWidth, badgeWidth, multi }) {
  // ONE gutter, not two. A multi-select had a `›` column and a `✓` column, so
  // the pointer sat two characters away from the checkbox and four from the
  // name, and "which row am I on" had to be read rather than seen. A filled
  // bar in the gutter is a single mark the eye tracks down the list.
  const bar = active ? c.brand(MARKS.gutter) : " ";
  // `○` and not `·` for an empty checkbox. The middle dot was already the
  // separator before every description on the same line, so the row read as
  // "· Slack … · Slack with Vercel Connect" — one glyph doing two unrelated
  // jobs, three columns apart. A hollow ring is unmistakably a box waiting to
  // be ticked, and it pairs with the ✓ that replaces it.
  //
  // `o` and NOT `-` in the ASCII fallback, for exactly the same reason and it
  // was worse there. `g.sep` is `-` without unicode, so a row rendered
  // `> - Web Chat  - Add the built-in …` — one character doing THREE jobs
  // (empty box, description separator, step separator) on one line. That is the
  // path Windows takes without Windows Terminal, so it is the path least likely
  // to be looked at and the one that most needed looking at.
  const mark = multi
    ? selected
      ? c.green(g.ok)
      : c.dim(MARKS.empty)
    : active
      ? c.brandBold(MARKS.cursor)
      : " ";
  const pointer = bar;
  const base = active ? c.brandBold : selected ? c.bold : c.bold;
  const label = highlight(item.label, query, base);
  // Its own column, padded even when empty. Inline, the badge shunted every
  // description right by its own width, so the notes only lined up on rows that
  // happened to need the same credential — which is the one column a reader
  // scans straight down.
  const badge = pad(item.badge ? item.badgeColor(item.badge) : "", badgeWidth);
  const head = `   ${pointer} ${mark} ${pad(label, labelWidth)} ${badge}`;
  if (!item.note) return head;
  const room = width() - visible(head) - 3;
  if (room < 12) return head;
  const note = plain(item.note).length > room ? `${plain(item.note).slice(0, room - 1)}${g.ellip}` : item.note;
  return `${head}  ${c.dim(g.sep)} ${c.dim(note)}`;
}

/** How many option rows fit without pushing the header off the screen. */
const VIEWPORT = 8;

/**
 * The scrolling window over the filtered list.
 *
 * Keeps the cursor off the very edge where possible, so there is always a row
 * of context in the direction of travel — the difference between scrolling and
 * falling off.
 */
function windowFor(index, total, size = VIEWPORT) {
  if (total <= size) return { from: 0, to: total };
  const half = Math.floor(size / 2);
  let from = Math.max(0, Math.min(index - half, total - size));
  return { from, to: from + size };
}

/**
 * Ask one question against a list.
 *
 * `multi: true` turns it into a checklist: space toggles, enter accepts the
 * whole set, and the count is live under the list. `multi: false` selects on
 * enter and returns one value.
 *
 * Returns `{ value }` / `{ values }`, or `BACK` / `CANCEL` when the reader
 * navigates out of it. Every caller has to handle those two — that is what
 * makes the step framework above possible.
 */
export async function ask(
  {
    question,
    hint = "",
    items,
    multi = false,
    selected = new Set(),
    initial = 0,
    borrowStdin,
    canBack = true,
    canForward = true,
    nonInteractive = false,
    fallbackAsk,
    emptyNote = "Nothing matches that.",
  },
) {
  const options = items.filter((i) => !isHeading(i));
  if (options.length === 0) return multi ? { values: [] } : { value: undefined };

  if (nonInteractive || !stdin.isTTY || !stdout.isTTY || !color) {
    return askWithoutATerminal({ question, items, options, multi, selected, initial, fallbackAsk });
  }

  let query = "";
  let cursor = 0;
  const chosen = new Set(selected);

  const view = () => items.filter((i) => isHeading(i) || matches(i, query));
  const visibleOptions = () => view().filter((i) => !isHeading(i));

  cursor = Math.min(initial, Math.max(0, visibleOptions().length - 1));

  const render = () => {
    const shown = view();
    const opts = shown.filter((i) => !isHeading(i));
    const labelWidth = Math.min(
      Math.max(...opts.map((o) => visible(o.label)), 0),
      Math.floor(width() * 0.34),
    );
    // Measured across the WHOLE list, not the filtered view, so the notes do not
    // shift left and right as someone types.
    const badgeWidth = Math.max(...options.map((o) => visible(o.badge ?? "")), 0);
    const lines = [""];
    // The question is the only bright thing above the list. Before this the
    // question, the hint, the rows and the counts were all within one weight of
    // each other, so the screen had no entry point — the eye landed wherever it
    // happened to land.
    lines.push(`  ${c.brandBold(question)}`);
    if (hint) lines.push(`  ${c.dim(hint)}`);
    lines.push("");

    // The search box is always present, even before anything is typed, because
    // a filter you have to discover is a filter nobody uses.
    //
    // It also has to LOOK like an input. Dim glyph plus dim placeholder read as
    // leftover output — something the wizard had printed rather than something
    // waiting for you. The glyph carries the brand colour and the typed text is
    // bright, so the line is the one place on screen that looks live.
    const caret = c.brandBold(MARKS.caret);
    const typed = query ? c.bold(query) : c.dim(multi ? "Type to filter" : "Type to filter, or pick below");
    lines.push(`   ${c.brand(unicode ? "⌕" : ">")} ${typed}${caret}`);

    if (opts.length === 0) {
      lines.push("");
      lines.push(`     ${c.dim(emptyNote)}`);
    } else {
      const cursorIndexInShown = shown.indexOf(opts[cursor]);
      const { from, to } = windowFor(cursorIndexInShown, shown.length);
      for (const item of shown.slice(from, to)) {
        if (isHeading(item)) {
          lines.push(item.heading === "" ? "" : `    ${c.dim(item.heading)}`);
          continue;
        }
        lines.push(
          rowLine(item, {
            active: item === opts[cursor],
            selected: chosen.has(item.value),
            query,
            labelWidth,
            badgeWidth,
            multi,
          }),
        );
      }
    }

    lines.push("");
    const counts = [];
    if (multi) {
      // The COUNT is not the answer. Tick three things, type four letters, and
      // every one of them leaves the viewport — the screen then says "3
      // selected" and shows none of them, which is the moment someone starts
      // over because they cannot remember what they already had. Naming them
      // costs one line and makes the filter safe to use.
      if (chosen.size === 0) counts.push(c.dim("none selected"));
      else {
        const names = options.filter((o) => chosen.has(o.value)).map((o) => o.label);
        // How many names fit depends on the terminal, not on a constant. Three
        // long ones overflow 80 columns and wrap, which undoes the reason for
        // printing them.
        const room = Math.max(0, width() - 34);
        let shown = [];
        for (const name of names) {
          if (shown.concat(name).join(", ").length > room) break;
          shown.push(name);
        }
        const rest = names.length > shown.length ? c.dim(` +${names.length - shown.length} more`) : "";
        counts.push(
          `${c.green(`${chosen.size} selected`)}${shown.length ? ` ${c.dim(shown.join(", "))}` : ""}${rest}`,
        );
      }
    }
    if (opts.length < options.length) counts.push(c.dim(`${opts.length} of ${options.length} match "${query}"`));
    else if (opts.length > VIEWPORT) {
      const cursorIndexInShown = view().indexOf(opts[cursor]);
      const { from, to } = windowFor(cursorIndexInShown, view().length);
      counts.push(c.dim(`${unicode ? "↑↓" : "^v"} ${opts.length} options, showing ${from + 1}–${Math.min(to, view().length)}`));
    }
    if (counts.length) lines.push(`  ${counts.join(`  ${c.dim(g.sep)}  `)}`);

    lines.push("");
    lines.push(`  ${c.dim(keyHint({ multi, canBack, canForward, query }))}`);
    return lines;
  };

  const onKey = (str, key) => {
    const opts = visibleOptions();
    const name = key?.name;
    if (name === "escape") return { kind: CANCEL };
    if (name === "up") { cursor = (cursor - 1 + opts.length) % Math.max(opts.length, 1); return; }
    if (name === "down") { cursor = (cursor + 1) % Math.max(opts.length, 1); return; }
    if (name === "pageup") { cursor = Math.max(0, cursor - VIEWPORT); return; }
    if (name === "pagedown") { cursor = Math.min(opts.length - 1, cursor + VIEWPORT); return; }
    if (name === "backspace") { query = query.slice(0, -1); cursor = 0; return; }
    if (name === "left" && canBack && query === "") return { kind: BACK };
    if (name === "right" && canForward) {
      if (!multi && !opts[cursor]) return;
      return finish();
    }
    if (name === "return") {
      // A filter that matches nothing has no answer to give. Enter here used to
      // fall through to `finish()` and hand back `{ value: undefined }`, which
      // the caller then read `.kind` off — a crash on the most ordinary mistake
      // in a search box, typing one letter too many.
      if (!multi && !opts[cursor]) return;
      if (!multi) return { value: opts[cursor].value };
      return finish();
    }
    if (name === "space" && multi && opts[cursor]) {
      toggle(opts[cursor]);
      return;
    }
    if (name === "tab" && multi && opts[cursor]) { toggle(opts[cursor]); return; }
    // Anything printable goes to the filter. Space is excluded above for a
    // multi-select because toggling is what the thumb reaches for there; in a
    // single-select it is a normal character.
    if (str && str.length === 1 && str >= " " && str !== "\x7f") {
      if (multi && str === " ") return;
      query += str;
      cursor = 0;
      return;
    }
    return undefined;
  };

  const toggle = (item) => {
    if (chosen.has(item.value)) chosen.delete(item.value);
    else chosen.add(item.value);
  };

  const finish = () => (multi ? { values: [...chosen] } : { value: visibleOptions()[cursor]?.value });

  const outcome = await withKeys({ borrowStdin, render, onKey });

  // The settled frame: what was chosen, without the controls. This is what the
  // reader scrolls back to, so it has to read as an answer rather than a widget.
  if (outcome?.kind === CANCEL) return { cancelled: true };
  if (outcome?.kind === BACK) return { back: true };
  if (multi) {
    const picked = options.filter((o) => chosen.has(o.value));
    say(`  ${c.bold(question)}`);
    if (picked.length === 0) say(`    ${c.dim("none")}`);
    for (const item of picked) say(`    ${c.green(g.ok)} ${c.bold(item.label)}`);
    say();
    return { values: outcome.values };
  }
  const picked = options.find((o) => o.value === outcome.value);
  say(`  ${c.bold(question)}`);
  say(
    `    ${c.brandBold(unicode ? "›" : ">")} ${c.bold(picked?.label ?? "—")}` +
      `${picked?.badge ? `  ${picked.badgeColor(picked.badge)}` : ""}` +
      `${picked?.note ? `  ${c.dim(picked.note)}` : ""}`,
  );
  say();
  return { value: outcome.value };
}

/**
 * The key hints, trimmed to fit the terminal.
 *
 * Measured at 80 columns: the full line is 91 wide and wrapped mid-word —
 * `… → next · es` / `c cancel`. A hint that breaks across two lines is worse
 * than a shorter hint, because the thing it damages is the reader's sense that
 * the screen was laid out on purpose.
 *
 * So the parts are ordered by how much they are needed and dropped from the
 * least needed end until the line fits. Filtering goes first: the search box is
 * already on screen with a caret in it and says "Type to filter" in words.
 * Moving and choosing never go, because a list you cannot move in or choose from
 * is not a list.
 */
function keyHint({ multi, canBack, canForward, query, columns = width() }) {
  // Reading order and drop order are two different things, and conflating them
  // is how a trimmed line came out as `esc cancel · → next · ↑↓ move`. The list
  // below is the order they READ in; `drop` is the order they LEAVE in, lowest
  // first. `keep: true` is the floor — a list you cannot move in or choose from
  // is not a list, whatever the width.
  const parts = [
    { text: "type to filter", drop: 1 },
    { text: `${unicode ? "↑↓" : "up/down"} move`, keep: true },
    { text: multi ? "space toggle" : "enter select", keep: true },
    ...(multi ? [{ text: "enter accept", keep: true }] : []),
    ...(canForward ? [{ text: `${unicode ? "→" : "->"} next`, drop: 4 }] : []),
    // The left arrow types into the filter once there is a filter, so the hint
    // has to stop promising it. A key that silently changes meaning is worse
    // than one that was never offered.
    ...(canBack && query === "" ? [{ text: `${unicode ? "←" : "<-"} back`, drop: 2 }] : []),
    { text: "esc cancel", drop: 3 },
  ];

  const join = (kept) => `      ${c.dim(kept.map((p) => p.text).join(`  ${g.sep}  `))}`;
  let kept = parts;
  // Measured at 80 columns: the full line is 91 wide and wrapped mid-word —
  // `… → next · es` / `c cancel`. A hint that breaks across two lines is worse
  // than a shorter hint, because what it damages is the reader's sense that the
  // screen was laid out on purpose.
  while (visible(join(kept)) > columns) {
    const droppable = kept.filter((p) => !p.keep);
    if (droppable.length === 0) break;
    const next = droppable.reduce((a, b) => (a.drop <= b.drop ? a : b));
    kept = kept.filter((p) => p !== next);
  }
  return join(kept);
}


/**
 * The same question where there is no terminal: `--yes`, CI, a heredoc, a pipe.
 *
 * Prints the list once and reads a number (or a comma-separated set). This path
 * is not a courtesy — it is how the wizard is tested without a pty, and how
 * anyone scripts it.
 */
async function askWithoutATerminal({ question, items, options, multi, selected, initial, fallbackAsk }) {
  const labelWidth = Math.max(...options.map((o) => visible(o.label)), 0);
  for (const item of items) {
    if (isHeading(item)) {
      say(item.heading === "" ? "" : `    ${c.dim(item.heading)}`);
      continue;
    }
    const n = options.indexOf(item) + 1;
    const tick = selected.has(item.value) ? c.green(g.ok) : " ";
    say(`      ${c.bold(String(n))} ${tick} ${pad(item.label, labelWidth)}  ${c.dim(item.note ?? "")}`.trimEnd());
  }
  say();
  if (!fallbackAsk) {
    return multi ? { values: [...selected] } : { value: options[initial]?.value };
  }
  const prompt = multi
    ? `${question} ${c.dim(`(numbers, comma-separated, or blank for none)`)}`
    : `${question} ${c.dim(`(1-${options.length})`)}`;
  const answer = (await fallbackAsk(prompt, "")).trim();
  if (!multi) {
    const picked = options[Number(answer) - 1];
    return { value: (picked ?? options[initial])?.value };
  }
  const values = answer
    .split(",")
    .map((part) => options[Number(part.trim()) - 1])
    .filter(Boolean)
    .map((o) => o.value);
  return { values: answer === "" ? [...selected] : values };
}

/* -------------------------------------------------------------------------- */
/* steps                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Walk a list of steps, honouring `←` and Esc.
 *
 * Each step is `{ title, run(ctx) }` and returns nothing, `BACK`, or throws
 * CANCEL. State lives in `ctx`, which every step sees — so going back and
 * changing an answer changes what later steps are asked about, which is the
 * entire point of having a back key.
 *
 * The header is printed by the runner rather than by each step, so a step
 * cannot forget it and the counts stay in one place.
 */
export async function runSteps(steps, ctx) {
  let index = 0;
  while (index < steps.length) {
    const step = steps[index];
    say();
    say(stepHeaderLine(steps, index));
    say();
    const outcome = await step.run(ctx, { first: index === 0, last: index === steps.length - 1 });
    if (outcome === CANCEL) return CANCEL;
    if (outcome === BACK) {
      index = Math.max(0, index - 1);
      continue;
    }
    index += 1;
  }
  return ctx;
}

/** A selectable row. */
export function option(label, value, { badge = "", badgeColor = c.dim, note = "" } = {}) {
  return { label, value, badge, badgeColor, note };
}

/** A non-selectable label above a group. `""` prints a blank line. */
export function group(heading) {
  return { heading };
}
