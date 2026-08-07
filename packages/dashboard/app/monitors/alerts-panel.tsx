import { Badge, type Tone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FOCUS_RING } from "@/components/ui/style";
import { evaluateAlerts, type AlertResult, type AlertState } from "@/lib/alerts";

/**
 * The alert list, above the charts.
 *
 * Above them on purpose: the charts answer "what is happening", this answers
 * "does anything need me", and a reader who has to derive the second from the
 * first has not been alerted, they have been given homework.
 *
 * ── `unknown` is drawn like a problem, not like a pass ───────────────────────
 *
 * Three states, and the middle one is the whole reason this is worth building
 * carefully. `unknown` means the question was not asked — the Docker socket is
 * not mounted, no budget is set, nothing ran in the window. It sorts above `ok`
 * and carries a visible tone, because a monitoring page that renders "we never
 * looked" the same as "we looked and it was fine" is worse than having no page:
 * it converts an absence of information into a false reassurance, and does it
 * on the screen someone checks precisely to avoid being surprised.
 */

const TONE: Record<AlertState, Tone> = { firing: "err", unknown: "warn", ok: "ok" };
const LABEL: Record<AlertState, string> = { firing: "firing", unknown: "not checked", ok: "ok" };

function AlertRow({ alert }: { alert: AlertResult }) {
  return (
    <li className="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge tone={TONE[alert.state]}>{LABEL[alert.state]}</Badge>
        <span className="text-body text-text">{alert.title}</span>
        {alert.severity === "page" && alert.state === "firing" ? (
          <span className="font-mono text-micro text-err">wake someone</span>
        ) : null}
        {alert.href === undefined ? null : (
          <a
            className={`ml-auto text-small text-accent hover:underline ${FOCUS_RING}`}
            href={alert.href}
          >
            look →
          </a>
        )}
      </div>
      <p className="m-0 text-small text-text-dim">{alert.detail}</p>
      {alert.threshold === undefined ? null : (
        <p className="m-0 font-mono text-micro text-text-faint">healthy: {alert.threshold}</p>
      )}
    </li>
  );
}

export async function AlertsPanel() {
  let alerts: AlertResult[];
  try {
    alerts = await evaluateAlerts();
  } catch (error) {
    return (
      <Card>
        <p className="m-0 text-small text-warn">
          The monitor set could not be evaluated: {error instanceof Error ? error.message : String(error)}
        </p>
      </Card>
    );
  }

  const firing = alerts.filter((a) => a.state === "firing").length;
  const unchecked = alerts.filter((a) => a.state === "unknown").length;

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-section font-medium text-text">Monitors</h2>
        <span className="text-small text-text-dim">
          {firing === 0 ? "Nothing firing" : `${firing} firing`}
          {unchecked > 0 ? `, ${unchecked} not checked` : null} · {alerts.length} shipped by default
        </span>
      </div>
      <p className="mt-1 mb-3 text-small text-text-dim">
        These are on out of the box rather than composed in a builder. Every one corresponds to a
        failure this codebase has actually hit, and four of them — sandbox isolation, sandbox
        lifetime, trace ingest and unpriced spend — cannot exist in a hosted product at all.
      </p>
      <ul className="m-0 list-none p-0">
        {alerts.map((a) => (
          <AlertRow key={a.id} alert={a} />
        ))}
      </ul>
    </Card>
  );
}
