"use client";

/**
 * The window control. Presets, plus the two absolute fields drag-to-zoom needs
 * a keyboard equivalent for.
 *
 * That last part is the reason this has text inputs at all. Vercel
 * Observability's best interaction is drag a region on a chart, then Zoom In;
 * it is also mouse-only, and W3's brief says every mouse interaction owes a
 * keyboard one. Two `datetime-local` fields and an Apply button are that
 * equivalent — the same absolute range, reachable by tabbing.
 *
 * `datetime-local` has no zone, and the rest of this app is explicitly UTC
 * (`lib/time.ts` formats every instant with `getUTC*` and a `UTC` suffix), so
 * the fields are labelled UTC and read as UTC. Treating them as local here
 * would put the picker in a different zone from every timestamp it filters.
 */
import { useState } from "react";

import { Popover } from "./popover";
import { BARE_BUTTON, CONTROL, FOCUS_RING } from "./style";
import { PRESETS, type TimeRange, resolveRange } from "./time-range";

export interface TimeRangePickerProps {
  readonly value: TimeRange;
  readonly onChange: (range: TimeRange) => void;
  /** Pin the clock so a server render and its hydration agree. */
  readonly now?: number;
}

/** `YYYY-MM-DDTHH:mm` in UTC, which is what a `datetime-local` input holds. */
function toFieldValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/** The inverse. `Z` is appended because the field's text carries no zone. */
function fromFieldValue(text: string): number {
  return Date.parse(`${text}:00Z`);
}

export function TimeRangePicker({ value, onChange, now }: TimeRangePickerProps) {
  const [open, setOpen] = useState(false);
  const resolved = resolveRange(value, now);
  const [from, setFrom] = useState(() => toFieldValue(resolved.fromMs));
  const [to, setTo] = useState(() => toFieldValue(resolved.toMs));

  const fromMs = fromFieldValue(from);
  const toMs = fromFieldValue(to);
  const validAbsolute = Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs;

  return (
    <Popover
      label="Time range"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className={CONTROL} aria-label={`Time range: ${resolved.label}`}>
          {resolved.label}
          <span aria-hidden="true">▾</span>
        </button>
      }
    >
      <ul className="m-0 list-none p-0">
        {PRESETS.map((preset) => {
          const active = value.kind === "preset" && value.id === preset.id;
          return (
            <li key={preset.id}>
              <button
                type="button"
                // `aria-current` rather than colour alone: the active preset is
                // otherwise distinguishable only by a slightly brighter grey.
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onChange({ kind: "preset", id: preset.id });
                  setOpen(false);
                }}
                className={`${BARE_BUTTON} w-full rounded-sm px-2 py-1.5 text-body hover:bg-bg-hover ${
                  active ? "text-text" : "text-text-dim"
                }`}
              >
                {preset.label}
                {active ? <span aria-hidden="true"> ✓</span> : null}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 border-t border-border pt-2">
        <p className="m-0 mb-1.5 text-micro tracking-[0.06em] text-text-faint uppercase">
          Custom, UTC
        </p>
        <label className="mb-1.5 flex items-center gap-2 text-small text-text-dim">
          <span className="w-9">From</span>
          <input
            type="datetime-local"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className={`grow rounded-sm border border-border bg-bg px-1.5 py-1 text-body text-text [font-family:inherit] ${FOCUS_RING}`}
          />
        </label>
        <label className="mb-2 flex items-center gap-2 text-small text-text-dim">
          <span className="w-9">To</span>
          <input
            type="datetime-local"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className={`grow rounded-sm border border-border bg-bg px-1.5 py-1 text-body text-text [font-family:inherit] ${FOCUS_RING}`}
          />
        </label>
        <button
          type="button"
          disabled={!validAbsolute}
          onClick={() => {
            onChange({ kind: "absolute", fromMs, toMs });
            setOpen(false);
          }}
          className={CONTROL}
        >
          Apply
        </button>
        {/* Said out loud rather than left to a greyed-out button, which
            communicates nothing about why. */}
        {!validAbsolute ? (
          <p className="mt-1.5 mb-0 text-small text-err">From must be earlier than To.</p>
        ) : null}
      </div>
    </Popover>
  );
}
