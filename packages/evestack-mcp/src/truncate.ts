/**
 * A cap on how much one tool result can put into a model's context.
 *
 * WHAT WAS WRONG. `toolResult` in server.ts serialised whatever a handler
 * returned — `JSON.stringify(structured, null, 2)` — and handed the whole thing
 * to the client. Every array in that payload comes from a route whose own LIMIT
 * is either large or absent, so the size of a tool result was a property of the
 * deployment's history rather than of anything this server decided.
 *
 * SIZES. Every figure below is printed by `node test/measure-output-sizes.mjs`,
 * which drives real `tools/call` requests through this server against a fake
 * dashboard applying each route's real LIMIT. Row CONTENTS are synthetic — there
 * is no production database in a test — so read these as representative, not as
 * a ceiling; that script documents exactly which interface each field came from.
 *
 *     list_sessions                                  1,489 B   ~0.4k tokens
 *     promote_session_to_eval (40-turn session)     15,592 B   ~3.9k
 *     get_session (one pending write_file approval) 39,861 B   ~10k
 *     get_costs (200 principals)                    81,942 B   ~20k
 *     list_approvals (no arguments — 200 rows)     113,289 B   ~28k
 *     list_approvals limit=500                     283,123 B   ~71k
 *     list_approvals sessionId, no limit (1000)    566,182 B   ~142k
 *
 * DO NOT re-derive the last row from "no limit". An earlier version of this
 * table claimed `list_approvals` with no limit returned 562,138 B, and that was
 * wrong about its own route: /api/approvals has defaulted the WHOLE-LOG arm to
 * 200 rows since the route was added (route.ts:33, and the same 200 in the
 * commit that introduced it). 1000 rows is reachable only through the session
 * arm, whose default is MAX_APPROVALS. The old number was a 1000-row
 * measurement wearing a 200-row label.
 *
 * WHY 64 KiB (~16k tokens) IS THE DEFAULT. The measured results fall into two
 * groups with a wide gap between them: the three that stay small on any
 * deployment top out at 39,861 B, and the four whose size is a function of how
 * much history the deployment has start at 81,942 B. 64 KiB is the only power of
 * two that lands in that gap — 32 KiB would cut `get_session`, and 128 KiB would
 * wave a 28k-token audit log through on a call with no arguments. 16k tokens is
 * also ~8% of a 200k window, which is about as much as a single observability
 * lookup can justify.
 *
 * WHAT IT DOES *NOT* DO. It never hands back a silently shortened result. The
 * payload stays valid JSON, `_truncated` is inserted as the FIRST key so a model
 * reading the text block top-down meets it before the data, and `cuts` names
 * every array and string that lost content along with how much. A truncated
 * result the caller mistakes for a complete one is worse than no cap at all:
 * "who approved this?" answered from a silently-clipped audit log reads as
 * "nobody did".
 */

export const MAX_OUTPUT_BYTES_ENV = "EVESTACK_MCP_MAX_OUTPUT_BYTES";

/** 64 KiB. See the size table above for why this number and not another. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Below this the notice itself stops fitting, and a cap that cannot explain
 * itself is the silent truncation this module exists to prevent. The minimal
 * notice-only fallback measures ~400 bytes, so 1 KiB leaves room for a couple of
 * `cuts` entries.
 */
export const MIN_MAX_OUTPUT_BYTES = 1024;

/** One array or string that lost content, named so the caller can go get the rest. */
export interface TruncationCut {
  /** Dotted path from the result root, e.g. `approvals` or `live.pendingRequests[0].action.input.contents`. */
  readonly path: string;
  readonly unit: "items" | "characters";
  readonly kept: number;
  readonly dropped: number;
}

export interface TruncationNotice {
  readonly reason: string;
  readonly limitBytes: number;
  readonly configuredBy: string;
  readonly originalBytes: number;
  readonly returnedBytes: number;
  readonly droppedBytes: number;
  readonly cuts: readonly TruncationCut[];
  /**
   * How many cuts happened that `cuts` does not list.
   *
   * Non-zero only on the floor path, where a result with hundreds of shrinkable
   * nodes produces a `cuts` list big enough to matter against the cap itself.
   * `cuts` is metadata describing the data, and metadata that crowds out the
   * data it describes is worse than an incomplete list — see
   * `assembleWithinBudget`.
   */
  readonly cutsOmitted: number;
}

