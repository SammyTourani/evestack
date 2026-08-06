"use client";

/**
 * A panel anchored to a trigger. The facet filters, the time-range picker and
 * the environment picker are all this component with different contents.
 *
 * Controlled and uncontrolled both work: pass `open`/`onOpenChange` when the
 * page needs to know (closing a filter after applying it), pass neither when it
 * does not. Radix handles focus trapping, escape, outside-click and returning
 * focus to the trigger; none of that is re-implemented here, which is the whole
 * reason for the dependency.
 */
import * as Primitive from "@radix-ui/react-popover";
import type { ReactNode } from "react";

import { SURFACE } from "./style";

export interface PopoverProps {
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  /** Accessible name for the panel, announced when focus moves into it. */
  readonly label: string;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function Popover({
  trigger,
  children,
  label,
  open,
  onOpenChange,
}: PopoverProps) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          className={`${SURFACE} z-50 max-h-[min(28rem,var(--radix-popover-content-available-height))] overflow-y-auto p-2 text-body`}
        >
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
