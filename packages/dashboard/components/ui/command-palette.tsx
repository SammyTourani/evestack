"use client";

/**
 * ⌘K. Everything the dashboard can do, reachable from the keyboard.
 *
 * Self-contained rather than controlled: it renders its own trigger and owns
 * its own open state. A palette with no visible affordance is a feature only
 * the person who built it knows about, and a palette whose shortcut every page
 * has to remember to wire is one that works on four pages out of ten. One
 * component, one `groups` prop, and both problems are structural rather than
 * remembered.
 *
 * `cmdk` provides the filtering, the scoring and the roving selection —
 * `Command.Input` is a real combobox with `aria-activedescendant`, which is the
 * part nobody hand-rolls correctly. It is built on the same Radix dialog as
 * `dialog.tsx`, so focus trapping and Escape behave identically.
 *
 * `keywords` matters more than it looks: the palette is how someone finds the
 * page whose name they do not remember. "Cost" should find Sessions; "p95"
 * should find Monitors. Without them the palette only helps people who already
 * know the nav.
 */
import { Command } from "cmdk";
import { useEffect, useState } from "react";

import { BARE_BUTTON, FOCUS_RING, SURFACE } from "./style";

export interface CommandAction {
  readonly id: string;
  readonly label: string;
  /** Right-aligned context: a route, a shortcut, a count. */
  readonly hint?: string;
  /** Extra search terms. See the note above — these carry the palette. */
  readonly keywords?: readonly string[];
  readonly onSelect: () => void;
}

export interface CommandGroup {
  readonly heading: string;
  readonly items: readonly CommandAction[];
}

export interface CommandPaletteProps {
  readonly groups: readonly CommandGroup[];
  readonly placeholder?: string;
}

export function CommandPalette({
  groups,
  placeholder = "Search pages and actions…",
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // `metaKey || ctrlKey` rather than platform sniffing: both are ⌘K on a
      // Mac and Ctrl+K elsewhere, and neither is a browser shortcut worth
      // preserving on this page.
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-keyshortcuts="Meta+K Control+K"
        className={`${BARE_BUTTON} inline-flex items-center gap-6 rounded-md border border-border bg-bg-raised px-2.5 py-1.5 text-small text-text-faint hover:bg-bg-hover hover:text-text`}
      >
        <span>Search…</span>
        <kbd className="font-mono text-micro">⌘K</kbd>
      </button>

      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="Command palette"
        overlayClassName="fixed inset-0 z-50 bg-black/60"
        contentClassName={`${SURFACE} fixed top-[12vh] left-1/2 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden p-0`}
      >
        <Command.Input
          placeholder={placeholder}
          className={`w-full border-0 border-b border-border bg-transparent px-4 py-3 text-body text-text placeholder:text-text-faint [font-family:inherit] ${FOCUS_RING}`}
        />
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="px-2 py-6 text-center text-body text-text-dim">
            Nothing matches that.
          </Command.Empty>
          {groups.map((group) => (
            <Command.Group
              key={group.heading}
              heading={group.heading}
              className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-text-faint [&_[cmdk-group-heading]]:uppercase"
            >
              {group.items.map((item) => (
                <Command.Item
                  key={item.id}
                  value={`${group.heading} ${item.label}`}
                  keywords={item.keywords ? [...item.keywords] : undefined}
                  onSelect={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className="flex cursor-pointer items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-body text-text data-[selected=true]:bg-bg-hover"
                >
                  <span>{item.label}</span>
                  {item.hint ? (
                    <span className="font-mono text-small text-text-faint">{item.hint}</span>
                  ) : null}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command.Dialog>
    </>
  );
}
