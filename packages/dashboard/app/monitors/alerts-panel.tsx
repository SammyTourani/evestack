import { Badge, type Tone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FOCUS_RING } from "@/components/ui/style";
import { deliveryStatus, type DeliveryStatus } from "@/lib/alert-delivery";
import { evaluateAlerts, type AlertResult, type AlertState } from "@/lib/alerts";
import { ago } from "@/lib/time";

import { DeliveryTest } from "./delivery-test";

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

/**
 * Whether any of this leaves the machine — said on the page, every time.
 *
 * This is the honest half of the feature and the reason the panel changed at
 * all. Nine monitors rendered under the word "firing", with no statement about
 * delivery, invite exactly one conclusion: that someone will be told. Until
 * lib/alert-delivery.ts existed, nobody was, and the page gave a reader no way
 * to find that out short of reading the source.
 *
 * So the unconfigured case is not hidden, greyed out, or phrased as an upsell.
 * It is the same `warn` tone the panel already uses for `unknown`, and for the
 * same reason: "we are not watching for you" must not render like "all clear".
 */
function Delivery({ status }: { status: DeliveryStatus }) {
  if (!status.configured) {
    return (
      <p className="mt-1 mb-3 text-small text-warn">
        <strong className="font-normal">Nothing is delivered.</strong>{" "}
        {status.disabledReason} A monitor you have to be looking at is a chart with a threshold
        drawn on it.
      </p>
    );
  }

  const failing = status.failing.length > 0;

  return (
    <div className="mt-1 mb-3 flex flex-col gap-1.5">
      <p className="m-0 text-small text-text-dim">
        Delivering state changes to {status.sinks.join(", ")}, checked every{" "}
        {status.intervalSeconds}s.{" "}
        {status.renotifyMinutes === null
          ? "Only transitions are sent, so a monitor that stays firing is mentioned once."
          : `A monitor that stays firing is repeated every ${status.renotifyMinutes} minutes.`}{" "}
        {/*
          Three states, not two. "Nothing has been sent yet" used to cover a
          database that could not be read, which reads as all-clear on the one
          panel that must never do that — see DeliveryStatus.unreadable.
        */}
        {status.unreadable !== null
          ? null
          : status.lastDeliveryAt === null
            ? status.neverRun
              ? "Nothing has been delivered yet — the state tables are created by the first tick."
              : "Nothing has been sent yet."
            : `Last sent ${ago(status.lastDeliveryAt)}${status.lastDeliveryOk === false ? " and it failed" : ""}.`}
      </p>

      {status.unreadable !== null ? (
        <p className="m-0 text-small text-warn">
          <strong className="font-normal">Delivery state could not be read.</strong> The loop may
          be running and sending normally — this panel cannot tell you either way.{" "}
          {status.unreadable}
        </p>
      ) : null}

      {failing ? (
        <p className="m-0 text-small text-err">
          {status.failing.length} monitor{status.failing.length === 1 ? "" : "s"} could not be
          delivered and {status.failing.length === 1 ? "is" : "are"} being retried:{" "}
          {status.failing.map((f) => `${f.id} (${f.attempts}× — ${f.error})`).join("; ")}
        </p>
      ) : null}

      <DeliveryTest sinks={status.sinks} />
    </div>
  );
}

export async function AlertsPanel() {
  let alerts: AlertResult[];
  // Deliberately not in the same try: a delivery-status read that fails must not
  // be reported as "the monitor set could not be evaluated". deliveryStatus()
  // classifies its own errors into `neverRun` / `unreadable` rather than
  // throwing, so this cannot throw — but ordering it first would make a future
  // change able to.
  const status = await deliveryStatus();
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
      {/*
        No <h2>Monitors</h2> here. This panel renders on exactly one page, and
        that page's <h1> already says Monitors — so the card was repeating the
        title directly under it. The state summary is what the header is FOR, and
        it survives on its own line.
      */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="m-0 text-small text-text-dim">
          These are on out of the box rather than composed in a builder. Every one corresponds to a
          failure this codebase has actually hit, and four of them — sandbox isolation, sandbox
          lifetime, trace ingest and unpriced spend — cannot exist in a hosted product at all.
        </p>
      </div>
      <p className="mt-1 mb-1 text-small text-text-dim">
        {firing === 0 ? "Nothing firing" : `${firing} firing`}
        {unchecked > 0 ? `, ${unchecked} not checked` : null} · {alerts.length} shipped by default
      </p>

      <Delivery status={status} />
      <ul className="m-0 list-none p-0">
        {alerts.map((a) => (
          <AlertRow key={a.id} alert={a} />
        ))}
      </ul>
    </Card>
  );
}
