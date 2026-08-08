"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { CONTROL } from "@/components/ui/style";

/**
 * The overview refreshes itself, and says when it last did.
 *
 * ── The decision this settles ────────────────────────────────────────────────
 *
 * `/` is `force-dynamic`, so every load runs the queries fresh — and then sat
 * there. A page whose whole job is "is anything wrong right now" was answering
 * "here is what was wrong when you opened this tab", and nothing on it said so.
 * Left open on a wall display it would show a healthy system indefinitely while
 * the agent burned, which is the same failure as the alert panel that told
 * nobody: an absence of information rendered as reassurance.
 *
 * Three options were on the table. Server-Sent Events, which /api/control/…/stream
 * already uses, would be genuinely live — but every tile here is a SQL
 * aggregate, not an event, so a stream would exist only to say "re-run the
 * queries", which is what this does with none of the connection lifetime to get
 * wrong. `export const revalidate` is the Next-native answer and is wrong for a
 * different reason: it caches, and this page must not — two operators would see
 * each other's window. So: a client-side interval that asks the server to
 * re-render.
 *
 * ── Why it does not just call setInterval and leave ──────────────────────────
 *
 * Measured on the seeded database (3,322 runs, 32,863 spans): a warm overview
 * render is ~145ms and the 7-day window is no worse. That is cheap — but cheap
 * multiplied by every tab someone forgot to close is not, and a background tab
 * refreshing all night is pure waste. So the timer stops when the document is
 * hidden and fires once the moment it comes back, because the first thing you
 * want on returning to a monitoring tab is data from now rather than data from
 * whenever you left.
 */

/** Long enough to be free, short enough that the page is not lying to you. */
const INTERVAL_MS = 30_000;

export function Live() {
  const router = useRouter();
  const [live, setLive] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  // `now` drives only the "Xs ago" label. Kept separate from `refreshedAt` so
  // ticking the label does not re-run the refresh.
  const [now, setNow] = useState<number | null>(null);
  const pending = useRef(false);

  const refresh = useCallback(() => {
    // `router.refresh()` is not awaitable and does not tell us when the new
    // payload lands, so this marks the attempt rather than the completion. The
    // guard stops a slow render from stacking refreshes behind it.
    if (pending.current) return;
    pending.current = true;
    router.refresh();
    setRefreshedAt(Date.now());
    // One interval is far longer than the ~145ms render, so this only ever
    // suppresses a genuine pile-up.
    setTimeout(() => {
      pending.current = false;
    }, 1_000);
  }, [router]);

  // Mount only. Rendering a timestamp on the server and a different one on the
  // client is a hydration mismatch; starting at null and filling it in here is
  // what keeps the first paint identical on both sides.
  useEffect(() => {
    setRefreshedAt(Date.now());
    setNow(Date.now());
    const label = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(label);
  }, []);

  useEffect(() => {
    if (!live) return undefined;

    let timer: ReturnType<typeof setInterval> | undefined;

    const start = (): void => {
      if (timer === undefined) timer = setInterval(refresh, INTERVAL_MS);
    };
    const stop = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        // Immediately, then resume the cadence. Whatever is on screen was
        // rendered before the tab was hidden and is by definition stale.
        refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, refresh]);

  const seconds =
    refreshedAt === null || now === null ? null : Math.max(0, Math.round((now - refreshedAt) / 1000));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={CONTROL}
        onClick={() => setLive((v) => !v)}
        aria-pressed={live}
      >
        <span
          aria-hidden="true"
          className={`inline-block size-1.5 rounded-full ${live ? "bg-ok" : "bg-text-faint"}`}
        />
        {live ? "Live" : "Paused"}
      </button>

      <button type="button" className={CONTROL} onClick={refresh}>
        Refresh now
      </button>

      {/*
        The age of the data, always. This is the part that makes pausing safe:
        a paused page that did not say how old it was would be the original bug
        with a button added to it.

        aria-live is deliberately absent — a counter that announced itself every
        second would make the page unusable with a screen reader, and the number
        is not news. `suppressHydrationWarning` is not needed because the value
        is null until mounted.
      */}
      <span className="text-small text-text-dim">
        {seconds === null
          ? " "
          : seconds < 5
            ? "updated just now"
            : `updated ${seconds}s ago`}
        {live ? "" : " · paused"}
      </span>
    </div>
  );
}