export interface FittedResult {
  /** The payload to send, with `_truncated` prepended when anything was cut. */
  readonly payload: Record<string, unknown>;
  /** Exactly `JSON.stringify(payload, null, 2)`, so callers do not serialise twice. */
  readonly text: string;
  readonly truncated: boolean;
  /**
   * The same object as `payload._truncated`, typed, or null when nothing was
   * cut. Handed out separately so a caller that needs to know WHAT was cut —
   * promote_session_to_eval refuses rather than return a clipped eval, see
   * tools.ts — does not have to cast its way back out of `Record<string,
   * unknown>` and hope the shape is what it thinks.
   */
  readonly notice: TruncationNotice | null;
}

/**
 * The exact byte count `fitToolPayload` would measure this payload at.
 *
 * Exported so a handler can ask "would my result be cut?" using the same
 * serialisation the cap uses, rather than a second estimate that can disagree
 * with it.
 */
export function payloadBytes(payload: Record<string, unknown>): number {
  return byteLength(serialise(payload));
}

/**
 * UTF-8 bytes, not `String.length`. A JSON payload's real cost is bytes, and the
 * session ids, model names and reason strings in these results are ASCII while
 * user messages replayed by `promote_session_to_eval` are frequently not.
 */
const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** Pretty, because that is what server.ts already sends and what the cap must measure. */
const serialise = (value: unknown): string => JSON.stringify(value, null, 2) ?? "null";

/** Keep enough of a cut string that a human can tell what it was. */
const STRING_FLOOR = 160;

/** Keep at least one element, so the shape of the array survives the cut. */
const ARRAY_FLOOR = 1;

/**
 * Absolute ceiling on shrink passes, and NOT the number of passes a payload
 * gets — see `passBudget` below for that.
 *
 * WHAT WAS WRONG. This used to be a flat `MAX_PASSES = 32`, and falling out of
 * the loop landed on the notice-only payload. That made 32 a cliff: a result
 * with 33+ shrinkable nodes spent every pass driving one node to its floor,
 * never reached a fitting document, and came back as ~764 bytes with zero rows
 * — while the notice explained the collapse as "it has no array or string large
 * enough to shorten", which was not true. It had run out of passes. Reproduced
 * at a 64 KiB cap over N equal arrays of 40 rows: 33 arrays returned 65,406 B
 * and 221 rows, 40 arrays returned 764 B and 0 rows. Latent on today's payloads
 * (the biggest has five arrays), which is exactly why it would have been found
 * the hard way.
 *
 * Each pass either makes the document fit or drives one node to its floor and
 * retires it, so the passes a payload actually NEEDS is one per shrinkable node
 * plus one. The ceiling only bounds the cost of a pathological shape, and a
 * payload that hits it gets the floor batches below rather than the collapse.
 *
 * WHY 128 AND NOT MORE. A pass re-ranks the remaining candidates and ranking
 * serialises each one, so the search is quadratic in the candidate count.
 * Measured on N equal arrays of 20 rows at a 64 KiB cap, with this ceiling in
 * place: 32 arrays 26 ms / 342 rows kept, 64 arrays 112 ms / 316, 128 arrays
 * 465 ms / 264, 200 arrays 1.1 s / 200 (floor batches). Raising the ceiling to
 * 512 was measured too, and buys almost nothing: the 200-array case bisects to
 * 205 rows instead of 200 for 1.2 s, and a 512-array case spends 7.9 s reaching
 * the same answer it reaches in 3.2 s now. Past ~128 nodes the cap divides into
 * so many pieces that the largest prefix that fits IS nearly the floor, which is
 * what the floor batches produce without the search. 128 is where those cross.
 *
 * For scale, the shape this actually runs on — one 1000-row `list_approvals`
 * array — takes 8 ms.
 */
const MAX_PASSES = 128;

