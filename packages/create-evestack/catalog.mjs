/**
 * The registry, read live where possible and from the embedded snapshot
 * otherwise.
 *
 * `catalog.data.mjs` holds the snapshot and explains why it exists; this file
 * is the part with behaviour: fetch, fall back, normalise, group, and order.
 */
import {
  FEATURED_CHANNELS, FEATURED_INTEGRATIONS, REGISTRY_URL, SNAPSHOT, SNAPSHOT_TAKEN,
} from "./catalog.data.mjs";
import { c, g } from "./ui.mjs";

export { SNAPSHOT_TAKEN, REGISTRY_URL };

/**
 * How long to wait for the registry before using the snapshot.
 *
 * Short on purpose. This runs between two questions, while someone is watching
 * a cursor, and the snapshot is a complete answer — so the live read is worth
 * two seconds and not worth ten. A scaffolder that pauses on a captive-portal
 * wifi is the same bug as one that pauses on a dead registry.
 */
const TIMEOUT_MS = 2000;

/**
 * The only shape of id this wizard will accept from the registry.
 *
 * An id is not a label. `create.mjs`'s `addOne` passes it to `eve add <id>` as
 * an argv element, and on Windows that spawn goes through cmd.exe — so the id
 * is, in the most literal sense, a fragment of a command line on somebody
 * else's machine. The only gate it had was `typeof item?.name === "string"`,
 * and `"channel/slack & calc"` is a string.
 *
 * That is worth stating plainly, because the shape of the hazard is unusual:
 * the id is never shown in the picker — the picker renders `title` — so a row
 * reading "Slack" could carry any id at all, and the person who ticked it would
 * have no way to see it. The registry is read live from eve.dev over the
 * network, which is one more party than the reader thinks they are trusting.
 *
 * create.mjs now escapes what it spawns (see `quoteForCmd` there), so this is
 * the second of two gates rather than the only one. It is still the right place
 * for the FIRST gate: an id that does not look like an id is not something this
 * wizard should be installing at all, escaped or not, and refusing it here
 * means every consumer downstream — the spawn, the `eve add <id>` recovery line
 * printed in the summary, the `--answer` round trip — gets a value with a known
 * shape instead of an arbitrary one.
 *
 * The pattern is eve's own naming convention, read off the 99 rows in
 * catalog.data.mjs: lowercase segments of `[a-z0-9._-]` separated by `/`, each
 * segment starting with a letter or digit. All 99 pass. A registry that starts
 * publishing something outside it loses that row from the wizard — a missing
 * item, which the reader can still install by hand with `eve add`, rather than
 * a shell fragment nobody can see.
 *
 * The length cap is belt and braces: the longest real id is 30 characters, and
 * nothing legitimate is anywhere near 128.
 */
const MAX_ID_LENGTH = 128;
const REGISTRY_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

/** Exported so the snapshot can be held to the same rule the live read is. */
export function isRegistryId(value) {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && REGISTRY_ID.test(value);
}

/** Which bucket a registry id belongs in. Prefix is the whole rule. */
function kindOf(id) {
  return id.startsWith("channel/") ? "channel" : "integration";
}

/**
 * Whether choosing this will ask for a credential.
 *
 * Structure first, prose second. Everything under `connection/` is by
 * definition a connection to somebody else's account — Notion, Linear, Vercel,
 * Browserbase — so it needs authenticating whether or not its one-line
 * description happens to say the word "token". Reading the description alone
 * flagged 7 of 99 items; the prefix rule brings that to the ~50 that genuinely
 * stop and ask, which is the difference between a useful warning and a
 * decorative one.
 *
 * Still conservative in the same direction: it only ever promotes an item from
 * "nothing extra" to "needs something", so the failure mode is a missing hint
 * rather than a wrong promise.
 */
function needsOf(id, description) {
  const text = String(description ?? "").toLowerCase();
  // "guided Connect setup" and "Vercel Connect" are the same requirement said
  // two ways, and the first spelling is the common one — GitHub's entry uses it.
  // Missing it meant the Review step promised a clean install and the installer
  // then stopped on `GitHub setup requires a linked Vercel project`, which is
  // exactly the surprise this field exists to prevent.
  if (/vercel connect|connect setup|guided connect|connector/.test(text)) return "connect";
  if (String(id).startsWith("connection/")) return "token";
  if (/token|credential|api key|\bbot\b|oauth|sign-?in/.test(text)) return "token";
  return "";
}

