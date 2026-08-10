import { formatDuration } from "@/components/charts/lib/format";
import { bannerState, inspectFleet } from "@/lib/fleet";
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
 *
 * WHAT "FINE" MEANS GOT NARROWER, and that is the change worth reading. It used
 * to mean "no wedge, no park, no unreachable agent", which is not the same as
 * "there is nothing here I have not looked at" — and the difference is exactly
 * the state someone lands in a minute after their agent dies. The sweep skips a
 * session that moved in the last half hour, and calls one whose turn has been
 * open under an hour `active` rather than wedged; both are right, and both used
 * to render as an empty page next to a `Failure rate 0%` tile. A stranger
 * killed an agent mid-turn, read that page, and reported it as a broken health
 * check. It was not broken. It was silent about being silent.
 *
 * So there are now two registers here. The first three lines are FAULTS and
 * look like faults. The last two are COVERAGE — faint, last, and never coloured
 * — and they say what this sweep did not settle. A coverage line is not an
 * alarm and must never grow into one; it exists so that an empty banner means
 * "nothing is open" rather than "nothing was examined".
 *
 * The `unchecked` line is in the second group for a reason that predates this:
 * it could not render at all. It sat behind an early return that fired unless
 * something was already wrong, so the one sentence that says the sweep ran out
 * of budget was reachable only when the budget had already found a fault.
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

  // Every decision this component makes is in lib/fleet.ts, where a test can
  // reach it; see bannerState's header for why.
  const { counts, unjudged, register } = bannerState(report);
  if (register === "silent") return null;

  const { wedged, awaitingHuman, unknown } = counts;
  const stuck = report.entries.filter((entry) => entry.health === "wedged");
  const waiting = report.entries.filter((entry) => entry.health === "awaiting-human");
  const unreachable = report.entries.filter((entry) => entry.health === "unknown");

  // Three tones, not two. A box that only carries coverage lines must not
  // borrow the amber a parked session gets: "I have not looked at this yet" and
  // "someone needs to make a decision" are different asks, and colouring them
  // the same is how the amber stops meaning anything.
  const tone =
    register === "fault" ? styles.bad : register === "todo" ? styles.warn : styles.note;

  return (
    <div className={tone}>
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

      {unjudged > 0 && (
        <p className={`faint ${styles.line}`}>
          {unjudged} turn{unjudged === 1 ? " is" : "s are"} still open and not judged either way:
          nothing is called wedged until it has been open{" "}
          {formatDuration(report.wedgeAfterMs)}. This page is not saying{" "}
          {unjudged === 1 ? "it is" : "they are"} healthy.
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
