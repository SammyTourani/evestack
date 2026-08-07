/**
 * The class strings that must be identical everywhere.
 *
 * It is accessibility, and it fails silently when it drifts. A focus ring that
 * is 2px on a button and 1px on a menu item is not a bug anyone reports; it is
 * just slightly harder to see where you are, on the surface where the keyboard
 * user has nothing else to go on. Writing the utilities out at each call site
 * is how that happens, so they are written once here and imported.
 *
 * The values match what `app/globals.css` already draws on the sign-in field —
 * `outline: 2px solid var(--accent); outline-offset: 1px` — through the
 * `--color-focus` token, which exists so the ring can stay legible if the
 * accent ever moves for brand reasons.
 *
 * `focus-visible` rather than `focus` so a mouse click does not leave a ring
 * behind, and `outline` rather than a box-shadow ring so the indicator is never
 * clipped by an ancestor's `overflow-hidden` — which the table's scroll
 * container and every popover surface have.
 */
export const FOCUS_RING =
  "outline-none focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1";

/**
 * A floating panel: the popover, the dropdown menu, the dialog and the command
 * palette are all the same surface at different sizes, and they look wrong the
 * moment one of them is a shade off.
 *
 * `shadow-black/40` rather than a token: the shadow is not a colour decision
 * that light mode reverses, it is separation from whatever is behind, and on
 * the light palette a black shadow at low alpha is still what reads as depth.
 *
 * No transition and no animation, anywhere. That is not an omission — a panel
 * that never moves needs no `prefers-reduced-motion` branch to get right, and
 * these open in response to a click that already happened.
 */
export const SURFACE =
  "rounded-md border border-border bg-bg-raised text-text shadow-lg shadow-black/40";

/**
 * Undo the operating system's idea of a button, because preflight is not here.
 *
 * `app/globals.css` takes Tailwind's theme and utilities and deliberately skips
 * preflight, so form controls keep their user-agent styling. Measured in Chrome
 * on this app rather than assumed: a `<button>` with only layout and colour
 * utilities on it computes `background-color: rgb(239, 239, 239)`,
 * `border: 2px outset`, `font-family: Arial` and `text-align: center`. In the
 * middle of a dark table header that is a grey OS button with the wrong
 * typeface, and no class in the component says so.
 *
 * `[font-family:inherit]` is the half that will matter later even where the
 * rest does not: `--font-sans` already resolves to Geist, and the moment a wave
 * puts it on `<body>` every control that did not inherit stays on Arial.
 *
 * Padding is reset to zero and re-added per button, which works because
 * Tailwind emits `px-*`/`py-*` after `p-*` regardless of the order they appear
 * in the class string.
 */
export const BARE_BUTTON =
  `cursor-pointer appearance-none border-0 bg-transparent p-0 text-left [font-family:inherit] [line-height:inherit] ${FOCUS_RING}`;

/**
 * The neutral control: a filter chip, a toolbar button, a menu trigger. Sized
 * to the 12px mono of `.status` and the table header rather than to a new
 * scale, so a control sitting next to a pill matches its height.
 */
export const CONTROL = `inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-raised px-2.5 py-1.5 text-small text-text-dim hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50 [font-family:inherit] [line-height:inherit] appearance-none cursor-pointer ${FOCUS_RING}`;

/**
 * A text input. Same reason as `BARE_BUTTON`: without preflight an `<input>`
 * computes `font-family: Arial` while the page around it is on `--sans`, which
 * is why `.signin-field input` in `app/globals.css` has always said
 * `font: inherit`. Checkboxes and radios are deliberately left native — those
 * should look like the platform's.
 */
export const FIELD = `rounded-md border border-border bg-bg-raised px-2.5 py-1.5 text-body text-text placeholder:text-text-faint [font-family:inherit] ${FOCUS_RING}`;
