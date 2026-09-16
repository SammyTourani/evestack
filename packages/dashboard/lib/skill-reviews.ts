import { getPool } from "./db";
import type { ApproverIdentity } from "./approvals";
import type { SkillFileFingerprint } from "./skill-fingerprint";

let ready: Promise<void> | null = null;
async function ensureReviews() {
  if (!ready)
    ready = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(7141503)");
        await client.query(`CREATE SCHEMA IF NOT EXISTS evestack;
        CREATE TABLE IF NOT EXISTS evestack.skill_reviews (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          name text NOT NULL, source_hash text NOT NULL, content_hash text NOT NULL,
          verdict text NOT NULL CHECK(verdict IN ('reviewed','needs_changes')), note text NOT NULL,
          actor text, actor_via text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS skill_review_source ON evestack.skill_reviews(name,source_hash,id DESC);
        ALTER TABLE evestack.skill_reviews ADD COLUMN IF NOT EXISTS file_manifest jsonb`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      ready = null;
      throw error;
    });
  return ready;
}
export async function readSkillReview(name: string, source: string) {
  await ensureReviews();
  return (
    (
      await getPool().query(
        "SELECT content_hash,verdict,note,actor,actor_via,created_at,file_manifest FROM evestack.skill_reviews WHERE name=$1 AND source_hash=$2 ORDER BY id DESC LIMIT 1",
        [name, source],
      )
    ).rows[0] ?? null
  );
}
export async function recordSkillReview(
  name: string,
  source: string,
  hash: string,
  verdict: string,
  note: string,
  identity: ApproverIdentity,
  manifest?: SkillFileFingerprint[],
) {
  await ensureReviews();
  await getPool().query(
    "INSERT INTO evestack.skill_reviews(name,source_hash,content_hash,verdict,note,actor,actor_via,file_manifest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      name,
      source,
      hash,
      verdict,
      note,
      identity.approver,
      identity.via,
      manifest ? JSON.stringify(manifest) : null,
    ],
  );
}
