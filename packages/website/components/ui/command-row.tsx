"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/* A copyable command line. The WHOLE row is the button (Convex/opencode), the
   `$` is aria-hidden decoration that never enters the clipboard, and the
   payload renders bright over dim boilerplate.

   Lifted out of the quickstart section so that section can stay a server
   component — this and the pack button are the only things on it that need
   the client. */
export function CommandRow({ pre, cmd, step }: { pre: string; cmd: string; step?: number }) {
  const [copied, setCopied] = useState(false);
  const full = pre + cmd;

  return (
    <button
      type="button"
      aria-label={`Copy "${full}"`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(full);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
      className="group/cmd cmd-plate flex w-full items-center gap-3 rounded-lg border border-transparent bg-gray-100 px-4 py-2.5 text-left font-mono text-mono-13 hover:bg-gray-200"
    >
      {/* Sequence in a gutter rather than inside the plate: these five run in
          order, and the deleted station rail was the only thing that used to
          say so. Dim enough to be structure, not content. */}
      {step !== undefined ? (
        <span aria-hidden className="select-none text-label-12 text-gray-600 transition-colors group-hover/cmd:text-gray-700">
          {String(step).padStart(2, "0")}
        </span>
      ) : null}
      <span aria-hidden className="select-none text-gray-600">
        $
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-gray-700">{pre}</span>
        <span className="font-medium text-gray-1000">{cmd}</span>
      </span>
      <span
        className={cn(
          "transition-colors",
          copied ? "text-ok" : "text-gray-600 group-hover/cmd:text-gray-1000",
        )}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <path d="M2.5 8.5 6 12l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5V9A1.5 1.5 0 0 0 4 10.5h1.5" />
          </svg>
        )}
      </span>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
