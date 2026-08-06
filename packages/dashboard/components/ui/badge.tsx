/**
 * The pill.
 *
 * `app/globals.css` already ships `.status` plus four `.status-*` colours, used
 * on five pages. This is the same pill in Tailwind, with two differences that
 * matter.
 *
 * First, it is driven by a `tone` rather than by interpolating a database value
 * into a class name. `` className={`status status-${s.status}`} `` is how a new
 * status value silently renders as an unstyled grey pill: there is no
 * `.status-budget_stopped`, nothing errors, and the row just looks wrong. A
 * union type is a compile error instead.
 *
 * Second, `OutcomeBadge` knows the vocabulary W2 introduced. `outcome` is the
 * column W5 replaces `status` with — `status` reads `running` for every row
 * because eve leaves session runs running forever — and its seven values are
 * not self-explanatory, so each carries a `title` saying what it means.
 *
 * Colour is never the only signal: every pill's text is the state's name.
 */
import type { ReactNode } from "react";

export type Tone = "neutral" | "ok" | "warn" | "err" | "info";

/**
 * `color-mix` at 40% on the border matches `.status-completed` exactly, and is
 * why the pill reads as tinted rather than as a solid chip.
 */
const TONE: Readonly<Record<Tone, string>> = {
  neutral: "text-text-faint border-border",
  ok: "text-ok border-[color-mix(in_srgb,var(--ok)_40%,transparent)]",
  warn: "text-warn border-[color-mix(in_srgb,var(--warn)_40%,transparent)]",
  err: "text-err border-[color-mix(in_srgb,var(--err)_40%,transparent)]",
  info: "text-accent border-[color-mix(in_srgb,var(--accent)_40%,transparent)]",
};

export interface BadgeProps {
  readonly tone?: Tone;
  /** Hover/focus explanation. Rendered as the native `title`. */
  readonly title?: string;
  readonly children: ReactNode;
}

export function Badge({ tone = "neutral", title, children }: BadgeProps) {
  return (
    <span
      title={title}
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-micro ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Every value `fact_turn.outcome` is allowed to hold, per the CHECK constraint
 * in `sql/facts.sql`. Kept as a total map rather than a lookup with a fallback:
 * a value added to that constraint and not to this map is a type error at the
 * call site, which is the only place it can still be fixed cheaply.
 */
export type Outcome =
  | "ok"
  | "failed"
  | "no_model_call"
  | "cancelled"
  | "budget_stopped"
  | "wedged"
  | "running";

const OUTCOME: Readonly<Record<Outcome, { label: string; tone: Tone; title: string }>> = {
  ok: { label: "ok", tone: "ok", title: "Finished, recorded a model call, no error." },
  failed: { label: "failed", tone: "err", title: "Finished carrying an error code." },
  no_model_call: {
    label: "no model call",
    tone: "err",
    // Counted as a failure by lib/monitors.ts, which is why the tone matches
    // `failed` — a turn that ended without ever reaching a model did not work,
    // whatever its status column says.
    title: "Finished without ever recording a model call. Counted as a failure.",
  },
  cancelled: { label: "cancelled", tone: "neutral", title: "Stopped by a person or an API call." },
  budget_stopped: {
    label: "budget stopped",
    tone: "warn",
    title: "Stopped because it reached its configured spend or step cap.",
  },
  wedged: {
    label: "wedged",
    tone: "warn",
    title: "Still in flight long past any plausible duration. Nothing is finishing it.",
  },
  running: { label: "running", tone: "info", title: "In flight now." },
};

export function OutcomeBadge({ outcome }: { readonly outcome: Outcome }) {
  const { label, tone, title } = OUTCOME[outcome];
  return (
    <Badge tone={tone} title={title}>
      {label}
    </Badge>
  );
}
