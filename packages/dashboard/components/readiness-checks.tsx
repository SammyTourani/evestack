"use client";

import { useRef, useState } from "react";
import type { ReadinessCheck, ReadinessStatus } from "@/lib/readiness";

const labels: Record<ReadinessStatus, string> = {
  verified: "Verified by check",
  configured: "Configured · not verified",
  unconfigured: "Not configured",
  unavailable: "Needs attention",
  unknown: "Not yet verified",
};

export function ReadinessChecks({ initialChecks }: { initialChecks: ReadinessCheck[] }) {
  const [checks, setChecks] = useState(initialChecks);
  const [busy, setBusy] = useState<string[]>([]);
  const locks = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function recheck(id: string) {
    if (locks.current.has(id)) return;
    locks.current.add(id);
    setBusy([...locks.current]);
    setErrors((previous) => ({ ...previous, [id]: "" }));
    try {
      const response = await fetch(`/api/readiness?check=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000), cache: "no-store" });
      const body = await response.json();
      const check = body.checks?.find((item: ReadinessCheck) => item.id === id);
      if (!response.ok || !body.ok || !check) throw new Error("The check did not return a result.");
      setChecks((previous) => previous.map((item) => item.id === id ? check : item));
    } catch {
      setErrors((previous) => ({ ...previous, [id]: "The latest check could not be completed. The result below is from the previous check." }));
    } finally {
      locks.current.delete(id);
      setBusy([...locks.current]);
    }
  }
  return <div className="workspace-grid">
    {checks.map((check) => <section key={check.id} className="workspace-section" aria-labelledby={`setup-${check.id}`}>
      <h2 id={`setup-${check.id}`}>{check.name}</h2>
      {errors[check.id] && <p role="alert">{errors[check.id]}</p>}
      <p role="status" className={`status status-${check.status === "verified" && !errors[check.id] ? "completed" : "pending"}`}>
        {errors[check.id] ? "Previous result: " : ""}{labels[check.status]}
      </p>
      <p>{check.detail}</p>
      <p className="page-sub">Checked <time dateTime={check.checkedAt}>{check.checkedAt.replace("T", " ").slice(0,19)} UTC</time></p>
      <div className="workspace-actions">
        <button type="button" disabled={busy.includes(check.id)} onClick={() => void recheck(check.id)}>
          {busy.includes(check.id) ? "Checking…" : `Recheck ${check.name.toLowerCase()}`}
        </button>
        <a href={check.href}>{check.action}</a>
      </div>
    </section>)}
  </div>;
}
