"use client";

/**
 * Tabs, for W4's three panes — tree, timeline and transcript, facts.
 *
 * An `items` array rather than composed children, because a tab list is the one
 * case where the structure really is fixed: every tab is a label and a panel,
 * and Radix requires the `value` on the trigger and the content to match. An
 * array makes that pairing impossible to get wrong; children make it a runtime
 * mismatch that renders an empty panel.
 *
 * Radix gives roving tab focus, arrow-key movement, `role="tab"`/`tabpanel`
 * and the `aria-controls` wiring. The only thing added here is that the active
 * tab is marked by a 2px underline *and* a text colour, so it is not colour
 * alone.
 */
import * as Primitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

import { FOCUS_RING } from "./style";

export interface TabItem {
  readonly value: string;
  readonly label: ReactNode;
  readonly content: ReactNode;
  readonly disabled?: boolean;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  /** Defaults to the first item. */
  readonly defaultValue?: string;
  readonly value?: string;
  readonly onValueChange?: (value: string) => void;
  /** Accessible name for the tab list. */
  readonly label: string;
}

export function Tabs({ items, defaultValue, value, onValueChange, label }: TabsProps) {
  if (items.length === 0) return null;
  return (
    <Primitive.Root
      defaultValue={defaultValue ?? items[0].value}
      value={value}
      onValueChange={onValueChange}
    >
      <Primitive.List
        aria-label={label}
        className="flex gap-1 border-b border-border"
      >
        {items.map((item) => (
          <Primitive.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={[
              "-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-body text-text-dim",
              "hover:text-text disabled:cursor-not-allowed disabled:opacity-50",
              "data-[state=active]:border-accent data-[state=active]:text-text",
              FOCUS_RING,
            ].join(" ")}
          >
            {item.label}
          </Primitive.Trigger>
        ))}
      </Primitive.List>
      {items.map((item) => (
        <Primitive.Content key={item.value} value={item.value} className={`pt-4 ${FOCUS_RING}`}>
          {item.content}
        </Primitive.Content>
      ))}
    </Primitive.Root>
  );
}
