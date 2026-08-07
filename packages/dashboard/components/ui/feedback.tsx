/**
 * What a surface says when it has no number, or only part of one.
 *
 * Two components, paired because they are the same obligation at two strengths.
 * `Placeholder` is what a card, a table or a chart renders instead of a value.
 * `CoverageNote` is what it renders *beside* a value that was computed over
 * less than the whole population — the difference between a p95 and a p95 over
 * three of forty turns, which is the difference between a measurement and a
 * guess with an axis under it.
 *
 * The empty and the error case are one component with a `tone` rather than two,
 * because the only differences are the colour of the title and whether an
 * assistive technology should be interrupted. Splitting them duplicates the
 * layout and lets the two drift.
 *
 * The shape deliberately mirrors `app/db-error.tsx`, which is the same idea at
 * page scale: a title, a plain-language detail, and an optional next step.
 */
import type { ReactNode } from "react";

import { type Coverage, coverageNote } from "./format";

export interface PlaceholderProps {
  /** `error` colours the title and announces it; `empty` is silent. */
  readonly tone?: "empty" | "error";
  readonly title: string;
  /** One sentence. Say what happened, not that something happened. */
  readonly detail?: ReactNode;
  /** A link or button offering the next step. Optional on purpose. */
  readonly action?: ReactNode;
}

export function Placeholder({ tone = "empty", title, detail, action }: PlaceholderProps) {
  return (
    <div
      // `alert` only for the error tone. An empty table is not an interruption,
      // and marking it as one trains people to ignore the role that matters.
      role={tone === "error" ? "alert" : undefined}
      // Sized to sit inside a card or a table body. There is deliberately no
      // page-scale variant: `.empty` in app/globals.css and `app/db-error.tsx`
      // are that, they already ship, and a second one would be a fork.
      className="px-4 py-10 text-center text-text-dim"
    >
      <p
        className={[
          "m-0 text-section",
          tone === "error" ? "text-err" : "text-text",
        ].join(" ")}
      >
        {title}
      </p>
      {detail ? <p className="mx-auto mt-2 mb-0 max-w-prose text-body">{detail}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export interface CoverageNoteProps {
  readonly coverage: Coverage;
  /**
   * Names the population in the sentence, e.g. `turns`. Without it the note
   * says "rows", which is honest but vaguer than it needs to be.
   */
  readonly noun?: string;
}

/**
 * Renders nothing when coverage is full or the result set is empty — see
 * `coverageNote`, which owns that decision so this and any chart tooltip
 * cannot answer it differently.
 */
export function CoverageNote({ coverage, noun }: CoverageNoteProps) {
  const note = coverageNote(coverage, noun);
  if (note === null) return null;
  return <p className="m-0 text-small text-warn">{note}</p>;
}
