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
 * What is left to undo on a `<button>` once preflight is in the page.
 *
 * This constant used to open "because preflight is not here", and carried six
 * utilities to hand-roll what preflight does. It is here now — `app/globals.css`
 * imports `tailwindcss/preflight.css` into the `base` layer, and
 * test/design-tokens.test.mjs fails if that import is removed — so the list has
 * been cut to the two things preflight does NOT do, plus the ring.
 *
 * Read off tailwindcss@4.3.3/preflight.css rather than assumed:
 *
 *   line 13-15   `*` gets margin: 0, padding: 0, border: 0 solid
 *                  → `p-0` and `border-0` were duplicates
 *   line 243-255 `button` gets `font: inherit` and background-color: transparent
 *                  → `[font-family:inherit]`, `[line-height:inherit]` and
 *                    `bg-transparent` were duplicates. `font:` is the shorthand,
 *                    so it carries line-height as well as family
 *   line 377-380 `button` gets `appearance: button`
 *                  → `appearance-none` is NOT a duplicate. Preflight adds this
 *                    one, to make the border-radius stylable in iOS Safari, and
 *                    without the reset a button renders as a platform control
 *
 * `text-left` stays because a `<button>` centres its text by user-agent default
 * and preflight does not touch text-align; every use of this is a row or a menu
 * item where centred text would be wrong.
 */
export const BARE_BUTTON = `cursor-pointer appearance-none text-left ${FOCUS_RING}`;

/**
 * The neutral control: a filter chip, a toolbar button, a menu trigger. Sized
 * to the 12px mono of `.status` and the table header rather than to a new
 * scale, so a control sitting next to a pill matches its height.
 */
export const CONTROL = `inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-raised px-2.5 py-1.5 text-small text-text-dim hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50 appearance-none cursor-pointer ${FOCUS_RING}`;

/**
 * A text input.
 *
 * `border` and `bg-*` are re-stated rather than inherited: preflight strips both
 * from a form control (`border: 0 solid`, `background-color: transparent`), so
 * on this palette an unstyled input is an invisible box on the page background.
 * The font is preflight's job — `font: inherit` at line 249 — and is no longer
 * repeated here. Checkboxes and radios are deliberately left native; those
 * should look like the platform's.
 */
export const FIELD = `rounded-md border border-border bg-bg-raised px-2.5 py-1.5 text-body text-text placeholder:text-text-faint ${FOCUS_RING}`;
