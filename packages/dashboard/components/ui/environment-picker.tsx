"use client";

/**
 * Scopes a whole page to one environment.
 *
 * Not the same thing as the table's faceted filter, and both are needed. The
 * facet filters rows already on screen; this filters the queries behind every
 * chart on the page, including the ones with no table under them.
 *
 * ## The three-state value, which is the only subtle part
 *
 *   `undefined`  no filter — every environment
 *   `null`       the rows whose `environment` column is NULL
 *   `"…"`        that environment
 *
 * `null` is not a technicality here. On the seeded month 1,552 of 1,922 turns
 * carry no environment at all and 370 say `development`, so "no environment" is
 * the majority of the data and has to be selectable. Folding it into "all"
 * would make the two most common selections indistinguishable.
 *
 * That vocabulary is `table-filter.ts`'s (`null` is absence) plus TanStack's
 * (`undefined` clears a filter), so the same three states mean the same three
 * things everywhere in this directory.
 *
 * Native radios rather than a listbox: a radio group already has the roles, the
 * arrow-key movement, the grouped label and the checked state that a
 * hand-rolled single-select has to reimplement and usually gets half right.
 */
import { useId, useState } from "react";

import { EM_DASH } from "./format";
import { Popover } from "./popover";
import { CONTROL, FOCUS_RING } from "./style";

export type EnvironmentValue = string | null;

export interface EnvironmentPickerProps {
  /** Distinct values present in the data, `null` included when it occurs. */
  readonly environments: readonly EnvironmentValue[];
  /** `undefined` means every environment. */
  readonly value: EnvironmentValue | undefined;
  readonly onChange: (value: EnvironmentValue | undefined) => void;
}

const ALL = "all";
const NONE = "none";

/** Radio values are indices, so a real environment literally named `all` cannot
 *  collide with the sentinel for "every environment". */
function optionValue(index: number): string {
  return `env-${index}`;
}

export function EnvironmentPicker({ environments, value, onChange }: EnvironmentPickerProps) {
  const [open, setOpen] = useState(false);
  const name = useId();

  const selected =
    value === undefined
      ? ALL
      : value === null
        ? NONE
        : optionValue(environments.indexOf(value));

  const label = value === undefined ? "All environments" : (value ?? EM_DASH);

  const choose = (next: EnvironmentValue | undefined) => {
    onChange(next);
    setOpen(false);
  };

  const option = (key: string, id: string, text: string, onSelect: () => void) => (
    <label
      key={key}
      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-body hover:bg-bg-hover"
    >
      <input
        type="radio"
        name={name}
        value={id}
        checked={selected === id}
        onChange={onSelect}
        className={FOCUS_RING}
      />
      <span>{text}</span>
    </label>
  );

  return (
    <Popover
      label="Environment"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className={CONTROL} aria-label={`Environment: ${label}`}>
          {label}
          <span aria-hidden="true">▾</span>
        </button>
      }
    >
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1 px-2 text-micro tracking-[0.06em] text-text-faint uppercase">
          Environment
        </legend>
        {option(ALL, ALL, "All environments", () => choose(undefined))}
        {environments.map((environment, index) =>
          environment === null
            ? // The em dash is what an absent value renders as in every cell of
              // this app; the words beside it are what makes it clickable.
              option(NONE, NONE, `${EM_DASH}  no environment`, () => choose(null))
            : option(environment, optionValue(index), environment, () => choose(environment)),
        )}
      </fieldset>
      {environments.length === 0 ? (
        <p className="m-0 px-2 py-1.5 text-small text-text-faint">
          No environments recorded in this window.
        </p>
      ) : null}
    </Popover>
  );
}