/**
 * Upstream's sentence with the phrase every row repeats taken out.
 *
 * Only the two ends, and only where the remainder is still a sentence. An
 * earlier version stripped leading "Add the built-in" too and turned
 * "Add the built-in Next.js Web Chat channel to an eve agent." into
 * "Next.js Web Chat channel to an eve agent." — a fragment with a dangling
 * clause. Trimming that reads worse than the boilerplate is not a trim.
 */
function trim(description) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  const shorter = text
    // The tail is pure repetition: every row in this list is about an eve agent.
    .replace(/\s+to an eve agent\.?$/i, ".")
    .replace(/^(Connect an eve agent to|Connect your agent to|Bring your agent into)\s+/i, "");
  return shorter ? shorter[0].toUpperCase() + shorter.slice(1) : shorter;
}

/**
 * Read the live registry, or return null.
 *
 * Never throws: every failure here — offline, DNS, a 500, a captive portal
 * serving HTML, a body that is not the shape expected — has the same correct
 * answer, which is "use the snapshot and say nothing". The wizard has a
 * complete catalogue either way, so an error message here would be noise about
 * a problem the reader does not have.
 */
export async function fetchRegistry(url = REGISTRY_URL, timeoutMs = TIMEOUT_MS) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = await response.json();
    const items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : null;
    if (!items || items.length === 0) return null;
    const rows = items
      // `isRegistryId`, not `typeof name === "string"`. See its docblock: the id
      // becomes an argv element in a spawn, and the picker shows the title, so a
      // row whose id is not an id is a row nobody can inspect before choosing it.
      .filter((item) => isRegistryId(item?.name) && typeof item?.title === "string")
      .map((item) => ({
        id: item.name,
        title: item.title,
        note: trim(item.description),
        kind: kindOf(item.name),
        needs: needsOf(item.name, item.description),
      }));
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Featured first in their stated order, then everything else by title.
 *
 * Alphabetical-by-title and not by id, because the id is a path
 * (`channel/chat-sdk-whatsapp`) and nobody scanning for WhatsApp is looking
 * under C.
 */
function order(rows, featured) {
  const rank = new Map(featured.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.title.localeCompare(b.title);
  });
}

/**
 * The catalogue the wizard renders, and where it came from.
 *
 * `source` is reported rather than hidden: "99 from the registry" and "99 from
 * a snapshot taken in September" are different facts, and the second one is
 * worth a dim line when a channel someone expects is missing.
 */
export async function loadCatalog({ offline = false } = {}) {
  const live = offline ? null : await fetchRegistry();
  // The snapshot omits `needs` when it is empty, to keep the embedded table
  // readable; the live read always sets it. Normalising here means every caller
  // sees one shape, rather than each one remembering that `undefined` and `""`
  // are the same answer from two sources.
  const rows = (live ?? SNAPSHOT).map((row) => ({ ...row, needs: row.needs ?? "" }));
  return {
    source: live ? "registry" : "snapshot",
    channels: order(rows.filter((r) => r.kind === "channel"), FEATURED_CHANNELS),
    integrations: order(rows.filter((r) => r.kind === "integration"), FEATURED_INTEGRATIONS),
  };
}

/**
 * The badge beside an item: what it will ask you for, if anything.
 *
 * DELIBERATELY NOT YELLOW. These were warning-yellow, and seeing it rendered
 * settled the argument: 52 of 99 items carry one, so a filtered list showed
 * three or four stacked yellow badges that pulled harder than the names beside
 * them. A list where half the rows look like warnings is a list with no
 * warnings in it.
 *
 * Needing a sign-in is a FACT about an item, in its own column, next to every
 * other item's fact. Yellow stays for the things that will actually cost you
 * something — a model that cannot call tools, a download too big for the
 * machine — and the Review step spells out the gated picks in words before
 * anything is installed, which is where the emphasis belongs.
 */
export function needsBadge(item) {
  if (item.needs === "connect") return { text: "sign-in", color: c.dim };
  if (item.needs === "token") return { text: "token", color: c.dim };
  return { text: "", color: c.dim };
}

/** A one-line summary of a chosen set, for the review step. */
export function summarise(items, max = 4) {
  if (items.length === 0) return c.dim("none");
  const names = items.map((i) => i.title);
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} ${c.dim(`+${names.length - max} more`)}`;
}

/** Everything in a chosen set that will stop and ask for something. */
export function gated(items) {
  return items.filter((item) => item.needs);
}

export const CATALOG_HINT = `Installed with ${c.bold("eve add")} ${g.sep} the same registry eve itself reads`;
