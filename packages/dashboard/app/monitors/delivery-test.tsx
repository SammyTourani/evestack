"use client";

import { useRef, useState } from "react";

import { CONTROL } from "@/components/ui/style";

/**
 * "Does my webhook actually work?", answered in one click.
 *
 * The alternative is the one every alerting integration ships with: you paste a
 * URL, nothing happens because nothing is wrong, and you find out whether it was
 * right the next time production breaks. That is not a setup flow, it is a
 * second incident.
 *
 * It POSTs `?test=1`, which sends one obviously-synthetic message and
 * deliberately does not touch the transition state — see sendTestNotification().
 * A test that consumed a real transition could swallow the alert it was meant to
 * prove.
 */
export function DeliveryTest({ sinks }: { sinks: readonly string[] }) {
  const [state, setState] = useState<"idle" | "sending" | "ok" | "failed">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);

  async function send(): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    setState("sending");
    setMessage(null);
    try {
      const response = await fetch("/api/alerts?test=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json()) as {
        ok?: boolean;
        sent?: number;
        skipped?: string | null;
        failures?: { sink: string; error: string }[];
        error?: string;
      };

      if (!response.ok || body.ok !== true) {
        setState("failed");
        setMessage(body.error ?? `HTTP ${response.status}`);
        return;
      }
      if (body.failures !== undefined && body.failures.length > 0) {
        setState("failed");
        setMessage(
          body.failures.map((f) => `${f.sink}: ${f.error}`).join("; "),
        );
        return;
      }
      if (body.skipped || typeof body.sent !== "number" || body.sent < 1) {
        setState("failed");
        setMessage(
          body.skipped ??
            "No destination accepted the test. Check notification setup.",
        );
        return;
      }
      setState("ok");
      setMessage(
        `${body.sent} ${body.sent === 1 ? "destination accepted" : "destinations accepted"} the test. Check the channel to confirm receipt.`,
      );
    } catch (error) {
      // A network error here means the dashboard itself is unreachable from the
      // browser, which is worth saying rather than rendering as a failed webhook.
      setState("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      lock.current = false;
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={CONTROL}
        onClick={() => void send()}
        disabled={state === "sending" || sinks.length === 0}
      >
        {state === "sending" ? "Sending…" : "Send a test"}
      </button>
      {message === null ? null : (
        <span
          className={`text-small ${state === "failed" ? "text-err" : "text-text-dim"}`}
          role="status"
        >
          {message}
        </span>
      )}
    </span>
  );
}
