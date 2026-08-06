"use client";

/**
 * A tooltip that carries its own provider.
 *
 * Radix's `Tooltip.Root` throws without a `Tooltip.Provider` above it, which
 * means the usual shape of this component is "works, but only if someone
 * remembered to wrap the app". That failure lands at runtime, on whichever page
 * forgot, and the fix is invisible from the call site. Nesting the provider
 * inside each tooltip trades shared open-delay grouping — a real but small
 * nicety — for a primitive that cannot be used wrong.
 *
 * `content` is a string rather than a node on purpose. A tooltip is announced
 * to a screen reader as the trigger's description; a paragraph with a link
 * inside it is a popover, and Radix has one of those.
 */
import * as Primitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

import { SURFACE } from "./style";

export interface TooltipProps {
  readonly content: string;
  /**
   * Must be focusable, or the tooltip is mouse-only. Radix warns in dev when it
   * is not, which is the check that actually catches this.
   */
  readonly children: ReactNode;
}

export function Tooltip({ content, children }: TooltipProps) {
  return (
    <Primitive.Provider delayDuration={200}>
      <Primitive.Root>
        <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            side="top"
            sideOffset={6}
            collisionPadding={8}
            className={`${SURFACE} max-w-72 px-2.5 py-1.5 text-small`}
          >
            {content}
            <Primitive.Arrow className="fill-border" />
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}