/**
 * How many floor batches to run once the pass ceiling is hit.
 *
 * Each batch floors every candidate that is not a descendant of one it just
 * floored, so a batch is one level of nesting and the loop ends when nothing is
 * left to floor. Eight is far past the depth of anything these routes return
 * (`live.pendingRequests[0].action.input.contents` is the deepest path in the
 * whole tool surface, at five).
 */
const MAX_FLOOR_BATCHES = 8;

/**
 * Headroom left for `returnedBytes` and `droppedBytes` settling to their final
 * digit counts after the search has picked a size. Two 7-digit numbers moving by
 * a digit each is a handful of bytes; 32 is comfortably more than that, and
 * spending 32 bytes of a 65,536-byte budget to guarantee the result never
 * exceeds the cap the operator configured is a trade worth making.
 */
const SETTLE_SLACK = 32;

interface Candidate {
  readonly path: string;
  readonly container: Record<string, unknown> | unknown[];
  readonly key: string | number;
  readonly value: unknown[] | string;
  /** Items for an array, characters for a string — the unit the search bisects. */
  readonly length: number;
  readonly bytes: number;
}

function collect(
  node: unknown,
  path: string,
  container: Record<string, unknown> | unknown[] | null,
  key: string | number | null,
  exhausted: ReadonlySet<string>,
  out: Candidate[],
): void {
  if (container !== null && key !== null && !exhausted.has(path)) {
    if (Array.isArray(node) && node.length > ARRAY_FLOOR) {
      // Only used to rank candidates against each other, so a standalone
      // serialisation is fine even though it understates the node's cost inside
      // the document (nested lines carry more indentation there). Ranking is all
      // this number decides — how much to actually cut is measured, not
      // estimated, by `shrinkToFit`.
      out.push({ path, container, key, value: node, length: node.length, bytes: byteLength(serialise(node)) });
    } else if (typeof node === "string" && node.length > STRING_FLOOR) {
      out.push({ path, container, key, value: node, length: node.length, bytes: byteLength(node) });
    }
  }

  if (Array.isArray(node)) {
    node.forEach((child, index) => collect(child, `${path}[${index}]`, node, index, exhausted, out));
  } else if (node && typeof node === "object") {
    for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
      collect(child, path === "" ? name : `${path}.${name}`, node as Record<string, unknown>, name, exhausted, out);
    }
  }
}

/**
 * Written into the string itself, not only into `cuts`.
 *
 * An array that lost its tail still looks like an array, so `cuts` naming the
 * path is enough. A string does not: a reply or a generated eval clipped
 * mid-sentence reads exactly like a short reply or a small file, and that is the
 * shape of mistake this whole module is here to stop.
 */
function marker(dropped: number): string {
  return `\n…[${dropped} characters dropped by ${MAX_OUTPUT_BYTES_ENV}; see _truncated]`;
}

/** Replace the node with its first `keep` items/characters. Never mutates the original. */
function applyKeep(candidate: Candidate, keep: number): { unit: "items" | "characters"; kept: number; dropped: number } {
  const target = candidate.container as Record<string | number, unknown>;
  if (Array.isArray(candidate.value)) {
    target[candidate.key] = candidate.value.slice(0, keep);
    return { unit: "items", kept: keep, dropped: candidate.length - keep };
  }
  const dropped = candidate.length - keep;
  target[candidate.key] = candidate.value.slice(0, keep) + (dropped > 0 ? marker(dropped) : "");
  return { unit: "characters", kept: keep, dropped };
}

/**
 * The three remedies are listed in that order on purpose, and the third is here
 * because the first two do not always exist. "Ask a narrower question" was once
 * the only advice this notice gave, which is useless to a caller of a tool whose
 * every argument is already as narrow as it goes — promote_session_to_eval takes
 * nothing but a sessionId. Raising the cap is the one remedy that is always
 * available to somebody, even when that somebody is the operator rather than the
 * model reading this.
 */
