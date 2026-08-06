import { redirect } from "next/navigation";

/**
 * `/` is the sessions list, until it is the overview.
 *
 * The list moved to `/sessions` so that the front door can become the monitor
 * W6 describes — big numbers, runs over time, anything wedged — without two
 * agents editing the same file, and so that `/sessions` and `/sessions/[id]`
 * are one route family rather than a list at the root with its detail pages
 * somewhere else.
 *
 * Temporary on purpose. `redirect()` answers 307; `permanentRedirect()` answers
 * 308, which browsers cache indefinitely — so the wave that gives `/` its own
 * page would find that visitors who came here once never reach it again. The
 * cost of 307 is one extra request per visit to the root, and it is the right
 * trade for a redirect whose whole point is that it is going away.
 */
export default function HomePage() {
  redirect("/sessions");
}
