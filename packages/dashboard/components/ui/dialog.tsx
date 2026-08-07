"use client";

/**
 * The modal, for the actions W4 puts inline on a session: cancel, approve,
 * fork, promote to eval. Every one of those does something to a running system,
 * so the shape is deliberately a confirmation rather than a general container —
 * a title, a description, the body, and a footer whose buttons the caller owns.
 *
 * `description` is not optional, and that is the point. Radix warns when a
 * dialog has no `aria-describedby`, and a dialog that says "Cancel session?"
 * and nothing else is one where the person clicking has to already know whether
 * that kills the sandbox too.
 */
import * as Primitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

import { BARE_BUTTON, SURFACE } from "./style";

export interface DialogProps {
  /** Omit for a fully controlled dialog opened from a menu item. */
  readonly trigger?: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
  /** Buttons, in reading order. The caller owns what they do. */
  readonly footer?: ReactNode;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function Dialog({
  trigger,
  title,
  description,
  children,
  footer,
  open,
  onOpenChange,
}: DialogProps) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Primitive.Trigger asChild>{trigger}</Primitive.Trigger> : null}
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Primitive.Content
          className={`${SURFACE} fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 p-5`}
        >
          <Primitive.Title className="m-0 text-section font-semibold text-text">
            {title}
          </Primitive.Title>
          <Primitive.Description className="mt-1.5 mb-0 text-body text-text-dim">
            {description}
          </Primitive.Description>
          {children ? <div className="mt-4">{children}</div> : null}
          {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
          <Primitive.Close
            className={`${BARE_BUTTON} absolute top-3 right-3 rounded-md px-2 py-1 text-small text-text-faint hover:bg-bg-hover hover:text-text`}
          >
            {/* A visible word rather than a bare glyph: the close control is
                the one every keyboard user tabs to first. */}
            Close
          </Primitive.Close>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
