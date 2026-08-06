"use client";

import { useState } from "react";
import styles from "./evals.module.css";

/**
 * Copy the previewed source to the clipboard.
 *
 * The failure path is the interesting one. `navigator.clipboard` only exists in
 * a secure context, and evestack is meant to be self-hosted — served over plain
 * HTTP from a box on someone's LAN as often as not. `http://localhost:4000` is
 * treated as secure and works; `http://192.168.1.20:4000` is not, and the API
 * is simply absent there. So the button reports that in the one sentence that
 * explains it, and points at the download link beside it, which has no such
 * requirement. Silently doing nothing would look like a broken button.
 */
export function CopySource({ source }: { source: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard api");
      await navigator.clipboard.writeText(source);
      setState("copied");
      window.setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <button type="button" className={styles.btn} onClick={copy}>
        {state === "copied" ? "Copied" : "Copy source"}
      </button>
      {state === "failed" && (
        <span className={styles.copyNote}>
          This browser only allows clipboard writes over HTTPS or from localhost. Use Download
          instead.
        </span>
      )}
    </>
  );
}
