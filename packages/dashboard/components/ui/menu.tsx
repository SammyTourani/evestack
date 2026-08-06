"use client";

/**
 * The actions menu. W4 hangs cancel / message / approve / fork / promote off a
 * session, W5 hangs export off a table, and both want the same thing: a button
 * that opens a keyboard-navigable list.
 *
 * Three parts rather than an `items` array, because the contents genuinely
 * vary — a separator between reads and writes, a destructive item, a link out.
 * An array prop would grow a field for each of those and end up a worse version
 * of children.
 *
 * `Menu.Item` is `@radix-ui/react-dropdown-menu`'s, so arrow keys, typeahead,
 * `Escape`, and focus return are already correct. `tone="danger"` colours the
 * one item that ends a running agent, and says so in words as well.
 */
import * as Primitive from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

import { FOCUS_RING, SURFACE } from "./style";

export interface MenuProps {
  readonly trigger: ReactNode;
  /** Accessible name for the list itself. */
  readonly label: string;
  readonly children: ReactNode;
}

export function Menu({ trigger, label, children }: MenuProps) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          // Right-aligned: the trigger is an overflow control at the end of a
          // row, and a menu opening leftward off it stays on screen.
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          className={`${SURFACE} z-50 min-w-44 p-1`}
        >
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export interface MenuItemProps {
  readonly onSelect?: () => void;
  readonly disabled?: boolean;
  readonly tone?: "default" | "danger";
  readonly children: ReactNode;
}

export function MenuItem({ onSelect, disabled, tone = "default", children }: MenuItemProps) {
  return (
    <Primitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={[
        "flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-body select-none",
        "data-[highlighted]:bg-bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        tone === "danger" ? "text-err" : "text-text",
        FOCUS_RING,
      ].join(" ")}
    >
      {children}
    </Primitive.Item>
  );
}

/** `role="separator"` comes from Radix; this only draws the line. */
export function MenuSeparator() {
  return <Primitive.Separator className="my-1 h-px bg-border" />;
}
