import { inspectFleet, summarize } from "@/lib/fleet";
import styles from "./fleet-banner.module.css";

/**
 * "Is anything stuck?" answered above the session list.
 *
 * A separate page would be the tidier home for this and the wrong one: nobody
 * navigates to a health page to discover a problem they do not know they have.
 * It belongs where someone already looks.
 *
 * Renders NOTHING when everything is fine — no green "all clear" badge. A
 * banner that is always present is furniture, and furniture is invisible on the
 * day it finally says something.
 */
export async function FleetBanner() {
  let report: Awaited<ReturnType<typeof inspectFleet>>;
  try {
    report = await inspectFleet();
  } catch {
    // The session list is the point of this page; a failed health sweep must
    // not take it down. Silence is the right failure here — the banner is an
    // extra, and an error box about the extra would bury the actual content.
    return null;
  }

  const { wedged, awaitingHuman, unknown } = summarize(report);
  if (wedged === 0 && awaitingHuman === 0 && unknown === 0) return null;

  const stuck = report.entries.filter((entry) => entry.health === "wedged");
  const waiting = report.entries.filter((entry) => entry.health === "awaiting-human");
  const unreachable = report.entries.filter((entry) => entry.health === "unknown");

  return (
    <div className={wedged > 0 ? styles.bad : styles.warn}>
      {wedged > 0 && (
        <p className={styles.line}>
          <strong>
            {wedged} session{wedged === 1 ? "" : "s"} wedged.
          </strong>{" "}
          A turn started and never finished — nothing in eve will notice or retry it.{" "}
          {stuck.slice(0, 3).map((entry, index) => (
            <span key={entry.sessionId}>
              {index > 0 && ", "}
              <a href={`/sessions/${encodeURIComponent(entry.sessionId)}`}>
                {entry.title?.slice(0, 40) ?? entry.sessionId.slice(-8)}
              </a>
            </span>
          ))}
          {stuck.length > 3 && ` and ${stuck.length - 3} more`}
        </p>
      )}

      {awaitingHuman > 0 && (
        <p className={styles.line}>
          <strong>
            {awaitingHuman} session{awaitingHuman === 1 ? "" : "s"} waiting on a person.
          </strong>{" "}
          Parked on a decision nobody has made.{" "}
          {/*
            These link to /chat, not /sessions/<id>, and the difference is the
            whole point of the line.

            A wedged session needs forensics, so it goes to the detail page. A
            session awaiting a human needs an ANSWER, and /chat?session=<id> is
            the only surface in the dashboard that can give one — it attaches to
            a durable session it did not start and renders the pending
            `input.requested` with approve and deny.

            It had never been linked from anywhere. The banner announced "parked
            on a decision nobody has made" and sent the reader to a read-only
            page, so the one route from noticing to deciding was to know the
            query parameter existed and type it. /approvals does not close the
            loop either: it is the log of decisions already made.
          */}
          {waiting.slice(0, 3).map((entry, index) => (
            <span key={entry.sessionId}>
              {index > 0 && ", "}
              <a href={`/chat?session=${encodeURIComponent(entry.sessionId)}`}>
                {entry.title?.slice(0, 40) ?? entry.sessionId.slice(-8)}
              </a>
            </span>
          ))}
          {waiting.length > 3 && ` and ${waiting.length - 3} more`}
        </p>
      )}

      {unknown > 0 && (
        <p className={styles.line}>
          {/*
            The reason carries its own subject — lib/fleet.ts writes "the agent
            could not be reached (…)" — so the lead used to end "…the agent did
            not answer." and then say it again in lower case:

              8 sessions could not be checked — the agent did not answer. the
              agent could not be reached (Cannot reach the eve agent at …)

            The lead now stops at the count and hands over. Found by looking at
            a screenshot of this page rather than at this file.
          */}
          {unknown} session{unknown === 1 ? " could" : "s could"} not be checked:{" "}
          {unreachable[0]?.reason ?? "the agent did not answer."}
        </p>
      )}

      {report.unchecked > 0 && (
        <p className={`faint ${styles.line}`}>
          {report.unchecked} further idle session{report.unchecked === 1 ? " was" : "s were"} not
          checked; each check costs a round trip to the agent. Raise the bound with{" "}
          <code>/api/fleet?limit=</code>.
        </p>
      )}
    </div>
  );
}
