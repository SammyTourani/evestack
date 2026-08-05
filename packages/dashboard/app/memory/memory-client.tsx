"use client";

import { useState } from "react";
import type { MemoryRow } from "@/lib/memories";
import styles from "./memory.module.css";

/**
 * The list is a client component only because deleting needs local state:
 * a confirm step, an in-flight marker, and removing the row without a reload.
 * Everything else on this page is server-rendered.
 */
export function MemoryList({ rows }: { rows: readonly MemoryRow[] }) {
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/memories/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Delete failed (${response.status}).`);
      }
      setRemoved((prev) => new Set(prev).add(id));
      setConfirming(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delete failed.");
    } finally {
      setBusy(null);
    }
  }

  const visible = rows.filter((row) => !removed.has(row.id));

  return (
    <>
      {error && <p className={styles.error}>{error}</p>}
      <ul className={styles.list}>
        {visible.map((row) => (
          <li key={row.id} className={styles.item}>
            <div className={styles.content}>{row.content}</div>
            <div className={styles.meta}>
              <span className="mono">#{row.id}</span>
              <span className={styles.dot}>•</span>
              <span title={row.createdAt}>
                {new Date(row.createdAt).toLocaleString("en-US", {
                  timeZone: "UTC",
                  hour12: false,
                })}
              </span>
              {row.sessionId && (
                <>
                  <span className={styles.dot}>•</span>
                  <a className="mono" href={`/sessions/${encodeURIComponent(row.sessionId)}`}>
                    saved in {row.sessionId.slice(-8)}
                  </a>
                </>
              )}
              {row.tags.length > 0 && (
                <span className={styles.tags}>
                  {row.tags.map((tag) => (
                    <span key={tag} className={styles.tag}>
                      {tag}
                    </span>
                  ))}
                </span>
              )}

              {confirming === row.id ? (
                <span className={styles.confirm}>
                  <button
                    type="button"
                    className={styles.danger}
                    disabled={busy === row.id}
                    onClick={() => remove(row.id)}
                  >
                    {busy === row.id ? "deleting…" : "really delete"}
                  </button>
                  <button
                    type="button"
                    className={styles.cancel}
                    onClick={() => setConfirming(null)}
                  >
                    keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.forget}
                  onClick={() => {
                    setConfirming(row.id);
                    setError(null);
                  }}
                >
                  forget
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {visible.length === 0 && (
        <p className="faint">Every memory on this page has been deleted.</p>
      )}
    </>
  );
}