function reason(originalBytes: number, limitBytes: number): string {
  return (
    `This result was ${originalBytes} bytes and this server caps a tool result at ${limitBytes} ` +
    `(${MAX_OUTPUT_BYTES_ENV}), so the data below is INCOMPLETE. 'cuts' names every array and ` +
    `string that was shortened and by how much. Do not report a shortened list as the whole list — ` +
    `narrow the question where the tool takes one (list_approvals takes sessionId and limit), read ` +
    `the full result in the evestack dashboard, or ask whoever runs this server to raise ` +
    `${MAX_OUTPUT_BYTES_ENV}.`
  );
}

/**
 * Fit `payload` into `limitBytes` of pretty-printed JSON, truthfully.
 *
 * Pure by design — no config, no client, no I/O — because the interesting
 * property (that the returned text really is within the cap, and that the notice
 * really describes what left) is then testable without a dashboard, same as the
 * read-only gate.
 */
export function fitToolPayload(payload: Record<string, unknown>, limitBytes: number): FittedResult {
  const original = serialise(payload);
  const originalBytes = byteLength(original);
  if (originalBytes <= limitBytes) {
    return { payload, text: original, truncated: false, notice: null };
  }

  // A JSON round trip rather than structuredClone: it drops exactly what the
  // final stringify would drop (undefined values, functions), so the sizes
  // measured here are the sizes actually sent. Everything in a tool result is
  // already JSON-derived — these payloads come off `response.json()` — so there
  // is nothing here that cannot survive the trip.
  const working = JSON.parse(original) as Record<string, unknown>;

  const exhausted = new Set<string>();
  /** Keyed by path, so a node visited twice ends up with one entry, not two. */
  const cuts = new Map<string, TruncationCut>();
  /**
   * The length each node had before anything touched it.
   *
   * A second pass over the same path sees the already-shortened value, so
   * `dropped` computed from what that pass found would silently exclude what the
   * first pass took — the notice would under-report the loss, which is the one
   * kind of wrong this module must not be. `kept + dropped` is meant to equal the
   * length the dashboard actually returned, and this is what keeps it true.
   */
  const originalLengths = new Map<string, number>();

  /**
   * Record what a cut took, measured against the length the node had BEFORE any
   * pass touched it. See `originalLengths` above for why that matters.
   */
  const remember = (candidate: Candidate, applied: { unit: "items" | "characters"; kept: number }): void => {
    const trueLength = originalLengths.get(candidate.path) ?? candidate.length;
    originalLengths.set(candidate.path, trueLength);
    cuts.set(candidate.path, {
      path: candidate.path,
      unit: applied.unit,
      kept: applied.kept,
      dropped: trueLength - applied.kept,
    });
  };

  const candidatesIn = (): Candidate[] => {
    const found: Candidate[] = [];
    collect(working, "", null, null, exhausted, found);
    return found;
  };

  /**
   * The notice with no data under it. `cuts` is deliberately EMPTY here rather
   * than the list the passes built up: those entries say "kept N of M", and in
   * this payload nothing at all was kept. A cut list describing rows that are
   * not in the result is the same species of lie the notice exists to prevent.
   */
  const bare = (reasonText: string): FittedResult => {
    const built = assemble({}, reasonText, originalBytes, limitBytes, []);
    return { payload: built.payload, text: built.text, truncated: true, notice: built.notice };
  };

  const fitted = (built: {
    payload: Record<string, unknown>;
    text: string;
    notice: TruncationNotice;
  }): FittedResult => ({
    payload: built.payload,
    text: built.text,
    truncated: true,
    notice: built.notice,
  });

  // One pass per shrinkable node plus one is the exact worst case: a pass either
  // makes the document fit (and the next iteration returns it) or drives its
  // target to the floor and retires it, and the candidate set only ever shrinks.
  // So the budget is derived from the payload rather than fixed — a flat 32 was
  // a cliff for anything with 33 shrinkable nodes. MAX_PASSES is only the cost
  // ceiling for a shape nothing here produces.
  const passBudget = Math.min(MAX_PASSES, candidatesIn().length + 1);

  let ranOutOfPasses = false;
  for (let pass = 0; ; pass++) {
    const attempt = assemble(working, reason(originalBytes, limitBytes), originalBytes, limitBytes, [
      ...cuts.values(),
    ]);
    if (attempt.bytes <= limitBytes) return fitted(attempt);

    if (pass >= passBudget) {
      ranOutOfPasses = true;
      break;
    }

    const found = candidatesIn();
    found.sort((a, b) => b.bytes - a.bytes);
    const target = found[0];
    if (!target) break;

    const applied = shrinkToFit(target, working, originalBytes, limitBytes, cuts);
    remember(target, applied);
    // At the floor this node has nothing more to give. Without this the next
    // pass would pick the same still-largest node, find no further cut, and spin
    // out the pass budget instead of moving on to the second-largest.
    if (applied.kept <= (applied.unit === "items" ? ARRAY_FLOOR : STRING_FLOOR)) {
      exhausted.add(target.path);
    }
  }

  if (ranOutOfPasses) {
    // The pass ceiling is not a reason to hand back nothing. Cut every remaining
    // node straight to its floor — no bisection, so a batch costs one pass
    // instead of one per node — and see whether THAT fits. It keeps a row of
    // every list and 160 characters of every string, which is worth
    // immeasurably more than the empty notice this used to return.
    const flooredReason = exhaustedReason(originalBytes, limitBytes, passBudget);
    for (let batch = 0; batch < MAX_FLOOR_BATCHES; batch++) {
      const attempt = assembleWithinBudget(working, flooredReason, originalBytes, limitBytes, [
        ...cuts.values(),
      ]);
      if (attempt !== null) return fitted(attempt);

      const found = candidatesIn();
      if (found.length === 0) break;
      // Shallowest first, skipping anything nested inside a node this batch has
      // already floored: flooring a parent array to one element deletes its
      // other elements outright, and a `cuts` entry claiming "kept 160 of 40000"
      // for a string inside a deleted element would describe content that is not
      // in the payload at all. Those descendants come back in the next batch,
      // still reachable, and get floored then.
      found.sort((a, b) => depth(a.path) - depth(b.path));
      const flooredHere: string[] = [];
      const nestedInAFlooredNode = (path: string): boolean =>
        flooredHere.some((parent) => path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`));
      for (const candidate of found) {
        if (nestedInAFlooredNode(candidate.path)) continue;
        remember(candidate, applyKeep(candidate, Array.isArray(candidate.value) ? ARRAY_FLOOR : STRING_FLOOR));
        exhausted.add(candidate.path);
        flooredHere.push(candidate.path);
      }
    }
  }

  // Nothing left to give. Answering with the notice alone is the only honest
  // option left — returning it over-cap anyway would make the cap a suggestion,
  // and clipping the text would hand back invalid JSON, which is the silent
  // corruption this module exists to prevent. The two ways of getting here are
  // different facts about the result and are reported as different sentences:
  // one is a payload of nothing but short scalars, the other is a payload whose
  // arrays and strings were all cut to the floor and STILL did not fit. Saying
  // the first when the second is true is what the old flat pass limit did.
  const nothingToCut = cuts.size === 0;
  return bare(
    reason(originalBytes, limitBytes) +
      (nothingToCut
        ? ` NOTHING of the result fit: it has no array or string large enough to shorten. Raise ` +
          `${MAX_OUTPUT_BYTES_ENV} to at least ${originalBytes} to see it.`
        : ` NOTHING of the result fit: even with every array cut to ${ARRAY_FLOOR} element and every ` +
          `string to ${STRING_FLOOR} characters it is still over the cap. Raise ` +
          `${MAX_OUTPUT_BYTES_ENV} to at least ${originalBytes} to see it whole.`),
  );
}

/**
 * Assemble the floored document, dropping `cuts` ENTRIES rather than data if
 * the two together will not fit. Returns null only if even the bare document
 * with no cuts listed is over the cap.
 *
 * WHAT WAS WRONG. The floor path assembled with the complete `cuts` list and
 * gave up if that did not fit — so a payload with hundreds of shrinkable nodes
 * produced hundreds of `cuts` entries, and the LIST outgrew the budget it was
 * describing. Measured at a 64 KiB cap over 200 arrays of 20 heavy rows:
 *
 *     returned 842 bytes, 0 rows, 0 cuts
 *     fully-floored data alone: 58,782 bytes   — fits, comfortably
 *
 * and the notice explained it as "even with every array cut to 1 element and
 * every string to 160 characters it is still over the cap", which was false.
 * The data fit. The metadata added to explain the cut is what starved the
 * answer — the same class of defect as the pass cliff above, one step further
 * along.
 *
 * A caller can act on one row of real data; it can do nothing with the 200th
 * entry of a list of paths. So the cuts list is what yields.
 */
function assembleWithinBudget(
  working: Record<string, unknown>,
  reasonText: string,
  originalBytes: number,
  limitBytes: number,
  allCuts: readonly TruncationCut[],
): { payload: Record<string, unknown>; text: string; bytes: number; notice: TruncationNotice } | null {
  // Full list first, so a result that can afford the complete accounting still
  // gets it. Then progressively fewer, shallowest paths kept — those name whole
  // top-level collections and are the ones worth reading.
  for (const keep of [allCuts.length, 64, 16, 4, 0]) {
    if (keep > allCuts.length) continue;
    const kept = keep === allCuts.length ? allCuts : [...allCuts].sort((a, b) => depth(a.path) - depth(b.path)).slice(0, keep);
    const attempt = assemble(working, reasonText, originalBytes, limitBytes, kept, allCuts.length - kept.length);
    if (attempt.bytes <= limitBytes) return attempt;
  }
  return null;
}

/** Nesting depth of a `cuts` path: `live.pendingRequests[0].action` is 3. */
function depth(path: string): number {
  return (path.match(/[.[]/g) ?? []).length;
}

/**
 * Said only when the pass ceiling stopped the search, and it says exactly that.
 *
 * The distinction is the whole point: a result cut this way lost more than the
 * cap required, because every node went to its floor instead of to the largest
 * prefix that fits. A caller told "this is what fits" would reasonably conclude
 * the data is simply that big. It is not.
 */
function exhaustedReason(originalBytes: number, limitBytes: number, passBudget: number): string {
  return (
    reason(originalBytes, limitBytes) +
    ` This result had more shrinkable arrays and strings than the ${passBudget}-pass search budget, so ` +
    `every one of them was cut to its floor rather than to the largest prefix that fits: MORE was ` +
    `dropped than the cap strictly required. Raise ${MAX_OUTPUT_BYTES_ENV} for a fuller answer.`
  );
}

/**
 * Bisect for the LARGEST prefix of this node that still fits, and apply it.
 *
 * WHY A SEARCH AND NOT ARITHMETIC. The obvious version divides the node's byte
 * size by its element count and drops `overage / perItem` elements. It was
 * written that way first and it over-cut badly. The estimate is biased low
 * because a node serialised on its own carries less indentation than the same
 * node nested inside the result, so `perItem` is understated and
 * `overage / perItem` is overstated — and nothing about that bias is bounded.
 * Under-filling the cap is not a safe direction to be wrong in: the whole cost
 * of truncation is the rows the caller does not get.
 *
 * What the search returns IS measured, and pinned. On `{approvals: <1000 rows>}`
 * — the payload "it cuts as little as it can get away with" uses in
 * truncate.test.mjs — it fills 7,979 B of an 8,192 cap, 32,733 B of 32,768 and
 * 65,458 B of 65,536; that test fails below 90%. (The figures the arithmetic
 * version produced are not quoted here: that code is gone, so nobody can re-run
 * them, and a number in a comment that cannot be reproduced is the thing this
 * package has spent an audit removing.)
 *
 * ~10 extra serialisations of a shrinking document buys an exact answer, which
 * at these sizes is well under a millisecond and invisible next to the HTTP
 * round trip the result just came from.
 */
function shrinkToFit(
  candidate: Candidate,
  working: Record<string, unknown>,
  originalBytes: number,
  limitBytes: number,
  cuts: Map<string, TruncationCut>,
): { unit: "items" | "characters"; kept: number; dropped: number } {
  const floor = Array.isArray(candidate.value) ? ARRAY_FLOOR : STRING_FLOOR;
  const budget = limitBytes - SETTLE_SLACK;

  const fits = (keep: number): boolean => {
    const applied = applyKeep(candidate, keep);
    // The trial cut has to be in the notice while it is measured, or the search
    // sizes a document whose `cuts` list is one entry shorter than the one that
    // actually ships.
    cuts.set(candidate.path, { path: candidate.path, ...applied });
    return draft(working, reason(originalBytes, limitBytes), originalBytes, limitBytes, [...cuts.values()]) <= budget;
  };

  // If the floor itself does not fit, no prefix does, and the bisection below
  // would spend ~log2(n) serialisations of the whole document proving it. This
  // is the common case once a payload has several huge nodes — every pass but
  // the last one ends here — so skipping it is what keeps the pass budget in
  // MAX_PASSES affordable rather than theoretical.
  if (!fits(floor)) return applyKeep(candidate, floor);

  let lo = floor;
  let hi = candidate.length - 1;
  let best = floor;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return applyKeep(candidate, best);
}

/**
 * One serialisation, for measurement only.
 *
 * `returnedBytes` is filled with `limitBytes` rather than the truth because the
 * truth is what is being measured. It is the right magnitude, so the digit count
 * — the only way that field's value affects the length — is right or off by one,
 * which is what SETTLE_SLACK covers.
 */
function draft(
  working: Record<string, unknown>,
  reasonText: string,
  originalBytes: number,
  limitBytes: number,
  cuts: readonly TruncationCut[],
): number {
  const notice: TruncationNotice = {
    cutsOmitted: 0,
    reason: reasonText,
    limitBytes,
    configuredBy: MAX_OUTPUT_BYTES_ENV,
    originalBytes,
    returnedBytes: limitBytes,
    droppedBytes: Math.max(0, originalBytes - limitBytes),
    cuts,
  };
  return byteLength(serialise({ _truncated: notice, ...working }));
}

/**
 * Build the notice + payload and measure it.
 *
 * `returnedBytes` is self-referential — writing it into the object changes the
 * object's size — so it is resolved by iterating to a fixed point rather than
 * estimated. Two rounds is the normal case (the first fills in the digits, the
 * second confirms they did not change the length again); the loop bound only
 * exists so a value oscillating across a digit boundary settles rather than
 * spinning. The caller re-checks the returned `bytes` against the cap either
 * way, so a notice that lands a digit off can never let an over-cap result out.
 */
function assemble(
  working: Record<string, unknown>,
  reasonText: string,
  originalBytes: number,
  limitBytes: number,
  cuts: readonly TruncationCut[],
  cutsOmitted = 0,
): { payload: Record<string, unknown>; text: string; bytes: number; notice: TruncationNotice } {
  let returnedBytes = 0;
  let text = "";
  let payload: Record<string, unknown> = {};
  let notice: TruncationNotice = {
    reason: reasonText,
    limitBytes,
    configuredBy: MAX_OUTPUT_BYTES_ENV,
    originalBytes,
    returnedBytes,
    droppedBytes: Math.max(0, originalBytes - returnedBytes),
    cuts,
    cutsOmitted,
  };
  for (let round = 0; round < 4; round++) {
    notice = {
      reason: reasonText,
      limitBytes,
      configuredBy: MAX_OUTPUT_BYTES_ENV,
      originalBytes,
      returnedBytes,
      droppedBytes: Math.max(0, originalBytes - returnedBytes),
      cuts,
      cutsOmitted,
    };
    // `_truncated` first: JSON.stringify preserves insertion order, so a model
    // reading the text block from the top meets the warning before it reads a
    // single row of the partial data underneath it.
    payload = { _truncated: notice, ...working };
    text = serialise(payload);
    const measured = byteLength(text);
    if (measured === returnedBytes) break;
    returnedBytes = measured;
  }

  // The notice handed back is the one INSIDE `payload`, by identity, so a caller
  // reading `fitted.notice` and a model reading `_truncated` can never be told
  // two different stories.
  return { payload, text, bytes: byteLength(text), notice };
}
