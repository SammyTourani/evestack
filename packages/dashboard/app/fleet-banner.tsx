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
          {waiting.slice(0, 3).map((entry, index) => (
            <span key={entry.sessionId}>
              {index > 0 && ", "}
              <a href={`/sessions/${encodeURIComponent(entry.sessionId)}`}>
                {entry.title?.slice(0, 40) ?? entry.sessionId.slice(-8)}
              </a>
            </span>
          ))}
          {waiting.length > 3 && ` and ${waiting.length - 3} more`}
        </p>
      )}

      {unknown > 0 && (
        <p className={styles.line}>
          {unknown} session{unknown === 1 ? " could" : "s could"} not be checked — the agent did not
          answer. {unreachable[0]?.reason}
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
