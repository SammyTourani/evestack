import type { ApproverIdentity } from "./approvals";
import { query } from "./db";
import {
  ensureMemoryAuditSchema,
  lockedMemory,
  memoryTransaction,
  MemoryConflictError,
} from "./memories";

export class MemoryReviewInputError extends Error {}

export const MEMORY_VERDICTS = [
  "reviewed",
  "stale",
  "conflicting",
  "correction_proposed",
] as const;
export interface MemoryReview {
  id: string;
  memoryId: string;
  memoryHash: string;
  verdict: (typeof MEMORY_VERDICTS)[number];
  note: string;
  proposedContent: string | null;
  actor: string | null;
  actorVia: string;
  createdAt: string;
}

function mapReview(row: Record<string, unknown>): MemoryReview {
  return {
    id: String(row.id),
    memoryId: String(row.memory_id),
    memoryHash: String(row.memory_hash),
    verdict: row.verdict as MemoryReview["verdict"],
    note: String(row.note),
    proposedContent:
      typeof row.proposed_content === "string" ? row.proposed_content : null,
    actor: typeof row.actor === "string" ? row.actor : null,
    actorVia: String(row.actor_via),
    createdAt: new Date(row.created_at as Date | string).toISOString(),
  };
}
const FIELDS =
  "id,memory_id,memory_hash,verdict,note,proposed_content,actor,actor_via,created_at";

export async function latestMemoryReviews(
  ids: string[],
): Promise<MemoryReview[]> {
  if (!ids.length) return [];
  await ensureMemoryAuditSchema();
  return (
    await query<Record<string, unknown>>(
      `SELECT DISTINCT ON(memory_id) ${FIELDS} FROM evestack.memory_reviews WHERE memory_id=ANY($1::text[]) ORDER BY memory_id,created_at DESC,id DESC`,
      [ids.slice(0, 500)],
    )
  ).map(mapReview);
}

export async function memoryReviewHistory(id: string): Promise<MemoryReview[]> {
  await ensureMemoryAuditSchema();
  return (
    await query<Record<string, unknown>>(
      `SELECT ${FIELDS} FROM evestack.memory_reviews WHERE memory_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,
      [String(BigInt(id))],
    )
  ).map(mapReview);
}

export async function reviewMemory(
  id: string,
  input: {
    hash: string;
    verdict: string;
    note: string;
    proposedContent?: string;
  },
  identity: ApproverIdentity,
) {
  if (
    !/^[a-f0-9]{64}$/.test(input.hash) ||
    !(MEMORY_VERDICTS as readonly string[]).includes(input.verdict)
  )
    throw new MemoryReviewInputError(
      "Choose a valid review and refresh the memory record.",
    );
  const note = input.note.trim();
  const proposed = input.proposedContent?.trim();
  if (note.length < 10 || note.length > 2000)
    throw new MemoryReviewInputError(
      "Give a review reason between 10 and 2,000 characters.",
    );
  if (
    input.verdict === "correction_proposed" &&
    (!proposed || proposed.length > 20_000)
  )
    throw new MemoryReviewInputError(
      "A correction proposal needs between 1 and 20,000 characters.",
    );
  if (input.verdict !== "correction_proposed" && proposed)
    throw new MemoryReviewInputError(
      "Choose Correction proposed to save replacement wording.",
    );
  await ensureMemoryAuditSchema();
  return memoryTransaction(async (client) => {
    const memory = await lockedMemory(client, id);
    if (!memory || memory.hash !== input.hash) throw new MemoryConflictError();
    if (memory.content.length > 20_000)
      throw new MemoryReviewInputError(
        "This memory exceeds the 20,000 character review limit. Review it with your database operator.",
      );
    const row = (
      await client.query(
        `INSERT INTO evestack.memory_reviews(memory_id,memory_hash,verdict,note,proposed_content,snapshot,actor,actor_via)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${FIELDS}`,
        [
          memory.id,
          memory.hash,
          input.verdict,
          note,
          proposed ?? null,
          JSON.stringify(memory),
          identity.approver,
          identity.via,
        ],
      )
    ).rows[0];
    return mapReview(row);
  });
}
